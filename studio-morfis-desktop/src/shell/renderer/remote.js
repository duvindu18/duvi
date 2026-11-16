/* The phone page: the menu button and drawer, the Back button of the phone, the "connection lost" notice, and a
   card on the Settings page for this phone. Loaded only on the page served to phones. */
(function () {
  'use strict';
  var M = window.Morfis, H = window.morfisDesktop;
  if (!M || !window.MORFIS_REMOTE) return;
  var root = document.documentElement, $ = function (s) { return document.querySelector(s); };
  var narrow = function () { return window.innerWidth < 1000; };

  /* ----- menu button and drawer ----- */
  function setup() {
    var top = $('.top');
    if (top && !$('.rb-menu')) top.insertAdjacentHTML('afterbegin', '<button type="button" class="icon-btn lg rb-menu" aria-label="Menu" title="Menu">' + M.ic('list', 20) + '</button>');
    if (!$('.rb-scrim')) document.body.insertAdjacentHTML('beforeend', '<div class="rb-scrim"></div><div class="rb-off" role="status"><i></i>Reconnecting to the computer…</div>');
  }
  var nav = function (on) { root.classList.toggle('rb-nav', !!on); };
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('.rb-menu')) { nav(!root.classList.contains('rb-nav')); return; }
    if (t.closest('.rb-scrim')) { nav(false); return; }
  });
  /* picking a place in the drawer closes it (capture: the sidebar redraws itself on the same click) */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#dkSide [data-go], #dkSide [data-side-act=reminders], #dkSide [data-side-act=help], #dkSide [data-side-act=newProject]');
    if (b && narrow()) setTimeout(function () { nav(false); }, 60);
  }, true);
  /* the narrow sidebar setting is for the computer's window; on a phone the drawer always shows names */
  new MutationObserver(function () { if (narrow() && root.classList.contains('side-collapsed')) root.classList.remove('side-collapsed'); }).observe(root, { attributes: true, attributeFilter: ['class'] });
  root.classList.remove('side-collapsed');

  /* ----- the phone's status bar follows the page's light or dark theme ----- */
  var lastBars = null;
  function syncBars() { var light = root.getAttribute('data-theme') === 'light'; if (light !== lastBars && window.MorfisAndroid && window.MorfisAndroid.setBars) { lastBars = light; window.MorfisAndroid.setBars(light); } }
  new MutationObserver(syncBars).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  syncBars();

  /* ----- the phone's Back button (called by the Android app): close what is open, then go Home ----- */
  window.__morfisBack = function () {
    var pv = $('.pv'); if (pv && !pv.hidden && window.MorfisPreview) { window.MorfisPreview.close(); return true; }
    var pick = $('.rb-pick'); if (pick) { var x = pick.querySelector('[data-x]'); if (x) x.click(); return true; }
    var menu = $('.dk-menu, .menu:not([hidden])'); if (menu) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; }
    var ov = $('#overlay'); if (ov && !ov.hidden) { M.page().closeModal(); return true; }
    if (root.classList.contains('rb-nav')) { nav(false); return true; }
    var pg = M.page();
    if (M.current()) { M.go('home'); return true; }
    if (pg && pg.S.ui.view === 'project') { M.go('projects'); return true; }
    if (pg && pg.S.ui.view !== 'home') { M.go('home'); return true; }
    return false;
  };

  /* ----- this phone, on the Settings page ----- */
  function phoneCard() {
    var brand = document.querySelector('#view .brand-card');
    if (!brand || document.getElementById('rbPhone')) return;
    var app = !!(window.MorfisAndroid && window.MorfisAndroid.disconnect), o = H.offline ? H.offline() : null;
    var where = app && window.MorfisAndroid.server ? window.MorfisAndroid.server().replace(/^https?:\/\//, '') : location.host;
    brand.insertAdjacentHTML('beforebegin', '<section class="card stack rb-phone" id="rbPhone"><div><h2>This phone</h2><p class="muted small" style="margin-top:4px">' + (o && !o.online ? 'Offline. Working from this phone’s copy of ' + M.esc(where) + '.' : 'Connected to ' + M.esc(where) + '. Changes are saved on the computer and show on both at once.') + ' Automations run on the computer.</p></div>' +
      (o ? '<div class="rb-off-info"><span><b>' + o.folders + '</b> project folder' + (o.folders === 1 ? '' : 's') + ' kept for offline use (names only)</span><span><b>' + o.waiting + '</b> change' + (o.waiting === 1 ? '' : 's') + ' waiting to be sent</span></div>' +
        '<p class="small muted">Away from the computer, the app opens from this phone. You can organise folders (rename, move, delete, new folders), add files from the phone, and change projects, tasks and invoices. Everything is sent when the computer answers again. Opening a file needs the computer, as only the names are kept here.</p>' : '') +
      '<div class="toolbar">' + (o && o.waiting && o.online ? '<button type="button" class="btn primary" data-rb="sync">Send changes now</button>' : '') + (app ? '<button type="button" class="btn" data-rb="switch">Change computer</button>' : '') + '<button type="button" class="btn danger ghost" data-rb="unpair">Unpair this phone</button></div></section>');
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-rb]');
    if (!b) return;
    if (b.dataset.rb === 'switch') window.MorfisAndroid.disconnect();
    else if (b.dataset.rb === 'sync') H.syncNow();
    else if (b.dataset.rb === 'unpair' && window.confirm('Unpair this phone? You will need a new PIN from the computer to connect again.')) H.logout();
  });

  var start = function () {
    setup();
    var v = $('#view'); if (v) new MutationObserver(phoneCard).observe(v, { childList: true });
    phoneCard();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
