const { contextBridge, ipcRenderer } = require('electron');

//* possible EventTarget memory leak detected
process.setMaxListeners(0);

contextBridge.exposeInMainWorld('electron', {
  ipc: { ...ipcRenderer, on: ipcRenderer.on, once: ipcRenderer.once },
});
