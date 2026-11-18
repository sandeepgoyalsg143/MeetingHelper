const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetingHelperControls', {
  action: name => ipcRenderer.invoke('controls-action', name),
  onState: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('controls-state', listener);
    return () => ipcRenderer.removeListener('controls-state', listener);
  }
});
