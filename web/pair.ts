{
  const form = document.querySelector<HTMLFormElement>('#pair-form')!;
  const input = document.querySelector<HTMLInputElement>('#code')!;
  const status = document.querySelector('#status')!;
  const button = form.querySelector('button')!;
  const fragment = new URLSearchParams(location.hash.slice(1));
  const scanned = fragment.get('pair');
  if (location.hash) history.replaceState(null, '', location.pathname);
  async function pair(code: string) {
    button.disabled = true;
    status.textContent = 'Pairing…';
    try {
      const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) });
      if (!response.ok) throw new Error(response.status === 401 ? 'This code is invalid or expired. Run /remote pair for a new one.' : 'Could not pair. Run /remote pair for a new code and try again.');
      location.replace('/');
    } catch (error) {
      status.textContent = (error instanceof Error && error.message) || 'Could not connect. Check Tailscale and try again.';
      button.disabled = false;
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void pair(input.value); });
  if (scanned) void pair(scanned);
}
