import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Server, request } from 'node:http';

test('/remote pair configures private Serve before displaying a QR and never overwrites another route', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pocket-auto-pair-'));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  const configFile = join(dir, 'serve.json');
  const logFile = join(dir, 'calls');
  await writeFile(configFile, '{}');
  await writeFile(join(bin, 'tailscale'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(process.env.FAKE_LOG, args + '\\n');
if (args === 'status --json') process.stdout.write(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'laptop.test.ts.net.' } }));
else if (args === 'serve status --json') process.stdout.write(fs.readFileSync(process.env.FAKE_CONFIG));
else if (args === 'serve --bg --https=443 http://127.0.0.1:18789') fs.writeFileSync(process.env.FAKE_CONFIG, JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'laptop.test.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18789' } } } } }));
else process.exit(2);
`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_LOG = logFile;
  process.env.FAKE_CONFIG = configFile;
  process.env.PI_CODING_AGENT_DIR = join(dir, 'state');
  const { default: extension } = await import('../extensions/pocket/index.ts');
  const events = {}, commands = {}, notices = [];
  let url, localUrl, code, displays = 0;
  const ctx = { cwd: dir, sessionManager: { getBranch: () => [] }, isIdle: () => true, abort() {}, ui: {
    notify(message) { notices.push(message); if (message.startsWith('Pi Aevin: http')) url = message.slice('Pi Aevin: '.length); },
    custom: async factory => { displays++; code = factory({}, { fg: (_color, text) => text }, {}, () => {}).render(200).find(line => line.startsWith('Code: ')).slice(6); },
  } };
  extension({ on: (name, fn) => events[name] = fn, registerCommand: (name, command) => commands[name] = command, registerEntryRenderer() {}, appendEntry() {}, sendUserMessage() {} });
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (port, host, callback) { return listen.call(this, 0, host, () => { if (port === 18790) localUrl = `http://127.0.0.1:${this.address().port}`; callback(); }); };
  await events.session_start({}, ctx);
  try {
    assert.equal(url, undefined);
    await commands.remote.handler('pair', ctx);
    Server.prototype.listen = listen;
    assert.equal(displays, 1);
    assert.equal((await fetch(localUrl + '/api/session')).status, 503);
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(await readFile(join(dir, 'state/pi-pocket/tailscale-origin'), 'utf8'), 'https://laptop.test.ts.net');
    const pair = await new Promise((resolve, reject) => {
      const req = request(url + '/api/pair', { method: 'POST', headers: { host: 'laptop.test.ts.net', origin: 'https://laptop.test.ts.net', 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end(JSON.stringify({ code }));
    });
    assert.equal(pair, 200);
    await commands.remote.handler('pair', ctx);
    assert.equal(displays, 2);
    let calls = (await readFile(logFile, 'utf8')).trim().split('\n');
    assert.equal(calls.filter(line => line.startsWith('serve --bg')).length, 1);
    const other = { TCP: { '443': { HTTPS: true } }, Web: { 'laptop.test.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };
    await writeFile(configFile, JSON.stringify(other));
    await commands.remote.handler('pair', ctx);
    assert.equal(displays, 2);
    assert.match(notices.at(-1), /another route or Funnel/);
    await assert.rejects(fetch(url + '/api/session'));
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), other);
    calls = (await readFile(logFile, 'utf8')).trim().split('\n');
    assert.equal(calls.filter(line => line.startsWith('serve --bg')).length, 1);
    await events.session_shutdown();
    await commands.remote.handler('pair', ctx);
    assert.match(notices.at(-1), /not available/);
    assert.equal(await readFile(logFile, 'utf8'), calls.join('\n') + '\n');
  } finally { Server.prototype.listen = listen; await events.session_shutdown(); await rm(dir, { recursive: true, force: true }); }
});
