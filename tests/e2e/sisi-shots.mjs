// 数字客服思思与账号走查（CDP）：右下角水晶球、面板开合、登录前本地问答、头像显示、退出并清空缓存只清除本平台缓存键。不向大模型发问。
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
try {
  await connect(); await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900);
  await go('/login'); await waitFor("document.querySelector('#sisi-orb')", 8000);
  const orb = await js("const r=document.querySelector('#sisi-orb').getBoundingClientRect(); return { right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width), svg: !!document.querySelector('#sisi-orb .av-orb') }");
  check(orb.svg && orb.right < 40 && orb.bottom < 40 && orb.w >= 60, `思思水晶球在右下角 ${JSON.stringify(orb)}`);
  await js("localStorage.setItem('yz-sisi-voice','0'); sessionStorage.clear()"); await click('#sisi-orb'); await waitFor("!document.querySelector('#sisi-panel').hidden");
  await js("const t=document.querySelector('#sisi-q'); t.value='怎么注册账号？'; document.querySelector('#sisi-form').requestSubmit()");
  await waitFor("document.querySelectorAll('#sisi-msgs .sisi-m.a').length >= 2 && !document.querySelector('.sisi-typing')", 15000);
  const a = await js("const m=[...document.querySelectorAll('#sisi-msgs .sisi-m.a')].at(-1); return { text: m.querySelector('p').textContent, src: m.querySelector('.sisi-src')?.textContent || '', play: !!m.querySelector('.sisi-play'), mode: document.querySelector('#sisi-mode').textContent }");
  check(/注册/.test(a.text) && /来源/.test(a.src) && a.play && /登录前/.test(a.mode), `登录前用本地知识库回答并注明来源、可朗读 ${JSON.stringify({ ...a, text: a.text.slice(0, 40) })}`);
  await shot('Z1-sisi-login');
  await click('#sisi-close'); check(await js("return document.querySelector('#sisi-panel').hidden"), '关闭对话框');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1500);
  check(await js("return !!document.querySelector('#user-btn .hdr-ava .av-orb')"), '右上角显示用户水晶球头像');
  await js("localStorage.setItem('yz-e2e-probe','1'); localStorage.setItem('other-app-probe','1'); sessionStorage.setItem('x','1')");
  await js("document.querySelector('#user-btn').click()"); await sleep(200); await js("document.querySelector('#logout').click()"); await waitFor("document.querySelector('.modal .logout-opts')");
  const btns = await js("return [...document.querySelectorAll('.modal .actions button')].map(b=>b.textContent)");
  check(btns.join('|') === '取消|退出并清空缓存|退出登录', `退出时可选择“退出并清空缓存” ${btns.join('|')}`);
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='退出并清空缓存').click()");
  await waitFor("location.pathname === '/login'", 8000); await sleep(800);
  const cl = await js("return { yz: Object.keys(localStorage).filter(k=>k.startsWith('yz-')).length, other: localStorage.getItem('other-app-probe'), sess: sessionStorage.length, url: location.search }");
  check(cl.yz === 0 && cl.other === '1' && cl.sess === 0 && /cleared=1/.test(cl.url), `清空缓存只清除本平台的 yz-* 键与会话存储 ${JSON.stringify(cl)}`);
  const me = await js("const r = await fetch('/api/me'); return r.status");
  check(me === 401, `服务器端会话已结束（/api/me → ${me}）`);
  await js("localStorage.removeItem('other-app-probe')");
} catch (e) { note(`FAIL ${e.message}`); console.log(e.stack); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
