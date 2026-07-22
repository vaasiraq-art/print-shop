const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openDroppedFiles: (paths) => ipcRenderer.invoke('open-dropped-files', paths),
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch (e) {
      return file.path || null; // fallback for older Electron
    }
  },
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  switchTab: (id) => ipcRenderer.invoke('switch-tab', id),
  closeTab: (id) => ipcRenderer.invoke('close-tab', id),
  duplicateTab: (id) => ipcRenderer.invoke('duplicate-tab', id),
  toggleTabLock: (id) => ipcRenderer.invoke('toggle-tab-lock', id),
  setTabBW: (id, bw) => ipcRenderer.invoke('set-tab-bw', { id, bw }),
  getLanguage: () => ipcRenderer.invoke('get-language'),
  setLanguage: (lang) => ipcRenderer.invoke('set-language', lang),
  setTabPrinter: (id, printer) => ipcRenderer.invoke('set-tab-printer', { id, printer }),
  printTab: (id, options) => ipcRenderer.invoke('print-tab', { id, options }),
  printAllTabs: (jobs) => ipcRenderer.invoke('print-all-tabs', jobs),
  getPresets: () => ipcRenderer.invoke('get-presets'),
  savePreset: (preset) => ipcRenderer.invoke('save-preset', preset),
  deletePreset: (id) => ipcRenderer.invoke('delete-preset', id),
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  getTabsState: () => ipcRenderer.invoke('get-tabs-state'),
  setContentOffset: (px) => ipcRenderer.invoke('set-content-offset', px),
  onTabsUpdated: (cb) => ipcRenderer.on('tabs-updated', (e, data) => cb(data)),
  onTriggerPrintActive: (cb) => ipcRenderer.on('trigger-print-active', () => cb()),
  onTriggerPrintAll: (cb) => ipcRenderer.on('trigger-print-all', () => cb())
});
