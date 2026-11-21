import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('renders streamed markdown safely and keeps user text literal', async () => {
  const state = await mkdtemp(join(tmpdir(), 'pi-pocket-state-'));
  process.env.PI_CODING_AGENT_DIR = state;
  const { default: extension } = await import('../extensions/pocket/index.ts');
  const events = {};
  let url, busy = false, aborts = 0;
  extension({ registerCommand() {}, on(name, handler) { events[name] = handler; }, sendUserMessage() {} });
  // Tests use an ephemeral port so an active Pi Remote session can keep its fixed port.
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (_port, host, callback) { return listen.call(this, 0, host, callback); };
  try { await events.session_start({}, {
    cwd: state,
    sessionManager: { getBranch: () => [
      { type: 'message', message: { role: 'user', content: '**literal**' } },
      { type: 'message', message: { role: 'assistant', content: [ { type: 'text', text: '# Heading\n\n**bold**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nhello()\n```\n\n<img src=x onerror="alert(1)"><script>alert(1)</script> [bad](javascript:alert(1))' }, { type: 'toolCall', id: 'old', name: 'read', arguments: { path: 'x' } } ] } },
      { type: 'message', message: { role: 'toolResult', toolCallId: 'old', toolName: 'read', content: [{ type: 'text', text: 'file contents' }], isError: false } },
    ] },
    isIdle: () => !busy,
    abort: () => { aborts++; },
    ui: { notify(message) { url = message.replace('Pi Remote: ', ''); } },
  }); } finally { Server.prototype.listen = listen; }
  let dom;
  try {
    dom = await JSDOM.fromURL(url, {
      resources: 'usable', runScripts: 'dangerously',
      beforeParse(window) { window.fetch = (path, options) => fetch(new URL(path, url), { ...options, headers: { ...options?.headers, origin: url } }); },
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
  } finally {
    dom?.window.close();
    await events.session_shutdown();
    await rm(state, { recursive: true, force: true });
  }
});
