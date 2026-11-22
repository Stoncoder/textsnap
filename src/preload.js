const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  languages: () => ipcRenderer.invoke('ocr:languages'),
  ocrImage: (bytes, langs, jobId) => ipcRenderer.invoke('ocr:image', { bytes, langs, jobId }),
  onOcrProgress: (cb) => {
    const listener = (_e, msg) => cb(msg);
    ipcRenderer.on('ocr:progress', listener);
    return () => ipcRenderer.removeListener('ocr:progress', listener);
  },
  docxText: (bytes) => ipcRenderer.invoke('docx:text', { bytes }),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  saveText: (text, name) => ipcRenderer.invoke('file:save-text', { text, name }),
  keyStatus: () => ipcRenderer.invoke('settings:key-status'),
  setKey: (key) => ipcRenderer.invoke('settings:set-key', key),
  clearKey: () => ipcRenderer.invoke('settings:clear-key'),
  kycExtract: (payload) => ipcRenderer.invoke('kyc:extract', payload),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
});
