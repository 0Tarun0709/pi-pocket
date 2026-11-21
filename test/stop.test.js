import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from 'node:http';

test('all-stop aborts, discards remote queue and stays disabled until enabled locally', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-test-'));
  await mkdir(join(dir, '.pi/extensions'), { recursive: true });
  await mkdir(join(dir, 'web'));
  await copyFile('.pi/extensions/remote.ts', join(dir, '.pi/extensions/remote.ts'));
  await copyFile('web/index.html', join(dir, 'web/index.html'));
  await symlink(resolve('node_modules'), join(dir, 'node_modules'));
  const { default: extension } = await import(pathToFileURL(join(dir, '.pi/extensions/remote.ts')));
  const events = {}, commands = {};
  let url, aborts = 0, sent = [], idle = false;
  const ctx = { sessionManager: { getBranch: () => [] }, isIdle: () => idle, abort: () => aborts++, ui: { notify: message => { if (message.startsWith('Pi Remote: http')) url = message.slice('Pi Remote: '.length); } } };
  extension({ on: (name, fn) => events[name] = fn, registerCommand: (name, command) => commands[name] = command, sendUserMessage: text => sent.push(text) });
  const original = Server.prototype.listen;
  Server.prototype.listen = function (_port, host, callback) { return original.call(this, 0, host, callback); };
  try {
    await events.session_start({}, ctx);
    const post = (path, body = {}) => fetch(url + path, { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/prompt', { text: 'queued' })).status, 202);
    assert.equal((await (await fetch(url + '/api/session')).json()).queued, 1);
    assert.equal((await post('/api/stop')).status, 200);
    assert.equal(aborts, 1);
    assert.equal((await post('/api/stop-all')).status, 200);
    assert.equal(aborts, 2);
    idle = true;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.deepEqual(sent, []);
    await assert.rejects(fetch(url));
    await events.session_shutdown();
    await events.session_start({}, ctx);
    await assert.rejects(fetch(url));
    await commands.remote.handler('enable', ctx);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await (await fetch(url + '/api/session')).json()).queued, 0);
  } finally {
    await events.session_shutdown();
    Server.prototype.listen = original;
    await rm(dir, { recursive: true, force: true });
  }
});
