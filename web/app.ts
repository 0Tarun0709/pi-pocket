import type { SharedSession } from '../extensions/pocket/sessions.ts';
import type { DisplayMessage } from '../extensions/pocket/index.ts';

type ModelChoice = { provider: string; id: string; name?: string };
type SessionState = {
  name?: string; project?: string; busy: boolean; queued: number; local: boolean;
  browser?: { id: string; label: string }; waiting?: { title?: string; kind: string };
  model?: ModelChoice; messages: DisplayMessage[];
};
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '';

const theme = document.querySelector<HTMLSelectElement>('#theme')!;
const savedTheme = document.cookie.split('; ').find(row => row.startsWith('pi-remote-theme='))?.split('=')[1];
if (savedTheme && [...theme.options].some(option => option.value === savedTheme)) theme.value = savedTheme;
document.documentElement.dataset.theme = theme.value;
theme.addEventListener('change', () => {
  document.documentElement.dataset.theme = theme.value;
  document.cookie = `pi-remote-theme=${theme.value}; Max-Age=31536000; Path=/; SameSite=Strict`;
});
const form = document.querySelector<HTMLFormElement>('#composer')!;
const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
const conversation = document.querySelector<HTMLElement>('#conversation')!;
const messages = document.querySelector<HTMLElement>('#messages')!;
const jumpLatest = document.querySelector<HTMLButtonElement>('#jump-latest')!;
const foldActivity = document.querySelector<HTMLInputElement>('#fold-activity')!;
foldActivity.checked = localStorage.getItem('pockpi-fold-activity') === 'true';
foldActivity.addEventListener('change', () => {
  localStorage.setItem('pockpi-fold-activity', String(foldActivity.checked));
  void refresh();
});
function updateJump() {
  jumpLatest.hidden = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 100;
}
conversation.addEventListener('scroll', updateJump, { passive: true });
window.addEventListener('resize', updateJump);
jumpLatest.addEventListener('click', () => {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (typeof conversation.scrollTo === 'function') {
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: reduceMotion ? 'instant' : 'smooth' });
  } else {
    conversation.scrollTop = conversation.scrollHeight;
    updateJump();
  }
});
function updateActivityTimes() {
  for (const time of messages.querySelectorAll<HTMLElement>('.activity-time')) {
    const seconds = Math.max(0, Math.floor((Number(time.dataset.end ?? Date.now()) - Number(time.dataset.start)) / 1000));
    time.textContent = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
}
const status = document.querySelector<HTMLElement>('#status')!;
const notice = document.querySelector<HTMLElement>('#notice')!;
const button = document.querySelector<HTMLButtonElement>('#composer-submit')!;
const drawer = document.querySelector<HTMLDialogElement>('#session-drawer')!;
document.querySelector<HTMLElement>('#open-sessions')!.addEventListener('click', () => { drawer.showModal(); void refreshSessions(); });
document.querySelector<HTMLElement>('#close-sessions')!.addEventListener('click', () => drawer.close());
drawer.addEventListener('click', event => {
  const { left, right } = drawer.getBoundingClientRect();
  if (event.target === drawer && (event.clientX < left || event.clientX >= right)) drawer.close();
});
const sessionList = document.querySelector<HTMLUListElement>('.session-list')!;
const sessionTabs = document.querySelector<HTMLElement>('.session-tabs')!;
const showSessionTabs = document.querySelector<HTMLInputElement>('#show-session-tabs')!;
showSessionTabs.checked = localStorage.getItem('pockpi-session-tabs') === 'true';
showSessionTabs.addEventListener('change', () => {
  localStorage.setItem('pockpi-session-tabs', String(showSessionTabs.checked));
  sessionTabs.hidden = !showSessionTabs.checked || !sessionTabs.childElementCount;
  if (showSessionTabs.checked) void refreshSessions();
});
const sessionEmpty = document.querySelector<HTMLElement>('#session-empty')!;
const sessionSearch = document.querySelector<HTMLInputElement>('#session-search')!;
function filterSessions() {
  const query = sessionSearch.value.trim().toLowerCase();
  let matches = 0;
  for (const row of sessionList.querySelectorAll('li')) {
    row.hidden = !row.dataset.search?.includes(query);
    if (!row.hidden) matches++;
  }
  sessionList.hidden = !matches;
  sessionEmpty.hidden = Boolean(matches);
  sessionEmpty.textContent = sessionList.children.length ? 'No matching sessions.' : 'No running sessions with PockPi loaded.';
}
sessionSearch.addEventListener('input', () => { if (lastSessions !== undefined) filterSessions(); });
const selectedSession = new URLSearchParams(location.search).get('session');
const api = (action: string) => selectedSession ? `/api/sessions/${encodeURIComponent(selectedSession)}/${action}` : `/api/${action}`;
let lastSessions: string | undefined;
let loadingSessions = false;
async function refreshSessions() {
  if (stoppedAll || loadingSessions) return;
  loadingSessions = true;
  try {
    const response = await fetch('/api/sessions', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const sessions: SharedSession[] = await response.json();
    if (stoppedAll) return;
    const serialized = JSON.stringify(sessions);
    if (serialized === lastSessions) return;
    lastSessions = serialized;
    const tabs: HTMLAnchorElement[] = [];
    sessionList.replaceChildren(...sessions.map(session => {
      const row = document.createElement('li');
      row.dataset.search = `${session.name} ${session.project}`.toLowerCase();
      const link = document.createElement('a');
      link.href = `/?session=${encodeURIComponent(session.id)}`;
      const current = selectedSession === session.id || (!selectedSession && session.gateway);
      if (current) link.setAttribute('aria-current', 'page');
      const switchSession = (event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
        if (current) { event.preventDefault(); if (drawer.open) drawer.close(); }
        else if (prompt.value.trim() && !confirm('Switch sessions and discard this unsent draft?')) event.preventDefault();
      };
      link.addEventListener('click', switchSession);
      const tab = document.createElement('a');
      tab.href = link.href;
      tab.textContent = session.name;
      tab.dataset.state = session.waiting ? 'waiting' : session.busy ? 'working' : 'idle';
      const label = `${session.name} · ${tab.dataset.state}`;
      tab.title = label;
      tab.setAttribute('aria-label', label);
      if (current) tab.setAttribute('aria-current', 'page');
      tab.addEventListener('click', switchSession);
      tabs.push(tab);
      const title = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = session.name;
      title.append(name);
      if (session.project !== session.name) {
        const project = document.createElement('small');
        project.textContent = session.project;
        title.append(project);
      }
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = session.waiting ? 'Waiting' : session.busy ? 'Working' : 'Idle';
      badge.dataset.working = String(session.busy && !session.waiting);
      link.append(title, badge);
      row.append(link);
      return row;
    }));
    const changedTabs = tabs.length !== sessionTabs.childElementCount ||
      tabs.some((tab, index) => !tab.isEqualNode(sessionTabs.children[index] ?? null));
    const firstTabs = !sessionTabs.childElementCount;
    if (changedTabs) {
      const focused = document.activeElement;
      const focusedHref = focused instanceof HTMLAnchorElement && sessionTabs.contains(focused) ? focused.href : undefined;
      sessionTabs.replaceChildren(...tabs);
      if (focusedHref) tabs.find(tab => tab.href === focusedHref)?.focus({ preventScroll: true });
    }
    sessionTabs.hidden = !showSessionTabs.checked || !tabs.length;
    if (firstTabs && !sessionTabs.hidden) sessionTabs.querySelector('[aria-current]')?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    filterSessions();
  } catch {
    lastSessions = undefined;
    sessionTabs.hidden = true;
    sessionTabs.replaceChildren();
    sessionList.hidden = true;
    sessionEmpty.hidden = false;
    sessionEmpty.textContent = 'Could not load sessions.';
  } finally { loadingSessions = false; }
}
function clearSession() {
  canSwitchModel = false;
  updateModelControls();
  button.disabled = true;
  if (stoppedAll) {
    sessionList.hidden = true;
    sessionEmpty.hidden = false;
    sessionEmpty.textContent = 'PockPi is disconnected.';
    sessionTabs.hidden = true;
  }
}
let lastMessages = '';
let stoppedAll = false;
let busy = false;
let actionNotice = '';
const picker = document.querySelector<HTMLDetailsElement>('.model-picker')!;
const modelForm = document.querySelector<HTMLFormElement>('#model-form')!;
const modelChoice = document.querySelector<HTMLSelectElement>('#model-choice')!;
const modelNotice = document.querySelector<HTMLElement>('#model-notice')!;
const modelButton = modelForm.querySelector('button')!;
const currentModel = document.querySelector<HTMLElement>('#current-model')!;
const modelKey = ({ provider, id }: ModelChoice) => JSON.stringify({ provider, id });
let activeModel = '', modelReady = false, canSwitchModel = false, switchingModel = false;
function updateModelControls() {
  modelChoice.disabled = !modelReady || switchingModel || stoppedAll;
  modelButton.disabled = modelChoice.disabled || !canSwitchModel || !modelChoice.value || modelChoice.value === activeModel;
}
picker.addEventListener('toggle', async () => {
  if (!picker.open || switchingModel || stoppedAll) return;
  modelReady = false;
  updateModelControls();
  modelNotice.textContent = 'Loading models…';
  try {
    const response = await fetch(api('models'), { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const models: ModelChoice[] = await response.json();
    modelChoice.replaceChildren(new Option('Select a model', ''), ...models.map(model => new Option(`${model.name || model.id} · ${model.provider}`, modelKey(model))));
    modelChoice.value = activeModel;
    if (!modelChoice.value) modelChoice.selectedIndex = 0;
    modelReady = models.length > 0;
    modelNotice.textContent = modelReady ? '' : 'No available models. Check /login on the laptop.';
  } catch {
    modelNotice.textContent = 'Could not load models. Close and reopen this menu to retry.';
  } finally { updateModelControls(); }
});
modelChoice.addEventListener('change', updateModelControls);
modelForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (modelButton.disabled) return;
  switchingModel = true;
  updateModelControls();
  modelNotice.textContent = 'Switching model…';
  try {
    const response = await fetch(api('model'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: modelChoice.value });
    if (!response.ok) throw new Error(await response.text());
    await refresh();
    modelNotice.textContent = 'Model changed for this session.';
  } catch (error) {
    modelNotice.textContent = errorMessage(error) || 'Could not change models.';
  } finally {
    switchingModel = false;
    updateModelControls();
  }
});
function updateSendButton() {
  button.setAttribute('aria-label', busy ? 'Stop execution' : 'Send message');
  button.dataset.stop = String(busy);
  button.querySelector('.send-icon')!.toggleAttribute('hidden', busy);
  button.querySelector('.stop-icon')!.toggleAttribute('hidden', !busy);
}
async function stop(all: boolean) {
  if (all && !confirm('Stop all shared Pi sessions, discard queued web prompts, and disable PockPi? Re-enable it from the laptop with /remote enable.')) return;
  try {
    const response = await fetch(all ? '/api/stop-all' : api('stop'), { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(await response.text());
    if (all) {
      stoppedAll = true;
      clearSession();
      status.textContent = 'Disabled';
      status.dataset.working = 'false';
      notice.hidden = false;
      notice.textContent = 'PockPi is disabled. Use /remote enable in the laptop terminal to enable it.';
      button.disabled = true;
    }
  } catch (error) {
    notice.hidden = false;
    notice.textContent = `Could not complete the stop request: ${errorMessage(error)}`;
  }
}
document.querySelector<HTMLElement>('#stop-all')!.addEventListener('click', () => stop(true));
document.querySelector<HTMLButtonElement>('#disconnect-tailscale')!.addEventListener('click', async () => {
  if (!confirm('Turn off PockPi’s Tailscale connection for all devices? Pi will keep running on the laptop.')) return;
  const control = document.querySelector<HTMLButtonElement>('#disconnect-tailscale')!;
  control.disabled = true;
  actionNotice = 'Turning off Tailscale access…';
  notice.hidden = false;
  notice.textContent = actionNotice;
  try {
    const response = await fetch('/api/disconnect-tailscale', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(await response.text());
    actionNotice = 'Tailscale access is off. Pi is still running on the laptop.';
    notice.textContent = actionNotice;
    if (location.protocol === 'https:') {
      stoppedAll = true;
      clearSession();
      status.textContent = 'Disconnected';
      status.dataset.working = 'false';
      button.disabled = true;
    }
  } catch (error) {
    if (error instanceof TypeError && location.protocol === 'https:') {
      stoppedAll = true;
      clearSession();
      status.textContent = 'Connection lost';
      status.dataset.working = 'false';
      button.disabled = true;
      actionNotice = 'Connection lost while turning off access. Check Tailscale Serve on the laptop to confirm.';
      notice.textContent = actionNotice;
    } else {
      actionNotice = `Could not turn off Tailscale access: ${errorMessage(error)}`;
      notice.textContent = actionNotice;
      control.disabled = false;
    }
  }
});
async function refresh() {
  if (stoppedAll) return;
  try {
    const response = await fetch(api('session'), { cache: 'no-store' });
    if (response.status === 401) { location.replace('/pair'); return; }
    if (!response.ok) throw new Error('Disconnected');
    const session: SessionState = await response.json();
    if (stoppedAll) return;
    busy = session.busy;
    document.querySelector<HTMLElement>('#active-session-name')!.textContent = session.name || 'Current session';
    document.querySelector<HTMLElement>('#active-project')!.textContent = session.project || '';
    picker.querySelector('summary')!.textContent = session.model ? (session.model.name || session.model.id) : 'Model';
    if (!sending) button.disabled = false;
    activeModel = session.model ? modelKey(session.model) : '';
    currentModel.textContent = session.model ? `Current model: ${session.model.name || session.model.id} · ${session.model.provider}` : 'No model selected in Pi.';
    canSwitchModel = !busy && !session.waiting && !session.queued;
    updateModelControls();
    updateSendButton();
    status.textContent = session.waiting ? 'Waiting for input' : session.busy ? 'Working' : 'Connected';
    status.dataset.working = String(session.busy && !session.waiting);
    if (drawer.open || showSessionTabs.checked) void refreshSessions();
    if (session.local) document.querySelector<HTMLElement>('#browser-label')!.textContent = 'This browser: local access';
    else if (session.browser) document.querySelector<HTMLElement>('#browser-label')!.textContent = `This browser: ${session.browser.label} · ${session.browser.id}`;
    document.querySelector<HTMLElement>('.footnote')!.textContent = session.queued ? `${session.queued} web prompt${session.queued === 1 ? '' : 's'} queued.` : 'Use the stop button to interrupt Pi while it is working.';
    notice.hidden = !session.waiting && !actionNotice;
    if (session.waiting) notice.textContent = `Pi is waiting for ${session.waiting.title || session.waiting.kind}. Answer it in the laptop terminal; remote answers are not supported yet.`;
    else if (actionNotice) notice.textContent = actionNotice;
    const serialized = JSON.stringify([foldActivity.checked, session.messages]);
    if (serialized !== lastMessages) {
      renderTranscript(messages, conversation, session.messages);
      lastMessages = serialized;
      updateJump();
    }
    updateActivityTimes();
  } catch {
    if (stoppedAll) return;
    clearSession();
    if (drawer.open || showSessionTabs.checked) void refreshSessions();
    status.textContent = 'Disconnected';
    status.dataset.working = 'false';
    notice.hidden = false;
    notice.textContent = selectedSession ? 'This session is unavailable. Tap the Pi icon to choose another.' : 'Cannot connect to Pi. Check that PockPi is still running on the laptop.';
  }
}
let sending = false;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  if (busy) { await stop(false); return; }
  const text = prompt.value.trim();
  if (!text) return;
  sending = true;
  button.disabled = true;
  try {
    const response = await fetch(api('prompt'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error('Send failed');
    if (prompt.value.trim() === text) prompt.value = '';
    await refresh();
  } catch {
    notice.hidden = false;
    notice.textContent = 'Could not send. Your message is still in the composer.';
  } finally { sending = false; if (!stoppedAll) void refresh(); }
});
button.disabled = true;
refresh();
setInterval(refresh, 1500);
