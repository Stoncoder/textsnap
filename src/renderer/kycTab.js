// "KYC Extractor" tab: PAN / Aadhaar / Bank passbook details via Claude's vision API.
// Nothing is written to disk; everything lives in memory until "Clear all" or the app closes.
import { kindOf, ext, thumbnailFor, normalizeImage, blobToBase64 } from './files.js';
import { $, toast, icon, setupDropzone, copyWithFeedback } from './ui.js';
import { validateField } from './validate.js';

const MAX_DOCS = 5;
const ALLOWED_EXT = ['jpg', 'jpeg', 'png', 'pdf'];

const DOC_TYPES = {
  PAN: {
    label: 'PAN Card',
    fields: [['name', 'Name'], ['fathers_name', "Father's Name"], ['pan_number', 'PAN Number'], ['date_of_birth', 'Date of Birth']],
  },
  AADHAAR: {
    label: 'Aadhaar Card',
    fields: [['name', 'Name'], ['fathers_name', "Father's Name"], ['aadhaar_number', 'Aadhaar Number'], ['address', 'Address']],
  },
  BANK_PASSBOOK: {
    label: 'Bank Passbook',
    fields: [['account_holder_name', 'Account Holder Name'], ['account_number', 'Account Number'], ['ifsc_code', 'IFSC Code'], ['bank_branch_name', 'Bank / Branch Name']],
  },
};
const MONO_KEYS = new Set(['pan_number', 'aadhaar_number', 'account_number', 'ifsc_code', 'date_of_birth']);

let docs = []; // { id, file, thumb, status, result, card, run }
let nextId = 1;
let runToken = 0;

export function initKycTab({ openSettings }) {
  setupDropzone($('#kycDrop'), $('#kycInput'), addFiles);

  $('#kycRun').addEventListener('click', async () => {
    const st = await window.api.keyStatus();
    if (!st.hasKey) {
      showError('Add your Anthropic API key in Settings to start extracting.');
      openSettings();
      return;
    }
    runAll();
  });
  $('#kycClear').addEventListener('click', clearAll);
}

function showError(msg) {
  const el = $('#kycError');
  el.innerHTML = `${icon('alert')}<span></span>`;
  el.querySelector('span').textContent = msg;
  el.hidden = false;
  // restart the shake animation
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}
const hideError = () => ($('#kycError').hidden = true);

async function addFiles(files) {
  hideError();
  const bad = files.filter((f) => !ALLOWED_EXT.includes(ext(f.name)));
  const good = files.filter((f) => ALLOWED_EXT.includes(ext(f.name)));
  const room = MAX_DOCS - docs.length;
  const take = good.slice(0, Math.max(0, room));
  const skipped = good.length - take.length;

  const problems = [];
  if (skipped > 0) {
    problems.push(
      room <= 0
        ? `You can upload a maximum of ${MAX_DOCS} documents at a time. Remove one to add another.`
        : `You can upload a maximum of ${MAX_DOCS} documents at a time — ${skipped} file${skipped > 1 ? 's were' : ' was'} not added.`
    );
  }
  if (bad.length) problems.push(`Only JPG, PNG or PDF files are supported (${bad.map((f) => f.name).join(', ')}).`);
  if (problems.length) showError(problems.join(' '));

  for (const file of take) {
    const doc = { id: nextId++, file, status: 'ready' };
    docs.push(doc);
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML = `<img alt="" /><div class="t-name"></div><button class="t-remove" title="Remove">${icon('x')}</button>`;
    el.querySelector('.t-name').textContent = file.name;
    el.querySelector('.t-remove').addEventListener('click', () => removeDoc(doc));
    doc.thumbEl = el;
    $('#thumbStrip').append(el);
    try {
      doc.thumb = await thumbnailFor(file);
      el.querySelector('img').src = doc.thumb;
    } catch {
      el.querySelector('img').alt = 'Preview not available';
    }
  }
  updateToolbar();
}

function removeDoc(doc) {
  hideError();
  doc.cancelled = true;
  docs = docs.filter((d) => d !== doc);
  doc.thumbEl?.classList.add('leaving');
  setTimeout(() => doc.thumbEl?.remove(), 280);
  doc.card?.remove();
  if (doc.thumb) setTimeout(() => URL.revokeObjectURL(doc.thumb), 400);
  updateToolbar();
}

function clearAll() {
  runToken++;
  for (const d of docs) {
    d.cancelled = true;
    if (d.thumb) URL.revokeObjectURL(d.thumb);
    d.result = null;
  }
  docs = [];
  $('#thumbStrip').innerHTML = '';
  $('#kycResults').innerHTML = '';
  hideError();
  updateToolbar();
  toast('All documents and results deleted');
}

function updateToolbar() {
  $('#kycToolbar').hidden = docs.length === 0;
  const pending = docs.filter((d) => d.status === 'ready' || d.status === 'error').length;
  const busy = docs.some((d) => d.status === 'processing');
  const btn = $('#kycRun');
  btn.disabled = busy || pending === 0;
  btn.querySelector('span').textContent = busy ? 'Extracting…' : pending && pending < docs.length ? `Extract ${pending} new` : 'Extract details';
}

