// Small shared UI helpers.
export const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/><path d="M10.3 3.9 2.4 17.6A2 2 0 0 0 4.1 20.6h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A16.8 16.8 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  question:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.5"/></svg>',
};
export const icon = (name) => ICONS[name] || '';

let toastTimer;
export function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), Math.max(2200, msg.length * 55));
}

export async function copyWithFeedback(btn, text, message = 'Copied') {
  await window.api.copy(text);
  toast(message);
  btn.classList.add(btn.classList.contains('primary-btn') ? 'done' : 'copied');
  const span = btn.querySelector('span');
  const prev = span?.textContent;
  if (span) span.textContent = 'Copied!';
  setTimeout(() => {
    btn.classList.remove('done', 'copied');
    if (span) span.textContent = prev;
  }, 1500);
}

// Copies dropped/pasted files into memory straight away. Some apps (WhatsApp, Messages,
// Photos, browsers) hand over a temporary file that disappears a moment later, which
// made reading it fail with "the requested file could not be read".
export async function snapshotFiles(files) {
  const ok = [];
  const failed = [];
  await Promise.all(
    files.map(async (f) => {
      try {
        const bytes = await f.arrayBuffer();
        ok.push(new File([bytes], f.name || 'Pasted image.png', { type: f.type, lastModified: f.lastModified }));
      } catch {
        failed.push(f.name || 'file');
      }
    })
  );
  // keep the user's original order
  ok.sort((a, b) => files.findIndex((f) => f.name === a.name) - files.findIndex((f) => f.name === b.name));
  if (failed.length) {
    toast(
      `Couldn't open ${failed.length === 1 ? `"${failed[0]}"` : `${failed.length} files`}. ` +
        'If you dragged it from WhatsApp, Photos or a browser, save it to your computer first, then add that file.'
    );
  }
  return ok;
}

// Click-to-choose + drag-and-drop with a glow while dragging.
export function setupDropzone(zone, input, onFilesRaw) {
  const onFiles = async (files) => {
    const ready = await snapshotFiles(files);
    if (ready.length) onFilesRaw(ready);
  };
  let depth = 0;
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => {
    if (input.files.length) onFiles([...input.files]);
    input.value = '';
  });
  zone.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('drag'); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('drag'); } });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('drag');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  });
}
