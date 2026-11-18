const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetingHelper', {
  readResume: file => ipcRenderer.invoke('resume-read', file),
  screenSources: () => ipcRenderer.invoke('screen-sources'),
  captureScreen: id => ipcRenderer.invoke('screen-capture', id),
  preparePaste: text => ipcRenderer.invoke('paste-prepare', text),
  prepareType: (text, wordsPerMinute) => ipcRenderer.invoke('type-prepare', text, wordsPerMinute),
  cancelPaste: () => ipcRenderer.invoke('paste-cancel'),
  setOverlay: (enabled, opacity) => ipcRenderer.invoke('overlay-set', enabled, opacity),
  setCaptureExclusion: excluded => ipcRenderer.invoke('capture-exclusion-set', excluded),
  onCaptureExclusionState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('capture-exclusion-state', listener);
    return () => ipcRenderer.removeListener('capture-exclusion-state', listener);
  },
  showControls: () => ipcRenderer.invoke('controls-show'),
  onNavigateToPart: callback => {
    const listener = (_event, part) => callback(part);
    ipcRenderer.on('navigate-part', listener);
    return () => ipcRenderer.removeListener('navigate-part', listener);
  },
  onOverlayState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('overlay-state', listener);
    return () => ipcRenderer.removeListener('overlay-state', listener);
  },
  onPasteStatus: callback => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('paste-status', listener);
    return () => ipcRenderer.removeListener('paste-status', listener);
  },
  request: (route, body) => ipcRenderer.invoke('api-request', route, body),
  windowInfo: () => ipcRenderer.invoke('window-info')
});
