// "Extract Text" tab: any file in, plain text out. Fully offline.
import { kindOf, ext, openPdf, pdfPageText, renderPdfPage, normalizeImage, htmlToText, rtfToText, formatBytes, canvasToBlob, rotateBitmap } from './files.js';
import { cleanLines, toPlainText, formatFields, mrzLinesFrom, readMrz } from './format.js';
import { $, toast, copyWithFeedback, icon, setupDropzone, snapshotFiles } from './ui.js';

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
      const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `Pasted image ${i + 1}.png`, { type: f.type || 'image/png' })));
      snapshotFiles(named).then((ready) => ready.length && addFiles(ready));
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
    if (it) {
      if (showingFormatted(it)) it.formatted = out.value;
      else it.text = out.value;
    }
    updateStats();
  });

  document.querySelectorAll('#viewSeg button').forEach((b) =>
    b.addEventListener('click', () => {
      const it = items.find((x) => x.id === selectedId);
      if (!it) return;
      it.view = b.dataset.view;
      showSelected();
    })
  );

  $('#copyBtn').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, out.value, 'Copied! Paste it anywhere.'));
  $('#copyAllBtn').addEventListener('click', () => {
    const all = items.filter((x) => x.status === 'done').map((x) => `===== ${x.file.name} =====\n${viewText(x)}`).join('\n\n');
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

// OCR one image and return clean plain text, plus a "Field: value" layout when the
// picture is an ID card / form, and the decoded passport machine-readable zone (MRZ).
async function ocrBlob(it, blob, langs) {
  it.activeJob = `${it.id}-${Math.random().toString(36).slice(2)}`;
  const read = async (b) => (await window.api.ocrLines(new Uint8Array(await b.arrayBuffer()), langs, it.activeJob)).lines || [];
  let lines = await read(blob);

  // Photo taken sideways or upside down? If hardly anything readable came out,
  // try the other three orientations and keep the one that reads best.
  if (readability(lines) < 60) {
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      /* format the browser can't draw (e.g. TIFF): keep the first result */
    }
    if (bitmap) {
      try {
        let best = { score: readability(lines), lines, blob };
        for (const angle of [90, 270, 180]) {
          it.label = 'Checking if the picture is sideways…';
          const turned = await rotateBitmap(bitmap, angle);
          const l = await read(turned);
          const score = readability(l);
          if (score > best.score) best = { score, lines: l, blob: turned };
          if (score >= 150) break; // clearly readable now
        }
        ({ lines, blob } = best);
      } finally {
        bitmap.close();
      }
    }
  }

  const clean = cleanLines(lines);
  const plain = toPlainText(clean);
  let formatted = formatFields(clean);

  const firstMrz = mrzLinesFrom(clean);
  if (firstMrz.length) {
    let secondMrz = [];
    try {
      const mrzRows = clean.filter((l) => l.mrz);
      it.label = 'Reading the machine-readable zone…';
      // Two differently prepared crops; the reader keeps whichever passes its check digits.
      for (const variant of [
        { width: 2400, filter: 'grayscale(1) contrast(1.6)' },
        { width: 1600, filter: 'grayscale(1) contrast(2.2) brightness(1.1)' },
      ]) {
        const crop = await cropForMrz(blob, mrzRows, variant);
        if (!crop) break;
        const r2 = await window.api.ocrLines(new Uint8Array(await crop.arrayBuffer()), ['eng'], it.activeJob, {
          whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',
          psm: '6',
        });
        secondMrz.push(...mrzLinesFrom(r2.lines || []));
      }
    } catch {
      /* second pass is a bonus; ignore failures */
    }
    const mrz = readMrz(secondMrz, firstMrz);
    if (mrz) formatted = `${formatted || plain}\n\n${mrz}`;
  }
  return { plain, formatted };
}

// How much clearly-read text there is: letters in confident words of 3+ characters.
function readability(lines) {
  let n = 0;
  for (const l of lines)
    for (const w of l.words || []) if (w.conf >= 80 && (w.text.match(/[\p{L}\p{N}]/gu) || []).length >= 3) n += w.text.length;
  return n;
}

// Cuts out the MRZ strip, enlarged and in high-contrast grey, for a second, stricter read.
async function cropForMrz(blob, rows, { width = 2400, filter = 'grayscale(1) contrast(1.6)' } = {}) {
  if (!rows.length) return null;
  const bmp = await createImageBitmap(blob);
  try {
    const pad = 12;
    const x0 = Math.max(0, Math.min(...rows.map((l) => l.box.x0)) - pad * 3);
    const y0 = Math.max(0, Math.min(...rows.map((l) => l.box.y0)) - pad);
    const x1 = Math.min(bmp.width, Math.max(...rows.map((l) => l.box.x1)) + pad * 3);
    const y1 = Math.min(bmp.height, Math.max(...rows.map((l) => l.box.y1)) + pad);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w < 50 || h < 10) return null;
    const scale = Math.min(3, Math.max(1, width / w));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d');
    ctx.filter = filter;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, x0, y0, w, h, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas, 'image/png');
  } finally {
    bmp.close();
  }
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
    const r = await ocrBlob(it, blob, langs);
    it.formatted = r.formatted;
    return r.plain;
  }
  // PDF: use the text stored in the PDF; fall back to OCR for scanned pages.
  const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
  try {
    const force = $('#forceOcr').checked;
    const parts = [];
    const formattedParts = [];
    let anyFormatted = false;
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
      let formatted = null;
      if (text.replace(/\s/g, '').length < 25) {
        const img = await renderPdfPage(page, 2.5);
        ({ plain: text, formatted } = await ocrBlob(it, img, langs));
        ocrPages++;
      }
      page.cleanup();
      const head = doc.numPages > 1 ? `— Page ${p} —\n` : '';
      parts.push(head + text);
      formattedParts.push(head + (formatted || text));
      if (formatted) anyFormatted = true;
    }
    it.formatted = anyFormatted ? formattedParts.join('\n\n').trim() : null;
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
  out.value = done ? viewText(it) : '';
  out.placeholder = done && !it.text ? 'No text was found in this file. If it is a photo, try a sharper, well-lit picture.' : '';
  $('#copyBtn').disabled = !done || !out.value;
  $('#saveBtn').disabled = !done || !out.value;
  const seg = $('#viewSeg');
  seg.hidden = !(done && it.formatted);
  if (!seg.hidden) {
    const view = showingFormatted(it) ? 'formatted' : 'plain';
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.view === view)));
  }
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

// Formatted view (Field: value) is shown by default whenever the app could build one.
const showingFormatted = (it) => !!it.formatted && it.view !== 'plain';
const viewText = (it) => (showingFormatted(it) ? it.formatted : it.text);

const countWords = (t) => (t.trim() ? t.trim().split(/\s+/).length : 0);
function updateStats() {
  const t = $('#output').value;
  $('#stats').textContent = `${countWords(t).toLocaleString()} words · ${t.length.toLocaleString()} characters`;
}
