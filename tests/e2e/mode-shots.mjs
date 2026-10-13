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

// 运行方式与“导入后直接开课”走查：研讨 → 课堂流转后点“开始上课”即运行；模拟演示 / 大模型 API 两种方式；字号切换。
// --model 1 时会真实调用已配置的大模型（少量调用，按规则扣积分）。
const USE_MODEL = arg('model', '0') === '1';
const events = () => js("return document.querySelectorAll('#cl-live .cl-now, #cl-live .cl-guide, #cl-live .cl-ev').length");
try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900);
  await go('/login');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("localStorage.setItem('yz-tour-home','1'); localStorage.setItem('yz-tour-seminar','1'); localStorage.setItem('yz-tour-classroom','1'); localStorage.setItem('yz-exec-mode','demo'); localStorage.removeItem('yz-fs');");
  // 1) 首页 → 把研课场当前产物导入演课场
  await go('/'); await sleep(1200);
  await js("const H={'content-type':'application/json','x-yz-csrf':'1'}; const a=(await (await fetch('/api/artifacts?module=seminar')).json()).artifacts.find(x=>x.type==='lesson_plan'); if(a) await fetch('/api/artifacts/'+a.artifact_id+'/current',{method:'POST',headers:H,body:'{}'});");
  await go('/'); await sleep(1200);
  await realClick('.arrow-btn[data-from=seminar]'); await waitFor("document.querySelector('.modal')");
  await js(`[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='确认').click();`); await sleep(1500);
  const path = await js('return location.pathname');
  if (path !== '/classroom') await go('/classroom');
  await waitFor("document.querySelector('#pl-play')"); await sleep(800);
  const b0 = await js("const b=document.querySelector('#pl-play'); return {text:b.textContent, disabled:b.disabled, mode:document.querySelector('#mode-top')?.dataset.value, modes:[...document.querySelectorAll('#mode-top [data-mode]')].map(x=>x.textContent.trim()+(x.disabled?'(不可用)':''))}");
  check(!b0.disabled && /开始上课/.test(b0.text), `导入后“开始上课”可直接点击 ${JSON.stringify(b0)}`);
  check(b0.modes.length === 2 && b0.mode === 'demo', `顶部有两种运行方式，默认模拟演示 ${JSON.stringify(b0.modes)}`);
  await shot('M01-classroom-after-import');
  // 2) 模拟演示：点一下就开课
  await click('#pl-play');
  await waitFor("!document.querySelector('#pl-pause').disabled && /进行中/.test(document.querySelector('#st-badges').innerText) && document.querySelectorAll('#cl-live .cl-now, #cl-live .cl-guide, #cl-live .cl-ev').length >= 2", 20000);
  const d1 = await js("return {n:document.querySelectorAll('#cl-live .cl-now, #cl-live .cl-guide, #cl-live .cl-ev').length, btn:document.querySelector('#pl-pause').disabled ? '' : '暂停可用', badge:document.querySelector('#st-badges').innerText}");
  check(d1.n >= 2 && /暂停/.test(d1.btn), `模拟演示立即运行 ${JSON.stringify(d1)}`);
  await shot('M02-classroom-demo-running');
  await click('#pl-pause'); await sleep(800);
  // 3) 新建课堂弹窗：运行方式为两张大卡片
  await js("document.querySelector('#finish').click()"); await sleep(400); await js("const b=[...document.querySelectorAll('.modal .actions button')].at(-1); if(b) b.click();"); await sleep(1000);
  await click('#new-run'); await waitFor("document.querySelector('#c-exec .mode-card')");
  const cards = await js("return [...document.querySelectorAll('#c-exec .mode-card')].map(c=>({t:c.innerText.replace(/\s+/g,' '), on:c.classList.contains('on'), h:Math.round(c.getBoundingClientRect().height)}))");
  check(cards.length === 2 && cards.every((c) => c.h >= 50), `新建课堂：运行方式为两张醒目卡片 ${JSON.stringify(cards)}`);
  await shot('M03-classroom-new-modal');
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='取消').click()"); await sleep(400);
  // 4) 研课场：顶部运行方式 + 新建任务向导中的卡片
  await go('/seminar'); await waitFor("document.querySelector('#mode-top')"); await sleep(600);
  await click('#new-run'); await waitFor("document.querySelector('#w-exec .mode-card')"); await sleep(400);
  await shot('M04-task-wizard-modes');
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>/取消|关闭/.test(b.textContent))?.click()"); await sleep(400);
  // 5) 字号：默认已放大，可切到特大
  const f0 = await js("return parseFloat(getComputedStyle(document.body).fontSize)");
  await click('.header-tools [data-fs-set="xl"]'); await sleep(300);
  const f1 = await js("return parseFloat(getComputedStyle(document.body).fontSize)");
  await go('/seminar'); await sleep(800);
  const f2 = await js("return {fs:parseFloat(getComputedStyle(document.body).fontSize), pref:document.documentElement.dataset.fsPref}");
  check(f0 >= 16 && f1 > f0 && f2.fs === f1 && f2.pref === 'xl', `字号默认 ${f0}px，特大 ${f1}px，刷新后保持 ${JSON.stringify(f2)}`);
  await shot('M05-seminar-font-xl');
  await click('.header-tools [data-fs-set="m"]'); await sleep(300);
  // 6) 大模型 API 运行（可选）
  if (USE_MODEL) {
    await go('/classroom'); await waitFor("document.querySelector('#mode-top')"); await sleep(600);
    await realClick('#mode-top [data-mode="model"]'); await sleep(300);
    const t = await js("return document.querySelector('#pl-play').textContent");
    await click('#pl-play');
    await waitFor("(/真实模型/.test(document.querySelector('#st-badges').innerText) && document.querySelectorAll('#cl-live .cl-now, #cl-live .cl-guide, #cl-live .cl-ev').length >= 2) || document.querySelector('.modal')", 90000);
    const r = await js("return {modal:document.querySelector('.modal')?.innerText||null, items:[...document.querySelectorAll('#cl-live .cl-now, #cl-live .cl-guide, #cl-live .cl-ev')].slice(0,2).map(i=>i.innerText.slice(0,120)), badge:document.querySelector('#st-badges').innerText}");
    check(!r.modal && r.items.length >= 1 && /真实模型/.test(r.badge), `大模型 API 运行：${t} → ${JSON.stringify(r)}`);
    await shot('M06-classroom-model-running');
    await js("const b=document.querySelector('#pl-pause'); if(!b.disabled) b.click();"); await sleep(1500);
    await js("document.querySelector('#finish').click()"); await sleep(400); await js("const b=[...document.querySelectorAll('.modal .actions button')].at(-1); if(b) b.click();"); await sleep(1000);
  }
} catch (e) { note(`FAIL ${e.message}`); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
