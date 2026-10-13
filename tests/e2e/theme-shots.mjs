// Real-browser walkthrough via Chrome DevTools Protocol (no npm deps). Drives the actual UI and saves screenshots.
// Usage: node tests/e2e/browser-shots.mjs --base http://127.0.0.1:8787 --teacher <login> --password <pw> --admin <login> --admin-password <pw> [--out docs/screenshots]
// Uses a throwaway Chrome profile; never touches the user's browser profile.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8787');
const OUT = arg('out', 'docs/screenshots');
const CHROME = arg('chrome', ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync));
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (s) => { console.log(s); log.push(s); };

const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'yz-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', '--lang=zh-CN', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws, seq = 0; const pending = new Map();
async function connect() {
  for (let i = 0; i < 50; i++) { try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = list.find((t) => t.type === 'page'); if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; } } catch { /* starting */ } await sleep(200); }
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const p = pending.get(d.id); pending.delete(d.id); d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result); } });
}
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function viewport(width, height, mobile = false) { await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); }
async function go(path) { await cdp('Page.navigate', { url: BASE + path }); await sleep(900); }
async function shot(name) { const r = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64')); note(`screenshot ${name}.png`); }
async function waitFor(cond, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await js(`return !!(${cond})`)) return true; await sleep(150); } throw new Error(`timeout waiting for ${cond}`); }
async function click(sel) { await js(`const el=document.querySelector(${JSON.stringify(sel)}); if(!el) throw new Error('missing ${sel}'); el.click();`); }
async function hover(sel) { const b = await js(`const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}`); await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y }); await sleep(300); }
async function realClick(sel) { const b = await js(`const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}`); for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 }); await sleep(300); }
async function type(sel, text) { await js(`const el=document.querySelector(${JSON.stringify(sel)}); el.focus(); el.value=${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));`); }
const check = (cond, msg) => { note(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) process.exitCode = 1; };

// Theme switch walkthrough: 自动 / 浅色 / 深色 persist across reloads and follow the system in 自动.
const scheme = (v) => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
const state = () => js(`return { theme: document.documentElement.dataset.theme, pref: document.documentElement.dataset.themePref, bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color }`);
try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900); await scheme('dark');
  await go('/login');
  check((await state()).pref === 'auto', '默认显示模式为「自动」');
  await click('[data-theme-set="light"]'); await sleep(200);
  await shot('T01-login-light');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await click('#lf button[type=submit]'); await sleep(1200);
  await js("localStorage.setItem('yz-tour-home','1'); localStorage.setItem('yz-tour-seminar','1'); localStorage.setItem('yz-tour-classroom','1');");
  await go('/'); await sleep(1500);
  let s = await state();
  check(s.theme === 'light' && s.pref === 'light', `浅色选择在刷新/换页后保持 ${JSON.stringify(s)}`);
  const sw = await js(`const g=document.querySelector('.header-tools .theme-switch').getBoundingClientRect(); return { right: innerWidth - g.right, top: g.top, pressed: document.querySelector('.header-tools [data-theme-set="light"]').getAttribute('aria-pressed') }`);
  check(sw.top < 60 && sw.right < 400 && sw.pressed === 'true', `切换按钮位于右上角且当前项高亮 ${JSON.stringify(sw)}`);
  await shot('T02-home-light');
  for (const [p, n] of [['/seminar', 'T03-seminar-light'], ['/classroom', 'T04-classroom-light'], ['/library', 'T05-library-light']]) { await go(p); await sleep(1800); await shot(n); }
  await click('.header-tools [data-theme-set="dark"]'); await sleep(200);
  s = await state(); check(s.theme === 'dark', `切换到深色 ${JSON.stringify(s)}`);
  await go('/'); await sleep(1200); await shot('T06-home-dark');
  await click('.header-tools [data-theme-set="auto"]'); await sleep(200);
  await scheme('light'); await sleep(300); s = await state(); check(s.theme === 'light', `自动：系统为浅色时显示浅色 ${JSON.stringify(s)}`);
  await scheme('dark'); await sleep(300); s = await state(); check(s.theme === 'dark', `自动：系统为深色时显示深色 ${JSON.stringify(s)}`);
  await click('.header-tools [data-theme-set="light"]');
  await viewport(390, 844, true); await go('/'); await sleep(1500); await shot('T07-home-light-390');
  await go('/seminar'); await sleep(1500); await shot('T08-seminar-light-390');
  await viewport(1440, 900);
  await go('/admin'); await sleep(800);
  if (await js("return !!document.querySelector('#lf')")) {
    await shot('T09-admin-login-light');
    await type('#lf input[name=login]', arg('admin')); await type('#lf input[name=password]', arg('admin-password'));
    await js("document.querySelector('#lf').requestSubmit()"); await sleep(1500);
  }
  await shot('T10-admin-light');
  await go('/admin/models'); await sleep(1000); await shot('T11-admin-models-light');
} catch (e) { note(`FAIL ${e.message}`); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
