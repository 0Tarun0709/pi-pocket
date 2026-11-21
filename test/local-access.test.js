import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Server, createServer, request } from 'node:http';

test('local browser needs no pairing, while the existing Tailscale port remains protected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pocket-local-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  const { default: extension } = await import('../extensions/pocket/index.ts');
  const events = {}, commands = {};
  let localUrl, remoteUrl, remoteReserved, aborts = 0, binds = 0;
  const ctx = { cwd: dir, sessionManager: { getBranch: () => [] }, isIdle: () => false, abort: () => aborts++, ui: { notify(message) {
    if (message.startsWith('Pi Pocket local: http')) localUrl = message.slice('Pi Pocket local: '.length);
    if (message.startsWith('Pi Remote: http')) remoteUrl = message.slice('Pi Remote: '.length);
  }, custom: async () => {} } };
  extension({ on: (name, fn) => events[name] = fn, registerCommand: (name, command) => commands[name] = command, registerEntryRenderer() {}, appendEntry() {}, sendUserMessage() {} });
  const original = Server.prototype.listen;
  Server.prototype.listen = function (port, host, callback) { binds++; return original.call(this, 0, host, () => { if (port === 18789) remoteReserved = `http://127.0.0.1:${this.address().port}`; callback(); }); };
  try {
    await events.session_start({}, ctx);
    assert.equal(binds, 0);
    assert.equal(localUrl, undefined);
    assert.equal(remoteUrl, undefined);
    await commands.remote.handler('', ctx);
    assert.ok(localUrl);
    assert.equal(remoteUrl, undefined);
    assert.equal((await fetch(remoteReserved + '/api/session')).status, 503);
    await commands.remote.handler('pair local', ctx);
    assert.ok(remoteUrl);
    const page = await fetch(localUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="composer"/);
    const session = await fetch(localUrl + '/api/session');
    assert.equal(session.status, 200);
    assert.equal((await session.json()).local, true);
    assert.equal((await fetch(remoteUrl + '/api/session')).status, 401);
    const spoofed = await new Promise((resolve, reject) => {
      const req = request(remoteUrl + '/api/session', { headers: { host: new URL(localUrl).host, 'x-forwarded-host': new URL(localUrl).host } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(spoofed, 403);
    const remoteAsLocal = await fetch(remoteUrl + '/api/session', { headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': new URL(localUrl).host } });
    assert.equal(remoteAsLocal.status, 401);
    const post = (path, origin) => fetch(localUrl + path, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'local prompt' }) });
    assert.equal((await post('/api/prompt', 'https://evil.example')).status, 403);
    assert.equal((await post('/api/prompt', localUrl)).status, 202);
    assert.equal((await post('/api/stop-all', localUrl)).status, 200);
    assert.equal(aborts, 1);
    await assert.rejects(fetch(localUrl));
    await assert.rejects(fetch(remoteUrl));
    await commands.remote.handler('enable', ctx);
    await assert.rejects(fetch(localUrl));
    await assert.rejects(fetch(remoteUrl));
    await commands.remote.handler('', ctx);
    assert.equal((await fetch(localUrl + '/api/session')).status, 200);
    assert.equal((await fetch(remoteReserved + '/api/session')).status, 503);
    await commands.remote.handler('pair local', ctx);
    assert.equal((await fetch(remoteUrl + '/api/session')).status, 401);
  } finally {
    Server.prototype.listen = original;
    await events.session_shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('another session cannot bypass an all-stop made after it started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pocket-multi-'));
  const bin = join(dir, 'bin'), called = join(dir, 'called');
  await mkdir(bin);
  await writeFile(join(bin, 'tailscale'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(called)}, 'called'); process.exit(1);\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.PI_CODING_AGENT_DIR = dir;
  const { default: extension } = await import('../extensions/pocket/index.ts?multi-session');
  const first = { events: {}, commands: {} }, second = { events: {}, commands: {} }, notices = [];
  let localUrl;
  const make = target => extension({ on: (name, fn) => target.events[name] = fn, registerCommand: (name, command) => target.commands[name] = command, registerEntryRenderer() {}, appendEntry() {}, sendUserMessage() {} });
  make(first); make(second);
  const ctx = { cwd: dir, sessionManager: { getBranch: () => [] }, isIdle: () => false, abort() {}, ui: { notify(message) {
    notices.push(message);
    if (message.startsWith('Pi Pocket local: http')) localUrl = message.slice('Pi Pocket local: '.length);
  } } };
  const ports = {};
  const original = Server.prototype.listen;
  Server.prototype.listen = function (port, host, callback) { return original.call(this, ports[port] || 0, host, () => { ports[port] = this.address().port; callback(); }); };
  try {
    await first.events.session_start({}, ctx);
    await second.events.session_start({}, ctx);
    await first.commands.remote.handler('', ctx);
    assert.ok(localUrl);
    await second.commands.remote.handler('', ctx);
    assert.match(notices.at(-1), /EADDRINUSE/);
    await second.commands.remote.handler('pair', ctx);
    assert.match(notices.at(-1), /EADDRINUSE/);
    await assert.rejects(readFile(called), { code: 'ENOENT' });
    const response = await fetch(localUrl + '/api/stop-all', { method: 'POST', headers: { origin: localUrl, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    await second.commands.remote.handler('', ctx);
    assert.match(notices.at(-1), /disabled/);
    await second.commands.remote.handler('pair', ctx);
    assert.match(notices.at(-1), /disabled/);
    await assert.rejects(readFile(called), { code: 'ENOENT' });
    await assert.rejects(fetch(localUrl));
  } finally {
    process.env.PATH = oldPath;
    Server.prototype.listen = original;
    await first.events.session_shutdown();
    await second.events.session_shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a local port conflict closes the reserved remote listener', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pocket-conflict-'));
  process.env.PI_CODING_AGENT_DIR = dir;
  const { default: extension } = await import('../extensions/pocket/index.ts?port-conflict');
  const events = {}, commands = {}, notices = [];
  const ctx = { cwd: dir, sessionManager: { getBranch: () => [] }, isIdle: () => true, abort() {}, ui: { notify: message => notices.push(message) } };
  extension({ on: (name, fn) => events[name] = fn, registerCommand: (name, command) => commands[name] = command, registerEntryRenderer() {}, appendEntry() {}, sendUserMessage() {} });
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const occupied = blocker.address().port;
  let remoteUrl;
  const original = Server.prototype.listen;
  Server.prototype.listen = function (port, host, callback) {
    return original.call(this, port === 18790 ? occupied : 0, host, () => {
      if (port === 18789) remoteUrl = `http://127.0.0.1:${this.address().port}`;
      callback();
    });
  };
  try {
    await events.session_start({}, ctx);
    await commands.remote.handler('', ctx);
    assert.match(notices.at(-1), /EADDRINUSE/);
    assert.ok(remoteUrl);
    await assert.rejects(fetch(remoteUrl));
  } finally {
    Server.prototype.listen = original;
    await events.session_shutdown();
    await new Promise(resolve => blocker.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
