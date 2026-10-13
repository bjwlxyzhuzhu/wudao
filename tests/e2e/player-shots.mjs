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

// 播放器条逐按钮功能测试：课堂试验场 + 数字教研室（单次研讨、任务自动执行两种情况）。
// 按钮：开始/继续 · 暂停 · 快进 · 回退 · 结束；进度条向后拖（快进）、向前拖（回看）；课堂倍速。每一项都同时核对服务端真实状态。
const API = `const api=async(m,p,b)=>{const r=await fetch(p,{method:m,headers:{'content-type':'application/json','x-yz-csrf':'1'},body:b?JSON.stringify(b):undefined});return r.json();};`;
const api = (m, p, b) => js(`${API} return api(${JSON.stringify(m)}, ${JSON.stringify(p)}, ${b ? JSON.stringify(b) : 'undefined'});`);
const pst = () => js(`const q=(s)=>document.querySelector(s); return { state: q('#pl-state').textContent, play: q('#pl-play').textContent.trim(), playOn: !q('#pl-play').disabled, pauseOn: !q('#pl-pause').disabled,
  fwdOn: !q('#pl-fwd').disabled, backOn: !q('#pl-back').disabled, endOn: !q('#finish').disabled, end: q('#finish').textContent.trim(), buf: parseFloat(q('#pl-buf').style.width)||0, fill: parseFloat(q('#pl-fill').style.width)||0, time: q('#pl-time').textContent }`);
async function drag(frac) {
  const r = await js("const r=document.querySelector('#pl-track').getBoundingClientRect(); return {x:r.x, y:r.y+r.height/2, w:r.width}");
  const x0 = r.x + r.w * 0.02, x1 = r.x + r.w * frac;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: r.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: r.y, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 6; i++) await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 6, y: r.y, button: 'left', buttons: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: r.y, button: 'left', clickCount: 1 });
  await sleep(500);
}
const confirmModal = async () => { await sleep(300); await js("const b=[...document.querySelectorAll('.modal .actions button')].at(-1); if(b) b.click();"); await sleep(900); };
const notFF = "!/快进中/.test(document.querySelector('#pl-state').textContent)";
const runStatus = async (id) => (await api('GET', `/api/runs/${id}`)).run.status;
const lastRunId = async (m) => (await api('GET', `/api/runs?module=${m}`)).runs[0].run_id;
const count = (sel) => js(`return document.querySelectorAll(${JSON.stringify(sel)}).length`);