async function runAll() {
  hideError();
  const token = runToken;
  const doubleCheck = $('#doubleCheck').checked;
  const todo = docs.filter((d) => d.status === 'ready' || d.status === 'error');
  for (const d of todo) {
    d.status = 'processing';
    renderProcessingCard(d);
  }
  updateToolbar();
  await Promise.all(todo.map((d) => processDoc(d, doubleCheck, token)));
  updateToolbar();
}

async function processDoc(doc, doubleCheck, token) {
  let res;
  try {
    const payload = await preparePayload(doc.file);
    res = await window.api.kycExtract({ ...payload, doubleCheck });
  } catch (err) {
    res = { ok: false, error: err.message || 'Could not read this file.' };
  }
  if (doc.cancelled || token !== runToken) return;
  if (!res.ok) {
    doc.status = 'error';
    renderErrorCard(doc, res.error);
    if (res.code === 'NO_KEY') showError(res.error);
    return;
  }
  doc.status = 'done';
  doc.result = res.result;
  renderResultCard(doc);
}

// Images are re-drawn upright (phone rotation) and kept under the API's size limit.
async function preparePayload(file) {
  if (kindOf(file) === 'pdf') {
    if (file.size > 30 * 1024 * 1024) throw new Error('This PDF is larger than 30 MB. Please use a smaller file.');
    return { mediaType: 'application/pdf', base64: await blobToBase64(file) };
  }
  for (const [maxSide, quality] of [[2600, 0.95], [2200, 0.9], [1800, 0.85]]) {
    const blob = await normalizeImage(file, { maxSide, minSide: 0, type: 'image/jpeg', quality });
    if (!blob) throw new Error('This image could not be opened. Try saving it as JPG or PNG.');
    if (blob.size < 3.6 * 1024 * 1024) return { mediaType: 'image/jpeg', base64: await blobToBase64(blob) };
  }
  throw new Error('This image is too large. Please use a smaller photo.');
}

// ---------- Cards ----------
function cardShell(doc) {
  const card = doc.card || document.createElement('article');
  card.className = 'doc-card';
  card.innerHTML = `
    <div class="doc-media"><img alt="" /></div>
    <div class="doc-body"></div>`;
  const img = card.querySelector('img');
  if (doc.thumb) img.src = doc.thumb;
  img.alt = doc.file.name;
  if (!doc.card) {
    doc.card = card;
    $('#kycResults').append(card);
  }
  return card;
}

function renderProcessingCard(doc) {
  const card = cardShell(doc);
  card.querySelector('.doc-media').insertAdjacentHTML('beforeend', '<div class="scan-tint"></div><div class="scan-line"></div>');
  const body = card.querySelector('.doc-body');
  body.innerHTML = `
    <div class="doc-head"><div class="skeleton badge"></div><span class="doc-file"></span></div>
    <div class="fields">${'<div><div class="skeleton label"></div><div class="skeleton"></div></div>'.repeat(4)}</div>`;
  body.querySelector('.doc-file').textContent = `Scanning ${doc.file.name}…`;
}

function renderErrorCard(doc, message) {
  const card = cardShell(doc);
  const body = card.querySelector('.doc-body');
  body.innerHTML = `
    <div class="doc-head"><span class="doc-type unknown">${icon('alert')} Not processed</span><span class="doc-file"></span></div>
    <div class="doc-error"></div>
    <div class="doc-actions"><button class="ghost-btn retry">Try again</button></div>`;
  body.querySelector('.doc-file').textContent = doc.file.name;
  body.querySelector('.doc-error').textContent = message;
  body.querySelector('.retry').addEventListener('click', () => {
    doc.status = 'processing';
    renderProcessingCard(doc);
    updateToolbar();
    processDoc(doc, $('#doubleCheck').checked, runToken).then(updateToolbar);
  });
}

function renderResultCard(doc) {
  const card = cardShell(doc);
  const body = card.querySelector('.doc-body');
  const { document_type: type, fields = {}, note } = doc.result;
  const spec = DOC_TYPES[type];

  if (!spec) {
    body.innerHTML = `
      <div class="doc-head"><span class="doc-type unknown">${icon('question')} Unknown document</span><span class="doc-file"></span></div>
      <div class="doc-note"></div>`;
    body.querySelector('.doc-file').textContent = doc.file.name;
    body.querySelector('.doc-note').textContent =
      (note ? note + ' ' : '') + 'This does not look like a PAN card, Aadhaar card or bank passbook, so nothing was extracted. Try a clearer photo of the full document.';
    return;
  }

  const anyUnreadable = spec.fields.some(([k]) => (fields[k]?.value ?? 'UNREADABLE') === 'UNREADABLE');
  body.innerHTML = `
    <div class="doc-head">
      <span class="doc-type">${spec.label}</span>
      <span class="doc-file"></span>
      <span class="status-badge ${anyUnreadable ? 'warn' : 'ok'}" title="${anyUnreadable ? 'Some fields could not be read' : 'Extracted'}">${anyUnreadable ? icon('alert') : icon('check')}</span>
    </div>
    <div class="fields"></div>
    <div class="doc-actions"><button class="ghost-btn copy-all">${icon('copy')}<span>Copy all fields</span></button></div>`;
  body.querySelector('.doc-file').textContent = doc.file.name;
  const list = body.querySelector('.fields');

  const state = spec.fields.map(([key, label]) => {
    const f = fields[key] || { value: 'UNREADABLE', confidence: 'Low' };
    return { key, label, value: f.value, confidence: f.confidence, mismatch: !!f.mismatch, edited: false };
  });

  state.forEach((f, i) => list.append(buildField(f, i)));

  body.querySelector('.copy-all').addEventListener('click', (e) => {
    const text = `${spec.label}\n` + state.map((f) => `${f.label}: ${f.value}`).join('\n');
    copyWithFeedback(e.currentTarget, text, 'All fields copied');
  });
}

