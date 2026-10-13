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

// 首页三屏走查：多分辨率 × 深浅主题截图；检查无横向滚动、无统计数字、核心入口与双向箭头存在。
const scheme = (v) => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: v }] });
try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900);
  await go('/login');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("localStorage.setItem('yz-tour-home','1'); localStorage.removeItem('yz-fs');");
  for (const theme of ['light', 'dark']) {
    await js(`localStorage.setItem('yz-theme','${theme}')`);
    for (const [w, h, mobile] of [[1920, 1080], [1440, 900], [1366, 768], [768, 1024, true], [390, 844, true]]) {
      await viewport(w, h, !!mobile); await go('/'); await sleep(1600);
      const r = await js(`const t=document.querySelector('.hx').innerText, cur=[...document.querySelectorAll('.hx-cur')].map(e=>e.innerText).join(' ');
        const body=t.replace(cur,'').replace(/v\d+/g,'');
        const s=document.querySelector('#portal-seminar').getBoundingClientRect(), c=document.querySelector('#portal-classroom').getBoundingClientRect(), h1=document.querySelector('#hx-title').getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth, numbers: (body.match(/\d{2,}|\d+%/g)||[]), arrows: document.querySelectorAll('.arrows .arrow-btn').length,
          titleVisible: h1.top >= 0 && h1.bottom < innerHeight, cardsInFirstScreen: s.top < innerHeight && (${!!mobile} || (s.bottom <= innerHeight + 4 && c.bottom <= innerHeight + 4)), sideBySide: Math.abs(s.top - c.top) < 4 }`);
      check(!r.overflow && r.numbers.length === 0 && r.arrows === 2 && r.titleVisible && r.cardsInFirstScreen && (mobile ? !r.sideBySide || w >= 768 : r.sideBySide), `${theme} ${w}×${h}：${JSON.stringify(r)}`);
      await shot(`H-${theme}-${w}-1`);
      if (w === 1440 || w === 390) {
        await js("document.querySelector('#hx-disc').scrollIntoView()"); await sleep(1400); await shot(`H-${theme}-${w}-2`);
        await js("document.querySelector('.hx-loop-sec').scrollIntoView()"); await sleep(2200); await shot(`H-${theme}-${w}-3`);
      }
    }
  }
  // 领域卡片 → 思政元素参考（真实参考库内容）
  await viewport(1440, 900); await go('/'); await sleep(1200);
  await js("document.querySelector('#hx-disc').scrollIntoView()"); await sleep(1000);
  await click('[data-disc="eng"]'); await waitFor("document.querySelector('.modal .hx-lib')");
  const lib = await js("return [...document.querySelectorAll('.modal .hx-lib b')].map(b=>b.textContent)");
  check(lib.length === 3, `新工科卡片打开平台思政元素参考库：${lib.join('、')}`);
  await shot('H-disc-modal');
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='关闭').click()"); await sleep(300);
  // 闭环节点可进入对应模块
  await js("document.querySelector('.hx-node.n1').click()"); await sleep(1200);
  check((await js('return location.pathname')) === '/classroom', '“演”节点进入演课场');
  await js("history.back()"); await sleep(1200);
  check((await js("return document.body.classList.contains('is-home')")) === true, '返回首页');
  await go('/library'); await sleep(800);
  check((await js("return document.body.classList.contains('is-home')")) === false, '离开首页后恢复普通页面宽度');
} catch (e) { note(`FAIL ${e.message}`); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
