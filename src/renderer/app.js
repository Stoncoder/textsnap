import { $, toast } from './ui.js';
import { initTextTab } from './textTab.js';
import { initKycTab } from './kycTab.js';

const isMac = window.api.platform === 'darwin';
document.body.classList.toggle('mac', isMac);
$('#pasteKey').textContent = isMac ? '⌘' : 'Ctrl';

// ---------- Theme ----------
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => {
  const t = store.get('theme') || (systemDark.matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = t;
};
applyTheme();
systemDark.addEventListener('change', () => { if (!store.get('theme')) applyTheme(); });
$('#themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  store.set('theme', next);
  applyTheme();
});

// ---------- Tabs ----------
const tabs = [...document.querySelectorAll('.tab')];
const glider = $('.tab-glider');
function moveGlider(tab) {
  glider.style.width = `${tab.offsetWidth}px`;
  glider.style.transform = `translateX(${tab.offsetLeft - 4}px)`;
}
function selectTab(name) {
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', String(on));
    if (on) moveGlider(t);
  }
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
  store.set('tab', name);
}
tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
window.addEventListener('resize', () => moveGlider($('.tab.active')));
requestAnimationFrame(() => selectTab(store.get('tab') || 'text'));

// Stop files dropped outside a drop area from opening in the window.
['dragover', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => e.preventDefault()));

// ---------- Settings ----------
const dlg = $('#settingsDialog');
async function refreshKey() {
  const st = await window.api.keyStatus();
  window.dispatchEvent(new CustomEvent('keystatus', { detail: st }));
  const ks = $('#keyStatus');
  ks.className = `key-status ${st.hasKey ? 'ok' : ''}`;
  ks.textContent = st.hasKey ? `✓ Key saved (${st.hint})${st.fromEnv ? ' — from ANTHROPIC_API_KEY' : ''}` : 'No key saved yet.';
  $('#removeKey').disabled = !st.hasKey || st.fromEnv;
}
function openSettings() {
  refreshKey();
  $('#apiKey').value = '';
  dlg.showModal();
  setTimeout(() => $('#apiKey').focus(), 50);
}
$('#settingsBtn').addEventListener('click', openSettings);
$('#keyPill').addEventListener('click', openSettings);
$('#saveKey').addEventListener('click', async () => {
  const ks = $('#keyStatus');
  try {
    await window.api.setKey($('#apiKey').value);
    $('#apiKey').value = '';
    await refreshKey();
    toast('API key saved');
  } catch (err) {
    ks.className = 'key-status err';
    ks.textContent = String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
});
$('#apiKey').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#saveKey').click(); } });
$('#removeKey').addEventListener('click', async () => {
  await window.api.clearKey();
  await refreshKey();
  toast('API key removed');
});
document.querySelectorAll('[data-href]').forEach((a) =>
  a.addEventListener('click', (e) => { e.preventDefault(); window.api.openExternal(a.dataset.href); })
);

refreshKey();
initTextTab();
initKycTab({ openSettings });
