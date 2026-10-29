/* Runs first in the page: builds window.morfisDesktop, the API the dashboard calls in its Windows build.
   Every method returns a promise, except pathsOf, which the page uses inside a drop handler. */
(function () {
  'use strict';
  var B = window.__morfisBridge;
  if (!B) return;
  var call = function (m) {
    return function () {
      return B.call(m, Array.prototype.slice.call(arguments)).then(function (r) {
        if (r && r.e) { var x = new Error(r.e.message); if (r.e.code) x.code = r.e.code; throw x; }
        return r ? r.v : undefined;
      });
    };
  };
  var api = {};
  ['info', 'storeLoad', 'storeSet', 'saveFile', 'winAct', 'winState', 'setTheme', 'setZoom', 'setBranding',
    'openPath', 'reveal', 'openDataDir', 'trashPath', 'pickFiles', 'pickFolder', 'readFile', 'isDir',
    'scanProject', 'scanRoot', 'scanDir', 'listTree', 'listDir', 'mkdirs', 'copyInto', 'applyOps', 'undo',
    'renameItem', 'makeDir', 'moveItems', 'trashItems', 'geocode', 'reverse',
    'getPrefs', 'setPref', 'resetPrefs', 'relaunch', 'openBackups', 'backupNow', 'refreshShortcuts',
    'docsList', 'docSave', 'docDelete', 'kvGet', 'kvSet', 'savePdf', 'printHtml', 'notify', 'openExternal',
    'aiStatus', 'aiChat', 'aiPull', 'folderIcon', 'folderIconClear'].forEach(function (m) { api[m] = call(m); });
  /* the page sends Uint8Array bytes for saved files; that crosses to the main process as is */
  api.onWin = function (fn) { B.on('win:state', fn); };
  api.onFocus = function (fn) { B.on('app:focus', fn); };
  api.onZoom = function (fn) { B.on('app:zoom', fn); };
  api.onAiPull = function (fn) { B.on('ai:pull', fn); };
  api.pathsOf = function (files) {
    var out = [];
    for (var i = 0; files && i < files.length; i++) { var p = B.pathOf(files[i]); if (p) out.push(p); }
    return out;
  };
  window.morfisDesktop = api;
})();
