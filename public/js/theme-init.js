// 显示模式：自动（跟随系统）/ 浅色 / 深色。在 <head> 同步加载，页面绘制前就设置好主题，避免闪烁。
(function () {
  var KEY = 'yz-theme';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function pref() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; } }
  function resolved(p) { return p === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : p; }
  function sync() {
    var p = pref(), btns = document.querySelectorAll('[data-theme-set]');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-theme-set') === p));
  }
  function apply() {
    var p = pref(), r = resolved(p), el = document.documentElement;
    el.setAttribute('data-theme', r); el.setAttribute('data-theme-pref', p); el.style.colorScheme = r;
    sync();
  }
  function set(p) { try { localStorage.setItem(KEY, p); } catch (e) { /* storage unavailable: apply for this page only */ } apply(); }
  if (mq) { var onChange = function () { if (pref() === 'auto') apply(); }; if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange); }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-theme-set]') : null;
    if (!b) return;
    set(b.getAttribute('data-theme-set'));
    // storage may be unavailable; still switch for this page
    if (pref() !== b.getAttribute('data-theme-set')) { var el = document.documentElement, v = b.getAttribute('data-theme-set'); el.setAttribute('data-theme', resolved(v)); el.setAttribute('data-theme-pref', v); }
  });
  document.addEventListener('DOMContentLoaded', sync);
  // 字号：m 标准（默认，已比旧版放大）/ l 较大 / xl 特大
  var FKEY = 'yz-fs';
  function fpref() { try { var v = localStorage.getItem(FKEY); return v === 'l' || v === 'xl' ? v : 'm'; } catch (e) { return 'm'; } }
  function fapply(v) { var el = document.documentElement; el.setAttribute('data-fs', v); el.setAttribute('data-fs-pref', v); }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-fs-set]') : null;
    if (!b) return;
    var v = b.getAttribute('data-fs-set');
    try { localStorage.setItem(FKEY, v); } catch (err) { /* storage unavailable: this page only */ }
    fapply(v); window.dispatchEvent(new Event('resize'));
  });
  fapply(fpref());
  window.yzTheme = { set: set, pref: pref, sync: sync };
  apply();
})();
