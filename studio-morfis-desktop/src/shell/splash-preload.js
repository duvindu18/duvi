'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splash', { onDone: (fn) => ipcRenderer.once('splash:done', () => fn()) });
