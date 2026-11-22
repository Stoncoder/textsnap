const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');
const { OcrEngine } = require('./ocr');
const { KycExtractor, keyFingerprint } = require('./kyc');

const isMac = process.platform === 'darwin';
let win;
let ocr;

// ---------- API key storage (encrypted with the OS keychain) ----------
const keyFile = () => path.join(app.getPath('userData'), 'anthropic-key.bin');
function readApiKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const buf = fs.readFileSync(keyFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return '';
  }
}
function writeApiKey(key) {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key, 'utf8');
  fs.writeFileSync(keyFile(), data, { mode: 0o600 });
}

// ---------- Window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 920,
    minHeight: 640,
    show: false,
    title: 'TextSnap',
    backgroundColor: '#0f1020',
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 18, y: 20 },
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { platform: process.platform } });
  win.once('ready-to-show', () => win.show());

  // Open external links in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- IPC ----------
function registerIpc() {
  const kyc = new KycExtractor(readApiKey);

  ipcMain.handle('ocr:languages', () => ocr.languages());

  ipcMain.handle('ocr:image', async (event, { bytes, langs, jobId }) => {
    const send = (msg) => !event.sender.isDestroyed() && event.sender.send('ocr:progress', { jobId, ...msg });
    return ocr.recognize(bytes, langs, send);
  });

  ipcMain.handle('docx:text', async (_e, { bytes }) => {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return value.replace(/\n{3,}/g, '\n\n').trim();
  });

  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  ipcMain.handle('file:save-text', async (_e, { text, name }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Save text',
      defaultPath: (name || 'extracted-text').replace(/\.[^.]+$/, '') + '.txt',
      filters: [{ name: 'Text file', extensions: ['txt'] }],
    });
    if (canceled || !filePath) return false;
    fs.writeFileSync(filePath, text, 'utf8');
    return true;
  });

  ipcMain.handle('settings:key-status', () => {
    const k = readApiKey();
    return { hasKey: !!k, hint: keyFingerprint(k), fromEnv: !!process.env.ANTHROPIC_API_KEY };
  });
  ipcMain.handle('settings:set-key', (_e, key) => {
    const clean = String(key || '').trim();
    if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(clean)) throw new Error('That does not look like an Anthropic API key (it should start with "sk-ant-").');
    writeApiKey(clean);
    return { hasKey: true, hint: keyFingerprint(clean) };
  });
  ipcMain.handle('settings:clear-key', () => {
    fs.rmSync(keyFile(), { force: true });
    return { hasKey: false };
  });

  ipcMain.handle('kyc:extract', async (_e, payload) => {
    try {
      return { ok: true, result: await kyc.extract(payload) };
    } catch (err) {
      return { ok: false, error: err.message, code: err.code };
    }
  });

  ipcMain.handle('app:open-external', (_e, url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
}

app.whenReady().then(() => {
  ocr = new OcrEngine(app.getPath('userData'));
  buildMenu();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (!isMac) app.quit();
});

app.on('before-quit', () => {
  if (ocr) ocr.dispose();
});