const maskAadhaar = (v) => {
  const digits = v.replace(/\D/g, '');
  return digits.length >= 4 ? `XXXX XXXX ${digits.slice(-4)}` : v;
};

function buildField(f, index) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.style.animationDelay = `${index * 160}ms`;
  const multiline = f.key === 'address' || f.key === 'bank_branch_name';
  const isAadhaar = f.key === 'aadhaar_number';
  wrap.innerHTML = `
    <div class="field-top">
      <span class="field-name"></span>
      <span class="conf"></span>
      <span class="verify" hidden>${icon('alert')}<span>Please verify</span></span>
    </div>
    <div class="field-row">
      ${multiline ? '<textarea class="field-input" rows="1"></textarea>' : '<input class="field-input" type="text" />'}
      ${isAadhaar ? `<button class="mini-btn reveal" title="Show full number">${icon('eye')}<span>Show</span></button>` : ''}
      <button class="mini-btn copy" title="Copy">${icon('copy')}</button>
    </div>`;
  wrap.querySelector('.field-name').textContent = f.label;
  const input = wrap.querySelector('.field-input');
  if (MONO_KEYS.has(f.key)) input.classList.add('mono');
  input.spellcheck = false;

  let masked = isAadhaar;
  const special = () => f.value === 'UNREADABLE' || f.value === 'NOT FOUND';
  const display = () => (masked && !special() ? maskAadhaar(f.value) : f.value);
  const autosize = () => {
    if (multiline) { input.style.height = 'auto'; input.style.height = `${input.scrollHeight + 2}px`; }
  };

  const refresh = () => {
    wrap.classList.toggle('unreadable', f.value === 'UNREADABLE');
    wrap.classList.toggle('notfound', f.value === 'NOT FOUND');
    const conf = wrap.querySelector('.conf');
    if (f.edited) { conf.className = 'conf high'; conf.textContent = 'Edited'; }
    else { conf.className = `conf ${f.confidence === 'High' ? 'high' : 'low'}`; conf.textContent = `${f.confidence} confidence`; }
    const v = validateField(f.key, f.value);
    const reasons = [];
    if (!v.ok) reasons.push(v.reason);
    if (f.mismatch && !f.edited) reasons.push('The two independent reads did not match. Compare with the image.');
    const verify = wrap.querySelector('.verify');
    verify.hidden = reasons.length === 0;
    verify.title = reasons.join(' ');
    wrap.classList.toggle('needs-verify', reasons.length > 0 && !special());
    input.readOnly = masked && !special();
  };

  input.addEventListener('input', () => {
    f.value = input.value;
    f.edited = true;
    refresh();
    autosize();
  });

  if (isAadhaar) {
    const btn = wrap.querySelector('.reveal');
    btn.addEventListener('click', () => {
      masked = !masked;
      input.dataset.userTouched = '1'; // stop the typing animation
      btn.innerHTML = masked ? `${icon('eye')}<span>Show</span>` : `${icon('eyeOff')}<span>Hide</span>`;
      btn.title = masked ? 'Show full number' : 'Hide number';
      input.value = display();
      refresh();
    });
  }

  wrap.querySelector('.copy').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    await window.api.copy(f.value);
    b.classList.add('copied');
    b.innerHTML = icon('check');
    toast(`${f.label} copied`);
    setTimeout(() => { b.classList.remove('copied'); b.innerHTML = icon('copy'); }, 1400);
  });

  refresh();
  typeInto(input, display(), index * 160 + 120, autosize);
  return wrap;
}

// Types the value in, character by character, for a "being read" feel.
function typeInto(input, text, delay, after) {
  input.value = '';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { input.value = text; after?.(); return; }
  const step = Math.max(1, Math.ceil(text.length / 24));
  setTimeout(() => {
    let i = 0;
    const tick = () => {
      if (input.dataset.userTouched) return;
      i = Math.min(text.length, i + step);
      input.value = text.slice(0, i);
      after?.();
      if (i < text.length) requestAnimationFrame(() => setTimeout(tick, 16));
    };
    tick();
  }, delay);
  input.addEventListener('focus', () => {
    if (input.dataset.userTouched) return;
    input.dataset.userTouched = '1';
    input.value = text;
    after?.();
  }, { once: true });
}
