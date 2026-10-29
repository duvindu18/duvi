// The only bridge between the page and the window: title-bar buttons, the window's state, the theme colour and the start-up screen.
// Runs sandboxed with context isolation; the page gets these few functions and nothing else.
"use strict";
const {contextBridge, ipcRenderer} = require("electron");

contextBridge.exposeInMainWorld("cbDesktop", {
  platform: process.platform,
  minimize: () => ipcRenderer.send("win", "minimize"),
  maximize: () => ipcRenderer.send("win", "maximize"),          // toggles: maximize, or restore when maximized
  close: () => ipcRenderer.send("win", "close"),
  state: () => ipcRenderer.invoke("win:state"),
  onState: fn => { ipcRenderer.on("win:state", (_e, s) => fn(s)); },
  theme: (dark, accent) => ipcRenderer.send("win:theme", {dark: !!dark, accent: String(accent || "")}),
  // start-up screen only
  onBoot: fn => { ipcRenderer.on("boot", (_e, s) => fn(s)); },
  retry: () => ipcRenderer.send("boot", "retry"),
  openLogs: () => ipcRenderer.send("boot", "logs"),
});
