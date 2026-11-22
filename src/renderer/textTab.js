// "Extract Text" tab: any file in, plain text out. Fully offline.
import { kindOf, ext, openPdf, pdfPageText, renderPdfPage, normalizeImage, htmlToText, rtfToText, formatBytes } from './files.js';
import { $, toast, copyWithFeedback, icon, setupDropzone } from './ui.js';

const items = []; // { id, file, kind, status, text, error, progress, label, el }
let selectedId = null;
let running = false;
let nextId = 1;

export function initTextTab() {
  const drop = $('#textDrop');
  setupDropzone(drop, $('#textInput'), addFiles);

  // Paste a screenshot or copied image straight in.
  window.addEventListener('paste', (e) => {
    if (!$('#panel-text').classList.contains('active')) return;
    if (e.target.closest('textarea:not([readonly]), input')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Pasted image ${i + 1}.png`, { type: f.type || 'image/png' }))));
    }
  });

  window.api.languages().then((langs) => {
    const sel = $('#langSelect');
    sel.innerHTML = '';
    const multi = [
      { code: 'eng', label: 'English' },
      { code: 'eng+hin', label: 'English + Hindi' },
    ];
    const g1 = document.createElement('optgroup');
    g1.label = 'Popular';
    for (const m of multi) g1.append(new Option(m.label, m.code));
    const g2 = document.createElement('optgroup');
    g2.label = 'More languages (downloaded once when first used)';
    for (const l of langs.filter((l) => l.code !== 'eng')) g2.append(new Option(l.name + (l.installed ? '' : ' ↓'), l.code));
    sel.append(g1, g2);
    try { sel.value = localStorage.getItem('ocrLang') || 'eng'; } catch {}
    if (!sel.value) sel.value = 'eng';
  });
  $('#langSelect').addEventListener('change', (e) => { try { localStorage.setItem('ocrLang', e.target.value); } catch {} });

  window.api.onOcrProgress(({ jobId, status, progress }) => {
    const it = items.find((x) => x.activeJob === jobId);
    if (!it) return;
    it.label = it.pageInfo ? `${it.pageInfo} · ${status}` : status;
    it.progress = it.pageBase + (progress || 0) * it.pageSpan;
    renderItem(it);
    if (it.id === selectedId) showProgress(it);
  });

  const out = $('#output');
  out.addEventListener('input', () => {
    const it = items.find((x) => x.id === selectedId);
    if (it) it.text = out.value;
    updateStats();
  });

  $('#copyBtn').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, out.value, 'Copied! Paste it anywhere.'));
  $('#copyAllBtn').addEventListener('click', () => {
    const all = items.filter((x) => x.status === 'done').map((x) => `===== ${x.file.name} =====\n${x.text}`).join('\n\n');
    window.api.copy(all).then(() => toast('Copied text from all files'));
  });
  $('#saveBtn').addEventListener('click', async () => {
    const it = items.find((x) => x.id === selectedId);
    if (await window.api.saveText(out.value, it?.file.name)) toast('Saved');
  });
  $('#clearText').addEventListener('click', () => {
    items.splice(0).forEach((x) => (x.cancelled = true));
    selectedId = null;
    $('#queue').innerHTML = '';
    showSelected();
  });
}

function addFiles(files) {
  let added = 0;
  for (const file of files) {
    const kind = kindOf(file);
    if (kind === 'unsupported') {
      toast(`"${file.name}" isn't a supported file type`);
      continue;
    }
    const it = { id: nextId++, file, kind, status: 'waiting', text: '', progress: 0, label: 'Waiting…', pageBase: 0, pageSpan: 1 };
    items.push(it);
    $('#queue').append(buildItem(it));
    added++;
    if (!selectedId) selectedId = it.id;
  }
  if (added) {
    if (!items.find((x) => x.id === selectedId)) selectedId = items[0].id;
    showSelected();
    run();
  }
}

function buildItem(it) {
  const li = document.createElement('li');
  li.className = 'q-item';
  const badge = { image: ['img', ext(it.file.name).toUpperCase().slice(0, 4) || 'IMG'], pdf: ['pdf', 'PDF'], docx: ['doc', 'DOC'] }[it.kind] || ['txt', 'TXT'];
  li.innerHTML = `
    <div class="q-icon ${badge[0]}">${badge[1]}</div>
    <div class="q-main">
      <div class="q-name"></div>
      <div class="q-status"></div>
      <div class="q-bar"><i></i></div>
    </div>
    <button class="q-remove" title="Remove">${icon('x')}</button>`;
  li.querySelector('.q-name').textContent = it.file.name;
  li.title = `${it.file.name} · ${formatBytes(it.file.size)}`;
  li.addEventListener('click', () => { selectedId = it.id; showSelected(); });
  li.querySelector('.q-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    it.cancelled = true;
    items.splice(items.indexOf(it), 1);
    li.remove();
    if (selectedId === it.id) selectedId = items[0]?.id ?? null;
    showSelected();
  });
  it.el = li;
  renderItem(it);
  return li;
}

