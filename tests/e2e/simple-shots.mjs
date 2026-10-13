// 简约化走查（CDP）：研课场简洁视图、演课场导入新产物后直接进入待开课状态、版本标注、默认 10× 倍速。
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
const API = `const api=async(m,p,b)=>{const r=await fetch(p,{method:m,headers:{'content-type':'application/json','x-yz-csrf':'1'},body:b?JSON.stringify(b):undefined});return r.json();};`;
const api = (m, p, b) => js(`${API} return api(${JSON.stringify(m)}, ${JSON.stringify(p)}, ${b ? JSON.stringify(b) : 'undefined'});`);
try {
  await connect(); await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900);
  await go('/login'); await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("['home','seminar','classroom','library','agents'].forEach(k=>localStorage.setItem('yz-tour-'+k,'1')); localStorage.setItem('yz-theme','light'); localStorage.removeItem('yz-speed'); localStorage.removeItem('yz-sw-simple');");
  for (const m of ['seminar', 'classroom']) for (const r of (await api('GET', `/api/runs?module=${m}`)).runs) if (['running', 'paused', 'ready', 'awaiting_human'].includes(r.status)) await api('POST', `/api/runs/${r.run_id}/finish`, {});
  // 研课场简洁视图
  await go('/seminar'); await waitFor("document.querySelector('#sw-simple')", 10000); await sleep(800);
  const full = await js("return { room: document.querySelector('.sw-room').offsetParent !== null, feedH: Math.round(document.querySelector('#feed').getBoundingClientRect().height) }");
  await click('#sw-simple'); await sleep(500);
  const simple = await js("return { room: document.querySelector('.sw-room').offsetParent !== null, feedH: Math.round(document.querySelector('#feed').getBoundingClientRect().height), label: document.querySelector('#sw-simple').textContent, saved: localStorage.getItem('yz-sw-simple'), overflow: document.documentElement.scrollWidth > innerWidth }");
  check(full.room && !simple.room && simple.feedH > full.feedH && simple.label === '完整视图' && simple.saved === '1' && !simple.overflow, `简洁视图隐藏会议室、对话区变高，并记住选择 ${JSON.stringify({ full, simple })}`);
  await shot('S01-seminar-simple');
  await go('/seminar'); await waitFor("document.querySelector('#sw-simple')", 10000); await sleep(500);
  check(await js("return document.body.classList.contains('sw-simple')"), '刷新后仍为简洁视图');
  await click('#sw-simple'); await sleep(300);
  check(await js("return document.querySelector('.sw-room').offsetParent !== null && localStorage.getItem('yz-sw-simple') === '0'"), '切回完整视图');
  // 演课场：导入新产物后直接待开课；版本标注；默认 10×
  const lp = (await api('GET', '/api/artifacts?module=seminar')).artifacts.find((a) => ['lesson_plan', 'courseware'].includes(a.type) && a.status === 'saved');
  const last = (await api('GET', '/api/runs?module=classroom')).runs[0];
  await go(`/library?id=${lp.artifact_id}`); await waitFor("document.querySelector('#to-class')", 8000);
  await click('#to-class'); await sleep(400); await js("[...document.querySelectorAll('.modal .actions button')].at(-1).click()");
  await waitFor("location.pathname === '/classroom'", 10000); await waitFor("document.querySelector('#pl-play') && !document.querySelector('#pl-play').disabled", 10000); await sleep(1200);
  const cl = await js("return { state: document.querySelector('#pl-state')?.textContent || '', play: document.querySelector('#pl-play').textContent.trim(), badge: [...document.querySelectorAll('#st-badges .badge.gold')].map(b=>b.textContent).join(' '), speed: document.querySelector('.pl-speed button.on')?.textContent }");
  check(!/已结束/.test(cl.state) && /开始上课/.test(cl.play) && / · 研课场 v\d+$/.test(cl.badge) && cl.speed === '10×', `导入新产物后不再显示上一节课（上一节：${last ? last.status : '无'}），标注来源版本，默认 10× ${JSON.stringify(cl)}`);
  await shot('S02-classroom-fresh');
} catch (e) { note(`FAIL ${e.message}`); console.log(e.stack); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
