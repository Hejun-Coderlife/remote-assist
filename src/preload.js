const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteAssist', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  startAssist: () => ipcRenderer.invoke('start-assist'),
  stopAssist: () => ipcRenderer.invoke('stop-assist'),
  refreshCredentials: () => ipcRenderer.invoke('refresh-credentials'),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  cfstOptimizeTunnel: () => ipcRenderer.invoke('cfst-optimize-tunnel'),
  cfstRemoveHosts: () => ipcRenderer.invoke('cfst-remove-hosts'),
  onStatus: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('status', listener);
    return () => ipcRenderer.removeListener('status', listener);
  },
  onControlUrl: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('control-url', listener);
    return () => ipcRenderer.removeListener('control-url', listener);
  },
  onAssistReset: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('assist-reset', listener);
    return () => ipcRenderer.removeListener('assist-reset', listener);
  }
});
