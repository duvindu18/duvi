'use strict';
/* The only door between the page and the computer. bridge.js turns this into window.morfisDesktop,
   the object the dashboard looks for when it runs as the Windows app. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('__morfisBridge', {
  /* resolves to { v } or { e: { message, code } }; bridge.js turns e into a thrown Error on the page side,
     because an Error's extra fields (code) do not survive the trip across contextBridge */
  call(method, args) { return ipcRenderer.invoke('host', method, args); },
  on(channel, fn) {
    if (['win:state', 'app:focus', 'app:zoom'].indexOf(channel) === -1) return;
    ipcRenderer.on(channel, (e, v) => fn(v));
  },
  pathOf(file) { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } }
});