function renderItem(it) {
  if (!it.el) return;
  const st = it.el.querySelector('.q-status');
  const bar = it.el.querySelector('.q-bar');
  st.className = 'q-status' + (it.status === 'done' ? ' ok' : it.status === 'error' ? ' err' : '');
  if (it.status === 'done') {
    const words = countWords(it.text);
    st.textContent = words ? `✓ ${words.toLocaleString()} words${it.method ? ' · ' + it.method : ''}` : '✓ No text found';
  } else if (it.status === 'error') st.textContent = it.error;
  else st.textContent = it.label;
  bar.hidden = it.status !== 'working';
  bar.querySelector('i').style.width = `${Math.round((it.progress || 0) * 100)}%`;
  it.el.classList.toggle('selected', it.id === selectedId);
}

async function run() {
  if (running) return;
  running = true;
  try {
    let it;
    while ((it = items.find((x) => x.status === 'waiting'))) {
      it.status = 'working';
      it.label = 'Opening…';
      renderItem(it);
      if (it.id === selectedId) showSelected();
      try {
        it.text = await extract(it);
        if (it.cancelled) continue;
        it.status = 'done';
      } catch (err) {
        if (it.cancelled) continue;
        it.status = 'error';
        it.error = err?.message || 'Something went wrong';
      }
      renderItem(it);
      if (it.id === selectedId) showSelected();
    }
  } finally {
    running = false;
  }
}

async function ocrBlob(it, blob, langs) {
  it.activeJob = `${it.id}-${Math.random().toString(36).slice(2)}`;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const r = await window.api.ocrImage(bytes, langs, it.activeJob);
  return r.text;
}

async function extract(it) {
  const { file, kind } = it;
  const langs = $('#langSelect').value.split('+');
  if (kind === 'text') return (await file.text()).trim();
  if (kind === 'html') return htmlToText(await file.text());
  if (kind === 'rtf') return rtfToText(await file.text());
  if (kind === 'docx') {
    it.method = 'Word document';
    return window.api.docxText(new Uint8Array(await file.arrayBuffer()));
  }
  if (kind === 'image') {
    it.method = 'OCR';
    const blob = (await normalizeImage(file)) || file; // TIFF etc. go straight to the OCR engine
    return ocrBlob(it, blob, langs);
  }
  // PDF: use the text stored in the PDF; fall back to OCR for scanned pages.
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
  try {
    const force = $('#forceOcr').checked;
    const parts = [];
    let ocrPages = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      if (it.cancelled) break;
      it.pageInfo = doc.numPages > 1 ? `Page ${p} of ${doc.numPages}` : '';
      it.pageBase = (p - 1) / doc.numPages;
      it.pageSpan = 1 / doc.numPages;
      it.progress = it.pageBase;
      it.label = it.pageInfo || 'Reading page…';
      renderItem(it);
      if (it.id === selectedId) showProgress(it);
      const page = await doc.getPage(p);
      let text = force ? '' : await pdfPageText(page);
      if (text.replace(/\s/g, '').length < 25) {
        const img = await renderPdfPage(page, 2.5);
        text = await ocrBlob(it, img, langs);
        ocrPages++;
      }
      page.cleanup();
      parts.push(doc.numPages > 1 ? `— Page ${p} —\n${text}` : text);
    }
    it.method = ocrPages === 0 ? `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}` : `${doc.numPages} page${doc.numPages > 1 ? 's' : ''}, ${ocrPages} scanned`;
    return parts.join('\n\n').trim();
  } finally {
    doc.loadingTask.destroy();
  }
}

function showProgress(it) {
  const ov = $('#progressOverlay');
  ov.hidden = false;
  const pct = Math.round((it.progress || 0) * 100);
  $('#ringPct').textContent = `${pct}%`;
  $('#ringFg').style.strokeDashoffset = String(213.6 * (1 - (it.progress || 0)));
  $('#progressLabel').textContent = it.label || 'Reading…';
}

function showSelected() {
  const it = items.find((x) => x.id === selectedId);
  items.forEach(renderItem);
  $('#queueHead').hidden = items.length === 0;
  const out = $('#output');
  const done = it?.status === 'done';
  $('#emptyState').hidden = !!it;
  $('#progressOverlay').hidden = true;
  out.readOnly = !done;
  out.value = done ? it.text : '';
  out.placeholder = done && !it.text ? 'No text was found in this file. If it is a photo, try a sharper, well-lit picture.' : '';
  $('#copyBtn').disabled = !done || !it.text;
  $('#saveBtn').disabled = !done || !it.text;
  const doneCount = items.filter((x) => x.status === 'done').length;
  $('#copyAllBtn').hidden = doneCount < 2;
  $('#copyAllBtn').disabled = doneCount < 2;

  if (!it) {
    $('#resultTitle').textContent = 'Your text will appear here';
    $('#resultMeta').textContent = 'Add a file to get started — it takes just a few seconds.';
  } else {
    $('#resultTitle').textContent = it.file.name;
    $('#resultMeta').textContent =
      it.status === 'done' ? `Done${it.method ? ' · ' + it.method : ''} · you can edit the text below`
      : it.status === 'error' ? it.error
      : it.status === 'waiting' ? 'Waiting in line…' : 'Working on it…';
    if (it.status === 'working' || it.status === 'waiting') showProgress(it);
  }
  updateStats();
}

const countWords = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
function updateStats() {
  const t = $('#output').value;
  $('#stats').textContent = `${countWords(t).toLocaleString()} words · ${t.length.toLocaleString()} characters`;
}