try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900);
  await go('/login');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("['home','seminar','classroom'].forEach(k=>localStorage.setItem('yz-tour-'+k,'1')); localStorage.setItem('yz-theme','light'); localStorage.removeItem('yz-fs'); localStorage.setItem('yz-exec-mode','demo'); localStorage.removeItem('yz-groups'); localStorage.setItem('yz-speed','5');");
  // 干净的起点：取消遗留任务、结束未完成的运行；研课场当前产物设为教案并送入演课场
  for (const j of (await api('GET', '/api/jobs')).jobs) if (['running', 'paused'].includes(j.status)) await api('POST', `/api/jobs/${j.job_id}/cancel`, {});
  for (const m of ['seminar', 'classroom']) for (const r of (await api('GET', `/api/runs?module=${m}`)).runs) if (['running', 'paused', 'ready', 'awaiting_human'].includes(r.status)) await api('POST', `/api/runs/${r.run_id}/finish`, {});
  const lp = (await api('GET', '/api/artifacts?module=seminar')).artifacts.find((a) => a.type === 'lesson_plan');
  await api('POST', `/api/artifacts/${lp.artifact_id}/current`, {});
  await api('POST', '/api/transfers', { from: 'seminar', idempotency_key: `pl-${Date.now()}` });

  // ================= 课堂试验场 =================
  await go('/classroom'); await waitFor("document.querySelector('#pl-play')"); await sleep(800);
  let s = await pst();
  check(s.playOn && s.play === '开始上课' && !s.pauseOn && !s.endOn && !s.fwdOn, `课堂·初始：可开始上课，暂停/快进/下课不可用（上一节已结束的课仍可回看） ${JSON.stringify(s)}`);
  await click('#pl-play');
  try { await waitFor("/实时/.test(document.querySelector('#pl-state').textContent) && document.querySelectorAll('#cl-live .cl-now, #cl-live .cl-ev').length >= 1", 20000); }
  catch (e) { note(`诊断：${JSON.stringify(await pst())} toast=${await js("return document.querySelector('#toast')?.innerText||''")} runs=${JSON.stringify((await api('GET', '/api/runs?module=classroom')).runs.slice(0, 3).map((r) => r.status))}`); throw e; }
  const cid = await lastRunId('classroom');
  s = await pst();
  check(s.pauseOn && s.endOn && s.fwdOn && !s.playOn && (await runStatus(cid)) === 'running', `课堂·开始：进入实时，暂停/快进/下课可用，服务端 running ${JSON.stringify(s)}`);
  await sleep(2500);
  await click('#pl-pause'); await sleep(1200);
  const e1 = (await api('GET', `/api/runs/${cid}`)).events.length; await sleep(2500); const e2 = (await api('GET', `/api/runs/${cid}`)).events.length;
  s = await pst();
  check(/已暂停/.test(s.state) && s.play === '继续上课' && e1 === e2 && (await runStatus(cid)) === 'paused', `课堂·暂停：不再产生事件（${e1}→${e2}），服务端 paused ${JSON.stringify(s)}`);
  await click('#pl-play'); await sleep(300);
  const e3 = (await api('GET', `/api/runs/${cid}`)).events.length;
  await waitFor(`true`, 100);
  let grew = false; for (let i = 0; i < 40 && !grew; i++) { await sleep(300); grew = (await api('GET', `/api/runs/${cid}`)).events.length > e3; }
  check(grew && (await runStatus(cid)) === 'running', '课堂·继续上课：事件继续产生，服务端 running');
  await js("document.querySelector('.pl-speed [data-speed=\"20\"]').click()"); await sleep(300);
  const sp = await js("return { on: document.querySelector('.pl-speed button.on')?.textContent, saved: localStorage.getItem('yz-speed') }");
  check(sp.on === '20×' && sp.saved === '20', `课堂·倍速：切到 20× 并记住 ${JSON.stringify(sp)}`);
  await click('#pl-pause'); await sleep(1000);
  s = await pst(); const buf0 = s.buf;
  await click('#pl-fwd'); await sleep(400);
  await waitFor(notFF, 90000);
  s = await pst();
  check(s.buf > buf0 && (await runStatus(cid)) === 'paused', `课堂·快进：已上课时 ${buf0.toFixed(1)}% → ${s.buf.toFixed(1)}%，停住后服务端 paused`);
  const target = Math.min(90, s.buf + 15);
  await drag(target / 100); await sleep(400);
  await waitFor(notFF, 120000); await sleep(1500);
  s = await pst();
  check(s.buf >= target - 3, `课堂·向后拖动进度条：快进到 ${target.toFixed(0)}% 附近（实际 ${s.buf.toFixed(1)}%）`);
  const nLive = await count('#cl-live .cl-evs.all li, #cl-live .cl-ev');
  const fullEvents = (await api('GET', `/api/runs/${cid}`)).events.length;
  await drag(0.1);
  s = await pst();
  const nVisible = await js("return document.querySelectorAll('.cl-m b')[2]?.textContent");
  check(/回看/.test(s.state) && s.fill <= 13 && s.play === '回到实时', `课堂·向前拖动：进入回看，位置 ${s.fill.toFixed(1)}%（全课 ${fullEvents} 个事件，当时学生发言 ${nVisible} 次）`);
  const f0 = s.fill;
  await click('#pl-fwd'); await sleep(600); s = await pst();
  check(/回看/.test(s.state) && s.fill > f0, `课堂·回看中快进：跳到下一环节 ${f0.toFixed(1)}% → ${s.fill.toFixed(1)}%（仍为回看）`);
  const f1 = s.fill;
  await click('#pl-back'); await sleep(600); s = await pst();
  check(/回看/.test(s.state) && s.fill < f1, `课堂·回退：回到上一环节 ${f1.toFixed(1)}% → ${s.fill.toFixed(1)}%`);
  await shot('P01-classroom-review');
  await click('#pl-play'); await sleep(800); s = await pst();
  check(!/回看/.test(s.state), `课堂·回到实时 ${s.state}`);
  await click('#pl-pause'); await sleep(800);
  await click('#finish'); await confirmModal();
  s = await pst();
  check((await runStatus(cid)) === 'completed' && !s.endOn && !s.pauseOn && s.play === '开始上课', `课堂·下课：确认后服务端 completed，按钮复位 ${JSON.stringify({ play: s.play, end: s.endOn })}`);
  await shot('P02-classroom-ended');

  // ================= 数字教研室：单次研讨 =================
  const run = await api('POST', '/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'lesson_plan', framework_key: 'boppps', course: { name: '机械质量检测', major: '机械制造', audience: '大二', hours: 32, weeks: 16, lesson_minutes: 45, unit: '尺寸公差', goal_knowledge: '掌握公差', goal_ability: '能判断', goal_value: '质量责任', ideology_elements: '工匠精神、质量意识', cases: '零件检测', exam_total: 100 }, mode: 'mixed', title: '播放器测试·研讨' });
  await go(`/seminar?run=${run.run_id}`); await waitFor("document.querySelector('#pl-play')"); await sleep(900);
  s = await pst();
  check(s.playOn && s.play === '开始研讨' && s.endOn && /第 0\/\d+ 步/.test(s.time), `研讨·初始：开始研讨可用 ${JSON.stringify(s)}`);
  await click('#pl-play');
  await waitFor("document.querySelectorAll('#feed .sw-msg').length >= 2", 20000);
  s = await pst();
  check(/实时/.test(s.state) && s.pauseOn && (await runStatus(run.run_id)) === 'running', `研讨·开始：实时 ${JSON.stringify(s)}`);
  await click('#pl-pause'); await sleep(1200);
  const m1 = (await api('GET', `/api/runs/${run.run_id}`)).events.length; await sleep(2500); const m2 = (await api('GET', `/api/runs/${run.run_id}`)).events.length;
  s = await pst();
  check(/已暂停/.test(s.state) && s.play === '继续研讨' && m1 === m2 && (await runStatus(run.run_id)) === 'paused', `研讨·暂停：不再推进（${m1}→${m2}），服务端 paused`);
  await click('#pl-play'); grew = false; for (let i = 0; i < 30 && !grew; i++) { await sleep(300); grew = (await api('GET', `/api/runs/${run.run_id}`)).events.length > m2; }
  check(grew, '研讨·继续：继续推进');
  await click('#pl-pause'); await sleep(900);
  const step = async () => Number((await pst()).time.match(/第 (\d+)\//)?.[1] || 0);
  const k0 = await step();
  await click('#pl-fwd'); await sleep(400); await waitFor(notFF, 60000);
  const k1 = await step();
  check(k1 > k0 && (await runStatus(run.run_id)) === 'paused', `研讨·快进：到下一研讨阶段 第 ${k0} → ${k1} 步，停住后服务端 paused`);
  const total = Number((await pst()).time.match(/\/(\d+)/)?.[1] || 0);
  await drag(0.7); await sleep(400); await waitFor(notFF, 60000); await sleep(1500);
  const k2 = await step();
  check(k2 >= Math.floor(total * 0.7) - 1, `研讨·向后拖动：快进到约 70%（第 ${k2}/${total} 步）`);
  const nAll = await count('#feed .sw-msg');
  await drag(0.25);
  s = await pst(); const nRv = await count('#feed .sw-msg'); const k3 = await step();
  check(/回看/.test(s.state) && nRv < nAll && k3 <= Math.ceil(total * 0.25) + 1, `研讨·向前拖动：回看第 ${k3} 步，显示 ${nRv}/${nAll} 条发言`);
  await click('#pl-back'); await sleep(500); const k4 = await step();
  check(k4 < k3 || k3 === 0, `研讨·回退：第 ${k3} → ${k4} 步`);
  await shot('P03-seminar-review');
  await click('#pl-play'); await sleep(700); s = await pst();
  check(!/回看/.test(s.state), `研讨·回到实时 ${s.state}`);
  await click('#pl-pause'); await sleep(700);
  await click('#finish'); await confirmModal();
  check((await runStatus(run.run_id)) === 'completed' && !(await pst()).pauseOn, '研讨·结束研讨：确认后服务端 completed');

  // ================= 数字教研室：任务自动执行 =================
  const LECTURE = readFileSync(new URL('../fixtures/机械质量检测讲义.txt', import.meta.url), 'utf8');
  const mat = await api('POST', '/api/materials', { filename: '播放器测试.txt', kind: 'courseware', data_base64: Buffer.from(LECTURE).toString('base64') });
  const job = await api('POST', '/api/jobs', { material_ids: [mat.material_id], outputs: ['lesson_plan'], classroom: false, revise: false, class_minutes: 15, pace: 'watch' });
  await go('/seminar'); await waitFor("/任务自动执行/.test(document.querySelector('#pl-state').textContent)", 20000); await sleep(1500);
  s = await pst();
  check(s.pauseOn && !s.fwdOn && s.endOn && s.end === '结束任务', `任务·执行中：可暂停、可结束，不能快进 ${JSON.stringify(s)}`);
  await click('#pl-pause'); await sleep(1200);
  check((await api('GET', `/api/jobs/${job.job_id}`)).status === 'paused' && (await pst()).play === '继续任务', '任务·暂停：服务端任务 paused');
  await click('#pl-back'); await sleep(600);
  check(/回看/.test((await pst()).state), '任务·回退：可回看已发生的研讨');
  await click('#pl-play'); await sleep(600);
  check(!/回看/.test((await pst()).state) && (await api('GET', `/api/jobs/${job.job_id}`)).status === 'paused', '任务·回到实时（任务仍保持暂停）');
  await click('#pl-play'); await sleep(1200);
  check((await api('GET', `/api/jobs/${job.job_id}`)).status === 'running', '任务·继续任务：服务端任务 running');
  await click('#finish'); await confirmModal();
  check((await api('GET', `/api/jobs/${job.job_id}`)).status === 'cancelled', '任务·结束任务：确认后服务端任务 cancelled');
  await shot('P04-seminar-job-ended');
} catch (e) { note(`FAIL ${e.message}`); console.log(e.stack); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
