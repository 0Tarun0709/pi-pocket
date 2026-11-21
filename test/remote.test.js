import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, requestInterceptor } from 'jsdom';
import jsQR from 'jsqr';
import { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('renders streamed markdown safely and keeps user text literal', async () => {
  const state = await mkdtemp(join(tmpdir(), 'pockpi-state-'));
  process.env.PI_CODING_AGENT_DIR = state;
  const { default: extension } = await import('../extensions/pocket/index.ts');
  const events = {}, commands = {};
  let url, code, qrLines, busy = false, aborts = 0;
  const first = { provider: 'example', id: 'first', name: 'First model', headers: { 'x-private': 'not-for-browser' } };
  const second = { provider: 'example', id: 'second', name: 'Second model' };
  const outside = { provider: 'example', id: 'outside', name: 'Outside scope' };
  let activeModel = first;
  extension({ registerCommand(name, command) { commands[name] = command; }, registerEntryRenderer() {}, on(name, handler) { events[name] = handler; }, sendUserMessage() {}, async setModel(model) { activeModel = model; return true; } });
  // Tests use an ephemeral port so an active PockPi session can keep its fixed port.
  const listen = Server.prototype.listen;
  Server.prototype.listen = function (_port, host, callback) { return listen.call(this, 0, host, callback); };
  const ctx = {
    cwd: state,
    get model() { return activeModel; },
    modelRegistry: { getAvailable: () => [first, second, outside] },
    scopedModels: [{ model: first }, { model: second }],
    sessionManager: { getSessionName: () => 'Example session', getBranch: () => [
      { type: 'custom', customType: 'pi-pocket-prompt', data: { via: 'tailscale' } },
      { type: 'message', message: { role: 'user', content: '**literal**' } },
      { type: 'message', message: { role: 'assistant', timestamp: 1000, content: [ { type: 'text', text: '# Heading\n\n**bold**\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nhello()\n```\n\n<img src=x onerror="alert(1)"><script>alert(1)</script> [bad](javascript:alert(1))' }, { type: 'toolCall', id: 'old', name: 'read', arguments: { path: 'x' } } ] } },
      { type: 'message', message: { role: 'toolResult', timestamp: 4000, toolCallId: 'old', toolName: 'read', content: [{ type: 'text', text: 'file contents' }], isError: false } },
      { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing.' }] } },
    ] },
    isIdle: () => !busy,
    abort: () => { aborts++; },
    ui: { notify(message) {
      if (message.startsWith('PockPi: http')) url = message.replace('PockPi: ', '');
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
  const selectModel = (model, headers = {}) => fetch(url + '/api/model', { method: 'POST', headers: { cookie, origin: url, 'content-type': 'application/json', ...headers }, body: JSON.stringify(model) });
  let dom;
  try {
    assert.equal((await fetch(url + '/api/models')).status, 401);
    assert.deepEqual(await (await fetch(url + '/api/models', { headers: { cookie } })).json(), [{ provider: first.provider, id: first.id, name: first.name }, second]);
    assert.equal((await selectModel(second, { origin: 'https://other.example' })).status, 403);
    assert.equal((await selectModel(outside)).status, 404);
    assert.equal(activeModel, first);
    dom = await JSDOM.fromURL(url, {
      resources: { interceptors: [requestInterceptor(request => fetch(request.url, { headers: { cookie } }))] }, runScripts: 'dangerously',
      beforeParse(window) {
        window.fetch = (path, options) => fetch(new URL(path, url), { ...options, headers: { ...options?.headers, origin: url, cookie } });
        window.HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
        window.HTMLDialogElement.prototype.close ??= function () { this.open = false; };
      },
    });
    for (let i = 0; i < 100 && !dom.window.document.querySelector('.markdown h1'); i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const document = dom.window.document;
    assert.equal(document.title, 'PockPi');
    assert.equal(document.querySelector('.brand h1').textContent, 'Example session');
    const sessions = document.querySelector('#session-drawer');
    assert.equal(sessions.open, false);
    document.querySelector('#open-sessions').click();
    assert.equal(sessions.open, true);
    for (let i = 0; i < 50 && sessions.querySelector('.session-list').hidden; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sessions.querySelector('.session-list').hidden, false);
    assert.equal(sessions.querySelector('[aria-current="page"] strong').textContent, 'Example session');
    assert.equal(sessions.querySelector('.badge').textContent, 'Idle');
    const search = sessions.querySelector('#session-search');
    search.value = 'no such session';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(sessions.querySelector('.session-list').hidden, true);
    assert.equal(sessions.querySelector('#session-empty').textContent, 'No matching sessions.');
    search.value = 'EXAMPLE';
    search.dispatchEvent(new dom.window.Event('input'));
    assert.equal(sessions.querySelector('.session-list').hidden, false);
    assert.equal(sessions.querySelector('#stop-all, #disconnect-tailscale'), null);
    sessions.querySelector('#close-sessions').click();
    assert.equal(sessions.open, false);
    const tabs = document.querySelector('.session-tabs');
    const showTabs = document.querySelector('#show-session-tabs');
    assert.equal(tabs.hidden, true);
    showTabs.checked = true;
    showTabs.dispatchEvent(new dom.window.Event('change'));
    assert.equal(tabs.hidden, false);
    const currentTab = tabs.querySelector('[aria-current="page"]');
    assert.equal(currentTab.textContent, 'Example session');
    assert.equal(currentTab.dataset.state, 'idle');
    assert.equal(dom.window.localStorage.getItem('pockpi-session-tabs'), 'true');
    assert.equal(currentTab.dispatchEvent(new dom.window.MouseEvent('click', { cancelable: true })), false);
    const actions = document.querySelector('.actions');
    actions.querySelector('summary[aria-label="More actions"]').click();
    assert.equal(actions.open, true);
    assert.ok(actions.querySelector('#stop-all'));
    assert.ok(actions.querySelector('#disconnect-tailscale'));
    document.querySelector('.model-picker summary').click();
    const modelForm = document.querySelector('#model-form');
    const choice = document.querySelector('#model-choice');
    for (let i = 0; i < 50 && choice.disabled; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual([...choice.options].map(option => option.text), ['Select a model', 'First model · example', 'Second model · example']);
    assert.match(document.querySelector('#current-model').textContent, /First model/);
    busy = true;
    assert.equal((await selectModel(second)).status, 409);
    busy = false;
    choice.selectedIndex = 2;
    choice.dispatchEvent(new dom.window.Event('change'));
    modelForm.querySelector('button').click();
    const modelNotice = document.querySelector('#model-notice');
    for (let i = 0; i < 50 && !modelNotice.textContent.includes('Model changed'); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(modelNotice.textContent, /Model changed/);
    assert.equal(activeModel, second);
    assert.match(document.querySelector('#current-model').textContent, /Second model/);
    assert.equal(document.documentElement.dataset.theme, 'graphite');
    const theme = document.querySelector('#theme');
    theme.value = 'light';
    theme.dispatchEvent(new dom.window.Event('change'));
    assert.equal(document.documentElement.dataset.theme, 'light');
    assert.match(document.cookie, /pi-remote-theme=light/);
    assert.match(document.querySelector('#browser-label').textContent, /^This browser: .+ · [a-f0-9]{16}$/);
    assert.equal(document.querySelector('.source-label').textContent, 'PockPi · Tailscale address');
    assert.equal(document.querySelector('.message.user .prompt-text').textContent, '**literal**');
    assert.equal(document.querySelector('.markdown h1').textContent, 'Heading');
    assert.equal(document.querySelector('.markdown strong').textContent, 'bold');
    assert.equal(document.querySelector('.markdown table td').textContent, '1');
    assert.match(document.querySelector('.markdown pre code').textContent, /hello\(\)/);
    assert.equal(document.querySelector('.markdown img, .markdown script'), null);
    assert.equal(document.querySelector('.markdown a[href^="javascript:"]'), null);
    assert.equal(document.querySelector('#active-session-name').textContent, 'Example session');
    assert.equal(document.querySelector('.view-switch'), null);
    const activity = document.querySelector('.activity');
    assert.equal(activity.open, true);
    assert.match(activity.querySelector('summary').textContent, /Read 1 file/);
    assert.equal(activity.querySelector('.activity-time').textContent, '3s');
    const conversation = document.querySelector('#conversation');
    const jump = document.querySelector('#jump-latest');
    Object.defineProperty(conversation, 'scrollHeight', { value: 1000 });
    conversation.scrollTop = 0;
    conversation.dispatchEvent(new dom.window.Event('scroll'));
    assert.equal(jump.hidden, false);
    jump.click();
    assert.equal(conversation.scrollTop, 1000);
    assert.equal(jump.hidden, true);
    activity.querySelector('summary').click();
    assert.equal(activity.open, false);
    activity.querySelector('summary').click();
    assert.equal(activity.open, true);
    assert.match(document.querySelector('.tool summary').textContent, /read x.*done/);
    assert.match(document.querySelector('.tool').textContent, /file contents/);
    const details = document.querySelector('.tool');
    const priorReply = document.querySelector('.markdown h1');
    details.open = true;
    await new Promise(resolve => setTimeout(resolve, 20));
    const thinking = { role: 'assistant', content: [{ type: 'thinking', thinking: 'not for the browser' }] };
    const snapshot = () => fetch(url + '/api/session', { headers: { cookie } }).then(r => r.json());
    await events.message_update({ message: thinking, assistantMessageEvent: { type: 'thinking_start' } });
    const live = await snapshot();
    assert.equal(live.messages.at(-1).state, 'running');
    assert.doesNotMatch(JSON.stringify(live), /not for the browser/);
    await events.message_end({ message: thinking });
    await events.tool_execution_start({ toolCallId: 'new', toolName: 'bash', args: { command: 'pwd' } });
    await events.tool_execution_end({ toolCallId: 'new', result: { content: [{ type: 'text', text: 'failed' }] }, isError: true });
    await events.tool_execution_start({ toolCallId: 'edit', toolName: 'edit', args: { path: 'file.js' } });
    await events.tool_execution_end({ toolCallId: 'edit', result: { content: [{ type: 'text', text: 'edited' }], details: { diff: '-old\n+new' } }, isError: false });
    const fold = document.querySelector('#fold-activity');
    fold.checked = true;
    fold.dispatchEvent(new dom.window.Event('change'));
    busy = true;
    await events.ui_prompt_start({ kind: 'confirm', title: 'Approve?' });
    await events.message_update({ message: { role: 'assistant', content: [{ type: 'text', text: '## Streaming' }] } });
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(document.querySelectorAll('.markdown h2')[0].textContent, 'Streaming');
    assert.equal(document.querySelector('.markdown h1'), priorReply);
    assert.equal(document.querySelector('.tool').open, true);
    const groups = document.querySelectorAll('.activity');
    assert.equal(groups[0].open, true);
    assert.equal(groups[1].open, false);
    assert.match(groups[1].querySelector('summary').textContent, /Thought.*Ran 1 command.*Edited 1 file/);
    assert.equal(groups[1].querySelector('.thinking-step').textContent, 'Thought');
    assert.doesNotMatch(JSON.stringify(await snapshot()), /not for the browser/);
    assert.match(document.querySelectorAll('.tool summary')[1].textContent, /\$ pwd.*error/);
    assert.match(document.querySelectorAll('.tool summary')[1].textContent, /failed/);
    assert.equal(document.querySelector('.markdown pre code .hljs-title')?.textContent, 'hello');
    const preview = document.querySelectorAll('.tool summary')[2];
    assert.equal(preview.querySelector('.diff-remove').textContent, '-old');
    assert.equal(preview.querySelector('.diff-add').textContent, '+new');
    assert.match(document.querySelector('#notice').textContent, /Approve\?/);
    document.querySelector('#open-sessions').click();
    for (let i = 0; i < 50 && sessions.querySelector('.badge')?.textContent !== 'Waiting'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sessions.querySelector('.badge').textContent, 'Waiting');
    assert.equal(tabs.querySelector('[aria-current="page"]').dataset.state, 'waiting');
    showTabs.checked = false;
    showTabs.dispatchEvent(new dom.window.Event('change'));
    assert.equal(tabs.hidden, true);
    sessions.querySelector('#close-sessions').click();
    const send = document.querySelector('#composer-submit');
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
