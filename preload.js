const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  setUploadUrl: (url) => ipcRenderer.send('set-upload-url', url),
  hideWindow: () => ipcRenderer.send('hide-window')
});

contextBridge.exposeInMainWorld('electronAPI', {
  onVersionMismatch: (callback) => ipcRenderer.on('version-mismatch', callback),
  onRouterList: (cb) => ipcRenderer.on('router-list', (_, data, routerAddress) => cb(data, routerAddress)),
  selectRouter: (ip) => ipcRenderer.send('select-router', ip),
  getDeviceId: () => ipcRenderer.invoke('get-device-id'),
  setDeviceId: (id) => ipcRenderer.invoke('set-device-id', id),
  toggleRecording: () => ipcRenderer.invoke('toggle-recording'),
  onApprovalStatus: (callback) => ipcRenderer.on('approval-status', callback),
  refreshRouters: () => ipcRenderer.send('refresh-routers'),
  onMemoryUsageUpdate: (callback) => ipcRenderer.on('memory-usage-update', (_event, usedMB) => callback(usedMB)),
});
