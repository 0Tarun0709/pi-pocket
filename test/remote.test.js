import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, requestInterceptor } from 'jsdom';
import jsQR from 'jsqr';
import { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('renders streamed markdown safely and keeps user text literal', async () => {
  const state = await mkdtemp(join(tmpdir(), 'pi-pocket-state-'));
  process.env.PI_CODING_AGENT_DIR = state;
  const { default: extension } = await import('../extensions/pocket/index.ts');
  const events = {}, commands = {};
  let url, code, qrLines, busy = false, aborts = 0;
  extension({ registerCommand(name, command) { commands[name] = command; }, registerEntryRenderer() {}, on(name, handler) { events[name] = handler; }, sendUserMessage() {} });
  // Tests use an ephemeral port so an active Pi Remote session can keep its fixed port.
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (_port, host, callback) { return listen.call(this, 0, host, callback); };
  const ctx = {
    cwd: state,
    sessionManager: { getBranch: () => [
      { type: 'custom', customType: 'pi-pocket-prompt', data: { via: 'tailscale' } },
      { type: 'message', message: { role: 'user', content: '**literal**' } },
      { type: 'message', message: { role: 'assistant', content: [ { type: 'text', text: '# Heading\n\n**bold**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nhello()\n```\n\n<img src=x onerror="alert(1)"><script>alert(1)</script> [bad](javascript:alert(1))' }, { type: 'toolCall', id: 'old', name: 'read', arguments: { path: 'x' } } ] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'old', toolName: 'read', content: [{ type: 'text', text: 'file contents' }], isError: false } },
    ] },
    isIdle: () => !busy,
    abort: () => { aborts++; },
    ui: { notify(message) {
      if (message.startsWith('Pi Remote: http')) url = message.replace('Pi Remote: ', '');
    }, custom: async factory => { const lines = factory({}, { fg: (_color, text) => text }, {}, () => {}).render(200); code = lines.find(line => line.startsWith('Code: ')).slice(6); qrLines = lines.filter(line => line.startsWith('\x1b[30;47m')).map(line => line.slice(8, -4)); } },
  };
  await events.session_start({}, ctx);
  try { await commands.remote.handler('pair local', ctx); } finally { Server.prototype.listen = listen; }
  const scale = 4, width = qrLines[0].length * scale, height = qrLines.length * 2 * scale;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let row = 0; row < qrLines.length; row++) for (let col = 0; col < qrLines[row].length; col++) {
    const cell = qrLines[row][col];
    for (let half = 0; half < 2; half++) {
      const black = cell === '█' || (half === 0 ? cell === '▀' : cell === '▄');
      if (black) for (let y = 0; y < scale; y++) for (let x = 0; x < scale; x++) {
        const at = (((row * 2 + half) * scale + y) * width + col * scale + x) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }
  }
  assert.equal(jsQR(pixels, width, height)?.data, `${url}/pair#pair=${code}`);
  const paired = await fetch(url + '/api/pair', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const cookie = paired.headers.get('set-cookie').split(';')[0];
  let dom;
  try {
    dom = await JSDOM.fromURL(url, {
      resources: { interceptors: [requestInterceptor(request => fetch(request.url, { headers: { cookie } }))] }, runScripts: 'dangerously',
      beforeParse(window) { window.fetch = (path, options) => fetch(new URL(path, url), { ...options, headers: { ...options?.headers, origin: url, cookie } }); },
    });
    for (let i = 0; i < 100 && !dom.window.document.querySelector('.markdown h1'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const document = dom.window.document;
    const sessions = document.querySelector('.sessions');
    sessions.querySelector('summary').click();
    assert.equal(sessions.open, true);
    assert.match(sessions.textContent, /not connected yet/);
    assert.equal(document.documentElement.dataset.theme, 'graphite');
    const theme = document.querySelector('#theme');
    theme.value = 'light';
    theme.dispatchEvent(new dom.window.Event('change'));
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.match(document.cookie, /pi-remote-theme=light/);
    assert.match(document.querySelector('#browser-label').textContent, /^This browser: .+ · [a-f0-9]{16}$/);
    assert.equal(document.querySelector('.source-label').textContent, 'Pi Pocket · Tailscale address');
    assert.equal(document.querySelector('.message.user .bubble').textContent, '**literal**');
    assert.equal(document.querySelector('.markdown h1').textContent, 'Heading');
    assert.equal(document.querySelector('.markdown strong').textContent, 'bold');
    assert.equal(document.querySelector('.markdown table td').textContent, '1');
    assert.match(document.querySelector('.markdown pre code').textContent, /hello\(\)/);
    assert.equal(document.querySelector('.markdown img, .markdown script'), null);
    assert.equal(document.querySelector('.markdown a[href^="javascript:"]'), null);
    assert.match(document.querySelector('.tool summary').textContent, /read x.*done/);
    assert.match(document.querySelector('.tool').textContent, /file contents/);
    const details = document.querySelector('.tool');
    details.open = true;
    await new Promise(resolve => setTimeout(resolve, 20));
    await events.tool_execution_start({ toolCallId: 'new', toolName: 'bash', args: { command: 'pwd' } });
    await events.tool_execution_end({ toolCallId: 'new', result: { content: [{ type: 'text', text: 'failed' }] }, isError: true });
    await events.tool_execution_start({ toolCallId: 'edit', toolName: 'edit', args: { path: 'file.js' } });
    await events.tool_execution_end({ toolCallId: 'edit', result: { content: [{ type: 'text', text: 'edited' }], details: { diff: '-old\n+new' } }, isError: false });
    busy = true;
    await events.ui_prompt_start({ kind: 'confirm', title: 'Approve?' });
    await events.message_update({ message: { role: 'assistant', content: [{ type: 'text', text: '## Streaming' }] } });
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(document.querySelectorAll('.markdown h2')[0].textContent, 'Streaming');
    assert.equal(document.querySelector('.tool').open, true);
    assert.match(document.querySelectorAll('.tool summary')[1].textContent, /\$ pwd.*error/);
    assert.match(document.querySelectorAll('.tool summary')[1].textContent, /failed/);
    assert.equal(document.querySelector('.markdown pre code .hljs-title')?.textContent, 'hello');
    const preview = document.querySelectorAll('.tool summary')[2];
    assert.equal(preview.querySelector('.diff-remove').textContent, '-old');
    assert.equal(preview.querySelector('.diff-add').textContent, '+new');
    assert.match(document.querySelector('#notice').textContent, /Approve\?/);
    const send = document.querySelector('#composer button');
    assert.equal(send.getAttribute('aria-label'), 'Stop execution');
    send.click();
    for (let i = 0; i < 50 && !aborts; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(aborts, 1);
    busy = false;
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(send.getAttribute('aria-label'), 'Send message');
    let disconnects = 0;
    const originalFetch = dom.window.fetch;
    dom.window.fetch = (path, options) => path === '/api/disconnect-tailscale'
      ? (disconnects++, Promise.resolve({ ok: true })) : originalFetch(path, options);
    dom.window.confirm = () => false;
    document.querySelector('#disconnect-tailscale').click();
    assert.equal(disconnects, 0);
    dom.window.confirm = () => true;
    document.querySelector('#disconnect-tailscale').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(disconnects, 1);
    assert.match(document.querySelector('#notice').textContent, /Tailscale access is off/);
    assert.equal(aborts, 1);
  } finally {
    dom?.window.close();
    await events.session_shutdown();
    await rm(state, { recursive: true, force: true });
  }
});
