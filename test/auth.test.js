import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Pairing } from '../extensions/pocket/auth.ts';

test('pairing codes are single-use and expire; browser credentials persist and can be revoked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pocket-auth-'));
  const now = Date.now;
  try {
    let time = now();
    Date.now = () => time;
    const auth = new Pairing(dir);
    const superseded = auth.issue();
    const code = auth.issue();
    assert.equal(auth.accept(superseded), undefined);
    assert.equal(auth.accept('wrong'), undefined);
    const token = auth.accept(code, 'Mozilla/5.0 (Linux; Android 14)');
    assert.ok(token);
    assert.equal(auth.accept(code), undefined);
    assert.ok(auth.identify(token));
    const saved = await readFile(join(dir, 'browsers.json'), 'utf8');
    assert.ok(!saved.includes(token) && !saved.includes(code));
    assert.equal((await stat(join(dir, 'browsers.json'))).mode & 0o777, 0o600);
    const restarted = new Pairing(dir);
    assert.ok(restarted.identify(token));
    assert.equal(restarted.list()[0].label, 'Android');
    const expiring = restarted.issue();
    time += 120_000;
    assert.equal(restarted.accept(expiring), undefined);
    const second = restarted.accept(restarted.issue(), 'iPhone');
    const browsers = restarted.list();
    assert.equal(browsers.length, 2);
    restarted.revoke(browsers[1].id);
    assert.ok(restarted.identify(token));
    assert.equal(restarted.identify(second), undefined);
    assert.equal(new Pairing(dir).identify(second), undefined);
    time += 365 * 24 * 60 * 60 * 1000;
    assert.equal(restarted.identify(token), undefined);
  } finally { Date.now = now; await rm(dir, { recursive: true, force: true }); }
});
