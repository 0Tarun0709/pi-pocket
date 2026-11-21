import type { ToolMessage, TextMessage, DisplayMessage } from '../extensions/pocket/index.ts';

declare const hljs: { getLanguage(name: string): unknown; highlightElement(element: HTMLElement): void };
declare const DOMPurify: typeof import('dompurify').default;
declare const marked: typeof import('marked').marked;

declare global {
  var renderTranscript: (root: HTMLElement, scroller: HTMLElement, messages: DisplayMessage[]) => void;
}

globalThis.renderTranscript = (() => {
  const openTools = new Set();
  const groups = new Map<string, { open: boolean; touched: boolean }>();
  let rows: { key: string; value: string; node: HTMLElement }[] = [];
  function toolText(output: ToolMessage['output']) {
    const content = Array.isArray(output) ? output : (output as { content?: unknown } | null)?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part: { type?: string; text?: string } | null) => part?.type === 'text' ? part.text : `[${part?.type || 'attachment'}]`).join('\n');
    return typeof output === 'string' ? output : '';
  }
  function toolTitle(item: ToolMessage) {
    const args = (item.args ?? {}) as Record<string, unknown>;
    const path = args.file_path ?? args.path ?? '';
    if (item.name === 'bash' || item.name === 'powershell') return `${item.name === 'bash' ? '$' : '>'} ${args.command || '…'}`;
    if (item.name === 'grep') return `grep /${args.pattern || ''}/ in ${path || '.'}`;
    if (item.name === 'find') return `find ${args.pattern || ''} in ${path || '.'}`;
    return `${item.name}${path ? ` ${path}` : ''}`;
  }
  function codeBlock(text: string, path?: unknown, diff = false) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = text;
    const extension = typeof path === 'string' ? path.split('.').pop()?.toLowerCase() : undefined;
    const aliases: Record<string, string> = { js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', py: 'python', sh: 'bash', yml: 'yaml', clj: 'clojure', html: 'xml' };
    const language = extension && (aliases[extension] || extension);
    if (!diff && language && hljs.getLanguage(language)) {
      code.className = `language-${language}`;
      hljs.highlightElement(code);
    }
    if (diff) {
      const lines = document.createDocumentFragment();
      text.split('\n').forEach((line, index) => {
        const span = document.createElement('span');
        span.className = /^\s*\+/.test(line) ? 'diff-add' : /^\s*-/.test(line) ? 'diff-remove' : '';
        span.textContent = line;
        if (index) lines.append('\n');
        lines.append(span);
      });
      code.replaceChildren(lines);
    }
    pre.append(code);
    return pre;
  }
  function renderTool(item: ToolMessage) {
    const details = document.createElement('details');
    details.className = 'tool';
    details.open = openTools.has(item.id);
    details.addEventListener('toggle', () => {
      if (details.open) openTools.add(item.id); else openTools.delete(item.id);
    });
    const args = (item.args ?? {}) as Record<string, unknown>;
    const path = args.file_path ?? args.path;
    const output = toolText(item.output);
    const rawDiff = (item.output as { details?: { diff?: unknown } } | null)?.details?.diff;
    const diff = item.name === 'edit' && typeof rawDiff === 'string' ? rawDiff : '';
    const content = diff || (item.name === 'write' && item.state !== 'error' && typeof args.content === 'string' ? args.content : output) || '';
    const summary = document.createElement('summary');
    const title = document.createElement('strong');
    title.textContent = toolTitle(item);
    const state = document.createElement('span');
    state.className = 'tool-state';
    state.textContent = item.state === 'unknown' ? 'result unavailable' : item.state;
    summary.append(title, state);
    if (content && item.name !== 'read') {
      const lines = content.trimEnd().split('\n');
      const limit = item.name === 'bash' || item.name === 'powershell' ? 5 : 10;
      const previewText = (item.name === 'bash' || item.name === 'powershell' ? lines.slice(-limit) : lines.slice(0, limit)).join('\n') + (lines.length > limit ? `\n… ${lines.length - limit} more lines` : '');
      const preview = codeBlock(previewText, path, Boolean(diff));
      preview.className = 'tool-preview';
      summary.append(preview);
    }
    const body = document.createElement('div');
    body.className = 'tool-body';
    if (content) body.append(codeBlock(content, path, Boolean(diff)));
    if (item.state === 'error' && diff && output) body.append(codeBlock(output));
    if (!content && item.args && !['read', 'bash', 'powershell', 'write', 'edit', 'grep', 'find', 'ls'].includes(item.name)) body.append(codeBlock(JSON.stringify(item.args, null, 2)));
    details.append(summary, body);
    return details;
  }
  function activity(items: ToolMessage[], newest: boolean) {
    const key = items[0].id;
    const group = document.createElement('details');
    group.className = 'activity';
    let state = groups.get(key);
    if (!state) {
      state = { open: newest, touched: false };
      groups.set(key, state);
    }
    const choice = state;
    const live = items.some(item => item.state === 'running');
    const folded = localStorage.getItem('pockpi-fold-activity') === 'true';
    group.open = choice.touched ? choice.open : !folded && (live || newest);
    const summary = document.createElement('summary');
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
    const labels: Record<string, [string, string]> = {
      read: ['Read', 'file'], edit: ['Edited', 'file'], write: ['Wrote', 'file'],
      bash: ['Ran', 'command'], powershell: ['Ran', 'command'], grep: ['Searched', 'pattern'],
      find: ['Searched', 'path'], ls: ['Listed', 'directory'],
    };
    summary.textContent = [...counts].map(([name, count]) => {
      const label = labels[name];
      const noun = label?.[1] ?? 'call';
      const plural = noun === 'directory' ? 'directories' : `${noun}s`;
      return label ? `${label[0]} ${count} ${count === 1 ? noun : plural}` : `${count} ${name}`;
    }).join(' · ');
    const indicator = document.createElement('span');
    const failed = items.filter(item => item.state === 'error').length;
    indicator.textContent = failed ? `${failed} failed` : items.some(item => item.state === 'running') ? 'Running' : '';
    if (failed) indicator.className = 'activity-failed';
    const meta = document.createElement('span');
    meta.className = 'activity-meta';
    const starts = items.flatMap(item => item.startedAt ?? []);
    const ends = items.flatMap(item => item.endedAt ?? []);
    if (starts.length && (live || ends.length)) {
      const time = document.createElement('span');
      time.className = 'activity-time';
      const start = Math.min(...starts);
      time.dataset.start = String(start);
      if (!live) time.dataset.end = String(Math.max(...ends));
      meta.append(time);
    }
    meta.append(indicator);
    summary.append(meta);
    summary.addEventListener('click', event => {
      event.preventDefault();
      choice.touched = true;
      choice.open = group.open = !group.open;
    });
    group.append(summary);
    for (const item of items) group.append(renderTool(item));
    return group;
  }

  function reply(item: TextMessage) {
    const message = document.createElement('div');
    message.className = `message ${item.role === 'user' ? 'user' : 'reply'}`;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (item.role === 'user') {
      const label = document.createElement('div');
      label.className = 'role';
      label.textContent = 'You';
      const text = document.createElement('div');
      text.className = 'prompt-text';
      text.textContent = item.text;
      bubble.append(label, text);
    } else {
      bubble.classList.add('markdown');
      bubble.innerHTML = DOMPurify.sanitize(marked.parse(item.text, { async: false }), {
        USE_PROFILES: { html: true }, FORBID_TAGS: ['img', 'style', 'form'],
      });
      for (const code of bubble.querySelectorAll<HTMLElement>('pre code[class*="language-"]')) {
        const language = code.className.match(/language-([^\s]+)/)?.[1];
        if (language && hljs.getLanguage(language)) hljs.highlightElement(code);
      }
      for (const table of bubble.querySelectorAll('table')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'table-scroll';
        table.replaceWith(wrapper);
        wrapper.append(table);
      }
    }
    message.append(bubble);
    return message;
  }

  return (root: HTMLElement, scroller: HTMLElement, messages: DisplayMessage[]) => {
    const follow = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 100;
    const viewportTop = scroller.getBoundingClientRect().top;
    const anchor = !follow && rows.find(({ node }) => node.getBoundingClientRect().bottom > viewportTop);
    const anchorTop = anchor ? anchor.node.getBoundingClientRect().top : 0;
    const old = new Map(rows.map(row => [row.key, row]));
    const next: typeof rows = [];
    const add = (key: string, data: unknown, create: () => HTMLElement) => {
      const value = JSON.stringify(data);
      const previous = old.get(key);
      next.push(previous?.value === value ? previous : { key, value, node: create() });
    };
    const latestTurn = messages.findLastIndex(item => item.role === 'user');
    let tools: ToolMessage[] = [], newest = false;
    function flush() {
      if (!tools.length) return;
      const items = tools;
      add(`tools:${items[0].id}`, [items, newest, localStorage.getItem('pockpi-fold-activity')], () => activity(items, newest));
      tools = [];
    }
    messages.forEach((item, index) => {
      if (item.role === 'tool') { tools.push(item); newest = index > latestTurn; return; }
      flush();
      add(`${item.role}:${index}`, item, () => {
        if (item.role !== 'source') return reply(item);
        const source = document.createElement('div');
        source.className = 'source-label';
        source.textContent = item.via === 'tailscale' ? 'PockPi · Tailscale address' : 'PockPi · local address';
        return source;
      });
    });
    flush();
    const keep = new Set(next.map(row => row.node));
    for (const row of rows) if (!keep.has(row.node)) row.node.remove();
    let cursor = root.firstChild;
    for (const { node } of next) {
      if (node !== cursor) root.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    rows = next;
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    else if (anchor) {
      const node = rows.find(row => row.key === anchor.key)?.node;
      if (node) scroller.scrollTop += node.getBoundingClientRect().top - anchorTop;
    }
  };
})();
