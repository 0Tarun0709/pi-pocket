import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Server, request } from 'node:http';
test('pairing endpoint requires the right origin, sets a secure cookie and supports revocation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pocket-pair-http-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  const { default: extension } = await import('../extensions/pocket/index.ts');
  const events = {}, commands = {};
  let url, code;
  const ctx = { cwd: dir, sessionManager: { getBranch: () => [] }, isIdle: () => true, abort() {}, ui: {
    notify(message) { if (message.startsWith('Pi Remote: http')) url = message.slice('Pi Remote: '.length); },
    custom: async factory => { code = factory({}, { fg: (_color, text) => text }, {}, () => {}).render(200).find(line => line.startsWith('Code: ')).slice(6); },
    select: async (_title, options) => options[0], confirm: async () => true,
  } };
  extension({ on: (name, fn) => events[name] = fn, registerCommand: (name, command) => commands[name] = command, registerEntryRenderer() {}, appendEntry() {}, sendUserMessage() {} });
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (_port, host, callback) { return listen.call(this, 0, host, callback); };
  try { await events.session_start({}, ctx); } finally { Server.prototype.listen = listen; }
  try {
    await commands.remote.handler('share laptop.test.ts.net', ctx);
    await commands.remote.handler('pair', ctx);
    const raw = (path, headers, body) => new Promise((resolve, reject) => {
      const req = request(url + path, { method: body === undefined ? 'GET' : 'POST', headers }, res => { res.resume(); resolve({ status: res.statusCode, headers: res.headers }); });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const base = { host: 'laptop.test.ts.net', 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone)' };
    assert.equal((await raw('/api/pair', { ...base, origin: 'https://evil.example' }, { code })).status, 403);
    assert.equal((await raw('/api/pair', { ...base, origin: 'https://laptop.test.ts.net' }, { code: 'wrong' })).status, 401);
    const paired = await raw('/api/pair', { ...base, origin: 'https://laptop.test.ts.net' }, { code });
    assert.equal(paired.status, 200);
    const setCookie = paired.headers['set-cookie'][0];
    assert.match(setCookie, /^__Host-pi-pocket=/);
    assert.match(setCookie, /; HttpOnly; SameSite=Strict; Max-Age=31536000; Secure$/);
    const cookie = setCookie.split(';')[0];
    assert.equal((await raw('/api/pair', { ...base, origin: 'https://laptop.test.ts.net' }, { code })).status, 401);
    assert.equal((await raw('/api/session', { host: base.host, cookie })).status, 200);
    await commands.remote.handler('devices', ctx);
    assert.equal((await raw('/api/session', { host: base.host, cookie })).status, 401);
  } finally { await events.session_shutdown(); await rm(dir, { recursive: true, force: true }); }
});
