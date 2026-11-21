import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Server, request } from 'node:http';

test('disconnects only an exclusive Pi Pocket Serve route and leaves Pi running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pocket-serve-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const statusFile = join(dir, 'status.json');
  const logFile = join(dir, 'calls');
  await writeFile(join(bin, 'tailscale'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(process.env.FAKE_LOG, args + '\\n');
if (args === 'serve status --json') process.stdout.write(fs.readFileSync(process.env.FAKE_STATUS));
else if (args === 'serve --https=443 off') { if (process.env.FAKE_FAIL === '1') process.exit(1); }
else process.exit(2);
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_LOG = logFile;
  process.env.FAKE_STATUS = statusFile;
  process.env.PI_CODING_AGENT_DIR = join(dir, 'state');
  const { default: extension } = await import('../extensions/pocket/index.ts');
  const events = {}, commands = {};
  let url, code, aborts = 0;
  const ctx = { cwd: dir, sessionManager: { getBranch: () => [] }, isIdle: () => true, abort: () => aborts++, ui: { notify(message) {
    if (message.startsWith('Pi Remote: http')) url = message.slice('Pi Remote: '.length);
  }, custom: async factory => { code = factory({}, { fg: (_color, text) => text }, {}, () => {}).render(200).find(line => line.startsWith('Code: ')).slice(6); } } };
  extension({ on: (name, handler) => events[name] = handler, registerCommand: (name, command) => commands[name] = command, registerEntryRenderer() {}, appendEntry() {}, sendUserMessage() {} });
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (_port, host, callback) { return listen.call(this, 0, host, callback); };
  try {
    await events.session_start({}, ctx);
  } finally { Server.prototype.listen = listen; }
  try {
    await commands.remote.handler('pair', ctx);
    const paired = await fetch(url + '/api/pair', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const cookie = paired.headers.get('set-cookie').split(';')[0];
    await commands.remote.handler('share laptop.test.ts.net', ctx);
    const post = (headers = {}) => fetch(url + '/api/disconnect-tailscale', { method: 'POST', headers: { cookie, origin: url, 'content-type': 'application/json', ...headers } });
    const config = { TCP: { '443': { HTTPS: true } }, Web: { 'laptop.test.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18789' } } } } };
    await writeFile(statusFile, JSON.stringify(config));
    assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ cookie: 'pi-pocket-local=wrong' })).status, 401);
    config.Web['laptop.test.ts.net:443'].Handlers['/other'] = { Proxy: 'http://127.0.0.1:3000' };
    await writeFile(statusFile, JSON.stringify(config));
    assert.equal((await post()).status, 409);
    delete config.Web['laptop.test.ts.net:443'].Handlers['/other'];
    config.Web['laptop.test.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:3000';
    await writeFile(statusFile, JSON.stringify(config));
    assert.equal((await post()).status, 409);
    config.Web['laptop.test.ts.net:443'].Handlers['/'].Proxy = 'http://127.0.0.1:18789';
    config.AllowFunnel = { 'laptop.test.ts.net:443': true };
    await writeFile(statusFile, JSON.stringify(config));
    assert.equal((await post()).status, 409);
    delete config.AllowFunnel;
    await writeFile(statusFile, JSON.stringify(config));
    process.env.FAKE_FAIL = '1';
    assert.equal((await post()).status, 500);
    delete process.env.FAKE_FAIL;
    assert.equal((await post()).status, 200);
    assert.equal(aborts, 0);
    assert.equal((await fetch(url + '/api/session', { headers: { cookie } })).status, 200);
    const remoteStatus = await new Promise((resolve, reject) => {
      const req = request(url + '/api/session', { headers: { cookie, host: 'laptop.test.ts.net' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(remoteStatus, 403);
    await assert.rejects(readFile(join(dir, 'state/pi-pocket/tailscale-origin')), { code: 'ENOENT' });
    const calls = (await readFile(logFile, 'utf8')).trim().split('\n');
    assert.equal(calls.filter(line => line === 'serve --https=443 off').length, 2);
  } finally {
    await events.session_shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});
