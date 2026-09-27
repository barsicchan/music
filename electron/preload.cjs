// preload: безопасно пробрасываем в панель управление окном (кастомная шапка)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('winctl', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maxtoggle: () => ipcRenderer.send('win-maxtoggle'),
  close: () => ipcRenderer.send('win-close'),
});
