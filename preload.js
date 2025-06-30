const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  setUploadUrl: (url) => ipcRenderer.send('set-upload-url', url),
  hideWindow: () => ipcRenderer.send('hide-window')
});

contextBridge.exposeInMainWorld('electronAPI', {
  onVersionMismatch: (callback) => ipcRenderer.on('version-mismatch', callback)
});
