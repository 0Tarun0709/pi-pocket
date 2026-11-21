import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTailscale } from '../extensions/pocket/tailscale.ts';

const node = { BackendState: 'Running', Self: { DNSName: 'laptop.test.ts.net.' } };
const route = { TCP: { '443': { HTTPS: true } }, Web: { 'laptop.test.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:18789' } } } } };

test('starts a private Serve route once and reuses an existing one', async () => {
  let config = null;
  const calls = [];
  const run = async args => {
    const command = args.join(' ');
    calls.push(command);
    if (command === 'status --json') return JSON.stringify(node);
    if (command === 'serve status --json') return JSON.stringify(config);
    if (command === 'serve --bg --https=443 http://127.0.0.1:18789') { config = route; return ''; }
    throw new Error('unexpected command');
  };
  assert.equal(await prepareTailscale(18789, run), 'https://laptop.test.ts.net');
  assert.equal(await prepareTailscale(18789, run), 'https://laptop.test.ts.net');
  assert.equal(calls.filter(call => call.startsWith('serve --bg')).length, 1);
});

test('never overwrites another route or a Funnel configuration', async () => {
  for (const config of [
    { TCP: { '443': { HTTPS: true } }, Web: { 'laptop.test.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } },
    { ...route, AllowFunnel: { 'laptop.test.ts.net:443': true } },
    { Web: { 'other.test.ts.net:443': { Handlers: {} } } },
  ]) {
    const calls = [];
    const run = async args => { calls.push(args.join(' ')); return JSON.stringify(args[0] === 'status' ? node : config); };
    await assert.rejects(prepareTailscale(18789, run), /another route or Funnel/);
    assert.deepEqual(calls, ['status --json', 'serve status --json']);
  }
});

test('reports offline, approval and verification failures without returning a QR origin', async () => {
  await assert.rejects(prepareTailscale(18789, async () => { throw new Error('missing'); }), /Install Tailscale/);
  await assert.rejects(prepareTailscale(18789, async () => JSON.stringify({ BackendState: 'Stopped' })), /not connected/);
  const approval = async args => {
    if (args[0] === 'status') return JSON.stringify(node);
    if (args[1] === 'status') return '{}';
    throw Object.assign(new Error('approval required'), { stdout: 'Visit https://login.tailscale.com/f/serve?node=abc123' });
  };
  await assert.rejects(prepareTailscale(18789, approval), /https:\/\/login\.tailscale\.com\/f\/serve\?node=abc123/);
  const unverified = async args => args[0] === 'status' ? JSON.stringify(node) : args[1] === 'status' ? '{}' : '';
  await assert.rejects(prepareTailscale(18789, unverified), /Could not verify/);
});
