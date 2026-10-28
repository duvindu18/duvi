/* Desktop extras inside the dashboard page: the look preferences, the app icon in the title bar,
   and the "Desktop app" card on the Settings page. Loaded after the dashboard's own scripts. */
(function () {
  'use strict';
  var H = window.morfisDesktop;
  if (!H || !H.getPrefs) return;
  var root = document.documentElement;
  var P = null;

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function toast(msg) {
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3200);
  }

  /* ----- look: classes on <html>, the same ones the main process sets before first paint ----- */
  var CLASS_PREFS = {
    controls: function (v) { ['fluent', 'classic', 'mac'].forEach(function (k) { root.classList.toggle('wc-' + k, k === v); }); },
    font: function (v) { ['default', 'segoe', 'technical', 'system'].forEach(function (k) { root.classList.toggle('font-' + k, k === v); }); },
    titleBar: function (v) { root.classList.toggle('no-wtitle', v === 'none'); },
    reduceMotion: function (v) { root.classList.toggle('reduce-motion', !!v); },
    pattern: function (v) { root.classList.toggle('no-pattern', !v); },
    glow: function (v) { root.classList.toggle('no-glow', !v); },
    roundCorners: function (v) { root.classList.toggle('square', !v); }
  };
  function applyLook() { Object.keys(CLASS_PREFS).forEach(function (k) { CLASS_PREFS[k](P[k]); }); }

  /* ----- the app icon beside the title: the custom icon the sidebar shows, otherwise the program's own icon ----- */
  function syncBrand() {
    var box = document.getElementById('wbarIcon'), logo = document.querySelector('.rail-logo');
    if (!box) return;
    var img = logo && logo.querySelector('img');
    var src = img ? img.getAttribute('src') : 'app-icon.png';
    if (box.dataset.sig === src) return;
    box.dataset.sig = src;
    box.innerHTML = '<img src="' + esc(src) + '" alt="">';
  }

  /* ----- keep the splash screen in the current accent and theme ----- */
  var lookT = null;
  function syncAccent() {
    clearTimeout(lookT);
    lookT = setTimeout(function () {
      var a = getComputedStyle(root).getPropertyValue('--accent-fill').trim().toUpperCase();
      if (/^#[0-9A-F]{6}$/.test(a) && P && a !== String(P.accent).toUpperCase()) { P.accent = a; H.setPref('accent', a).catch(function () {}); }
    }, 600);
  }

  /* ----- the Settings card ----- */
  var seg = function (key, opts) {
    return '<div class="seg-ctl" role="group">' + opts.map(function (o) {
      return '<button type="button" class="' + (String(P[key]) === String(o[0]) ? 'on' : '') + '" data-dk="' + key + '" data-v="' + esc(o[0]) + '" aria-pressed="' + (String(P[key]) === String(o[0])) + '">' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  };
  var sw = function (key, label, sub) {
    return '<label class="switch dk-sw"><input type="checkbox" data-dk-bool="' + key + '"' + (P[key] ? ' checked' : '') + '><span><span class="dk-l">' + label + '</span>' + (sub ? '<span class="small muted dk-s">' + sub + '</span>' : '') + '</span></label>';
  };
  var field = function (label, body) { return '<div class="field"><span class="fl">' + label + '</span>' + body + '</div>'; };

  function cardHtml() {
    return '<section class="card stack dk-card" id="dkCard" aria-labelledby="dkTitle">' +
      '<div class="dk-head"><div><h2 id="dkTitle">Desktop app</h2><p class="muted small" style="margin-top:4px">How the program looks and behaves on this computer. Changes apply straight away.</p></div>' +
      '<span class="chip">Version ' + esc(P.version) + '</span></div>' +
      '<div class="dk-grid">' +
      '<div class="dk-sec"><h3>Window</h3>' +
        field('Window buttons', seg('controls', [['fluent', 'Studio'], ['classic', 'Windows'], ['mac', 'Round, left']])) +
        '<div class="dk-prev" aria-hidden="true"><span class="dk-prev-bar"><i class="dk-prev-t"></i><span class="dk-prev-b"><b></b><b></b><b></b></span></span></div>' +
        field('Title bar', seg('titleBar', [['name', 'Show the app name'], ['none', 'Clean']])) +
        sw('alwaysOnTop', 'Keep on top of other windows') +
        sw('rememberWindow', 'Reopen at the same size and place') +
      '</div>' +
      '<div class="dk-sec"><h3>Starting and closing</h3>' +
        sw('splash', 'Loading animation', 'The quick card shown while the dashboard opens') +
        sw('launchAtLogin', 'Open when Windows starts') +
        sw('startMinimized', 'Start minimised', P.closeToTray ? 'Starts in the notification area' : 'Starts on the taskbar') +
        sw('closeToTray', 'Closing keeps it running', 'The close button hides the window to the notification area, so reminders keep coming') +
        sw('confirmQuit', 'Ask before quitting') +
      '</div>' +
      '<div class="dk-sec"><h3>Look</h3>' +
        field('Font', seg('font', [['default', 'Studio'], ['segoe', 'Segoe UI'], ['technical', 'Technical'], ['system', 'System']])) +
        sw('pattern', 'Drawing-grid background') +
        sw('glow', 'Accent glow') +
        sw('roundCorners', 'Rounded corners', 'Off gives cards and panels tighter corners') +
        sw('reduceMotion', 'Reduce motion', 'Turns off animations everywhere') +
      '</div>' +
      '<div class="dk-sec"><h3>System</h3>' +
        sw('spellcheck', 'Check spelling while typing') +
        sw('globalHotkey', 'Show or hide with ' + esc(P.hotkey), 'Works from any program') +
        sw('hwAccel', 'Graphics acceleration', 'Turn off if the window flickers. Needs a restart') +
        sw('devTools', 'Developer tools', 'Ctrl+Shift+I opens them') +
      '</div>' +
      '<div class="dk-sec"><h3>Automatic backups</h3>' +
        '<p class="small muted">A copy of every project is saved each day in <span class="mono" style="overflow-wrap:anywhere">' + esc(P.backups) + '</span>.</p>' +
        field('Keep', seg('backupKeep', P.choices.backupKeep.map(function (n) { return [n, n + ' days']; }))) +
        '<div class="toolbar"><button type="button" class="btn sm" data-dk-act="backupNow">Back up now</button><button type="button" class="btn sm" data-dk-act="openBackups">Open backups folder</button></div>' +
      '</div>' +
      '<div class="dk-sec"><h3>Program</h3>' +
        '<p class="small muted">' + esc(P.name) + ' ' + esc(P.version) + (P.packaged ? '' : ' (development)') + '. Keys: F11 full screen, Ctrl + and Ctrl − to zoom, Ctrl 0 to reset.</p>' +
        '<div class="toolbar"><button type="button" class="btn sm" data-dk-act="refreshShortcuts">Refresh Start menu and shortcuts</button><button type="button" class="btn sm" data-dk-act="relaunch">Restart</button><button type="button" class="btn sm danger ghost" data-dk-act="resetPrefs">Reset these settings</button></div>' +
      '</div>' +
      '</div></section>';
  }
  function placeCard() {
    if (!P) return;
    var brand = document.querySelector('#view .brand-card');
    if (!brand) return;
    var old = document.getElementById('dkCard');
    if (old && old.previousElementSibling === brand) return;
    if (old) old.remove();
    brand.insertAdjacentHTML('afterend', cardHtml());
  }
  function redrawCard() {
    var old = document.getElementById('dkCard');
    if (!old) return;
    var y = document.getElementById('view').scrollTop;
    old.outerHTML = cardHtml();
    document.getElementById('view').scrollTop = y;
  }

  function setPref(key, value) {
    var prev = P[key];
    P[key] = value;
    if (CLASS_PREFS[key]) CLASS_PREFS[key](value);
    redrawCard();
    return H.setPref(key, value).then(function (r) {
      P[key] = r.value;
      if (r.restart) {
        if (window.confirm('Restart now to apply this?')) H.relaunch();
        else toast('This applies the next time the app starts.');
      }
      if (key === 'globalHotkey' && value && r.ok === false) { P[key] = false; H.setPref(key, false); redrawCard(); toast('Another program already uses ' + P.hotkey + '.'); }
      if (key === 'closeToTray' || key === 'startMinimized') redrawCard();
    }, function (e) { P[key] = prev; if (CLASS_PREFS[key]) CLASS_PREFS[key](prev); redrawCard(); toast('Could not change that: ' + (e && e.message ? e.message : 'unknown error')); });
  }
  var ACTS = {
    backupNow: function () { H.backupNow().then(function (f) { toast(f ? 'Backup saved.' : 'There is nothing to back up yet.'); }, function () { toast('Could not save the backup.'); }); },
    openBackups: function () { H.openBackups().catch(function () { toast('Could not open the backups folder.'); }); },
    refreshShortcuts: function () { H.refreshShortcuts().then(function (r) { toast(r && r.updated ? 'Updated ' + r.updated + ' shortcut' + (r.updated === 1 ? '' : 's') + '.' : 'Shortcuts are up to date.'); }, function () { toast('Could not update the shortcuts.'); }); },
    relaunch: function () { H.relaunch(); },
    resetPrefs: function () {
      if (!window.confirm('Put every desktop setting back to how it started? Your projects, app name and icon stay as they are.')) return;
      H.resetPrefs().then(function () { return H.getPrefs(); }).then(function (p) { P = p; applyLook(); redrawCard(); toast('Desktop settings reset.'); });
    }
  };
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#dkCard [data-dk], #dkCard [data-dk-act]');
    if (!b) return;
    if (b.dataset.dkAct) { ACTS[b.dataset.dkAct](); return; }
    var k = b.dataset.dk, v = b.dataset.v;
    setPref(k, typeof P[k] === 'number' ? +v : v);
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.matches || !t.matches('#dkCard [data-dk-bool]')) return;
    setPref(t.dataset.dkBool, t.checked);
  });

  /* ----- start ----- */
  H.getPrefs().then(function (p) {
    P = p;
    applyLook();
    placeCard();
  });
  var mo = new MutationObserver(function () { placeCard(); syncBrand(); });
  var start = function () {
    var v = document.getElementById('view'), s = document.getElementById('side');
    if (v) mo.observe(v, { childList: true });
    if (s) mo.observe(s, { childList: true, subtree: true });
    new MutationObserver(syncAccent).observe(root, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    syncBrand(); syncAccent();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  /* dropping a file anywhere outside a drop zone must never navigate the window away */
  window.addEventListener('dragover', function (e) { if (e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) e.preventDefault(); });
  window.addEventListener('drop', function (e) { if (e.dataTransfer && [].indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) e.preventDefault(); });
})();
