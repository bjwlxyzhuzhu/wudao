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

// 智能体中心走查：固定教师与 3D 形象、自定义教师（模板 + 提示词）、资料训练全过程可视化、学生群体画像导入与分组、用画像开课、自定义教师入席研讨。
import { writeFileSync as wf } from 'node:fs';
const API = `const api=async(m,p,b)=>{const r=await fetch(p,{method:m,headers:{'content-type':'application/json','x-yz-csrf':'1'},body:b?JSON.stringify(b):undefined});return r.json();};`;
const api = (m, p, b) => js(`${API} return api(${JSON.stringify(m)}, ${JSON.stringify(p)}, ${b ? JSON.stringify(b) : 'undefined'});`);
async function setFiles(sel, paths) {
  const { root } = await cdp('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  await cdp('DOM.setFileInputFiles', { nodeId, files: paths });
  await js(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new Event('change', { bubbles: true }))`);
}
const tmp = mkdtempSync(join(tmpdir(), 'yz-ag-'));
const doc = join(tmp, `2025秋·说课稿-${Date.now()}.txt`);
wf(doc, `本次导入编号 ${Date.now()}
${readFileSync(new URL('../fixtures/机械质量检测讲义.txt', import.meta.url), 'utf8')}\n同学们想一想：为什么公差永远为正值？例如轴径 20±0.02 mm，公差就是 0.04 mm。联系人电话 13900001111。总之，检测数据必须真实可追溯，这是职业责任。`);
const csv = join(tmp, '机械2301班画像.csv');
wf(csv, `﻿代号,姓名,前测成绩,兴趣方向,发言活跃度,质疑倾向,合作倾向,常见误解\n${Array.from({ length: 30 }, (_, i) => `A${String(i + 1).padStart(2, '0')},某某${i},${35 + ((i * 7) % 60)},${['工程应用', '数据分析', '案例讨论'][i % 3]},${['高', '中', '低'][i % 3]},${['中', '高', '低', '中'][i % 4]},${(i % 5) + 1},${i % 6 === 0 ? '把公差和偏差混为一谈' : ''}`).join('\n')}\n`);
try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('DOM.enable');
  await viewport(1440, 900);
  await go('/login');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("['home','seminar','classroom'].forEach(k=>localStorage.setItem('yz-tour-'+k,'1')); localStorage.setItem('yz-theme','light'); localStorage.removeItem('yz-seats'); localStorage.removeItem('yz-class-profile');");
  for (const j of (await api('GET', '/api/jobs')).jobs) if (['running', 'paused'].includes(j.status)) await api('POST', `/api/jobs/${j.job_id}/cancel`, {});
  for (const m of ['seminar', 'classroom']) for (const r of (await api('GET', `/api/runs?module=${m}`)).runs) if (['running', 'paused', 'ready', 'awaiting_human'].includes(r.status)) await api('POST', `/api/runs/${r.run_id}/finish`, {});

  // ---- 教师智能体 ----
  await go('/agents'); await waitFor("document.querySelectorAll('.agc').length === 10");
  const t0 = await js("return { names: [...document.querySelectorAll('.agc h3')].slice(0, 8).map(h => h.firstChild.textContent), av: document.querySelectorAll('.agc .av3d, .agc .av-img').length }");
  check(t0.names.join('、') === '陈立诚、林知远、苏婉清、许嘉宁、周衡远、郑守真、高振宇、李一诺' && t0.av === 10, `8 位固定教师有固定姓名，10 张卡片均有形象 ${JSON.stringify(t0)}`);
  await shot('A01-agents-teachers');
  // 自定义教师：用“专业博导”模板
  await js("document.querySelector('.agc[data-k=custom1] [data-act=edit]').click()"); await waitFor("document.querySelector('#ce-preset')");
  await js("const s=document.querySelector('#ce-preset'); s.value='1'; s.dispatchEvent(new Event('change')); document.querySelector('#ce-person').value='顾怀瑾'; document.querySelector('#ce-on').checked=true;");
  await sleep(200); await shot('A02-custom-edit');
  await js("[...document.querySelectorAll('.modal .actions button')].at(-1).click()"); await sleep(900);
  const c1 = await js("const c=document.querySelector('.agc[data-k=custom1]'); return { h: c.querySelector('h3').textContent, off: c.classList.contains('agc-off') }");
  check(/顾怀瑾/.test(c1.h) && /专业博导/.test(c1.h) && !c1.off, `自定义教师“专业博导 · 顾怀瑾”已启用 ${JSON.stringify(c1)}`);
  // 资料训练：专业教师
  await js("document.querySelector('.agc[data-k=subject] [data-act=train]').click()"); await waitFor("document.querySelector('#tr-files')");
  const pr = await js("return document.querySelectorAll('.modal .principles li').length");
  check(pr === 8, `训练前展示 8 条数据采集原则（${pr}）`);
  await setFiles('#tr-files', [doc]); await sleep(200);
  const nTrain = (await api('GET', '/api/agents/subject')).trainings.length;
  await js("[...document.querySelectorAll('.modal .actions button')].at(-1).click()"); await sleep(500);
  const blocked = (await api('GET', '/api/agents/subject')).trainings.length === nTrain && !(await js("return !!document.querySelector('.trv-pipe li.running')"));
  check(blocked, '未勾选采集原则时不能开始训练');
  await js("document.querySelector('#tr-consent').click(); [...document.querySelectorAll('.modal .actions button')].at(-1).click()");
  await waitFor("document.querySelector('.trv-pipe li.running')", 8000);
  await sleep(1200); await shot('A03-training-running');
  await waitFor("document.querySelectorAll('.trv-pipe li.done').length === 8", 30000); await sleep(800);
  const tv = await js("return { stats: [...document.querySelectorAll('.trv-stats div')].map(d=>d.innerText.split(String.fromCharCode(10)).join(' ')), terms: document.querySelectorAll('.trv-charts .trv-box:first-child .trv-bar').length, profile: document.querySelector('.modal .agc-style')?.textContent || '', docs: document.querySelectorAll('#tr-docs tbody tr').length }");
  check(tv.terms > 0 && /人设画像/.test(tv.profile) && tv.docs >= 1 && tv.stats.some((x) => /隐去个人信息/.test(x) && !/^—/.test(x)), `训练完成：8 阶段、统计、高频主题、风格画像与资料列表 ${JSON.stringify(tv)}`);
  await js("document.querySelector('.modal .mbody').parentElement.scrollTop = 99999"); await sleep(200);
  await shot('A04-training-done');
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='关闭').click()"); await sleep(600);
  check(await js("return /已训练/.test(document.querySelector('.agc[data-k=subject] .agc-badge').textContent)"), '卡片显示“已训练 · N 份资料”');

  // ---- 学生群体画像 ----
  await js("document.querySelector('.agp-tabs [data-tab=students]').click()"); await waitFor("document.querySelectorAll('.stu-card').length === 40");
  await js("document.querySelector('#cp-import').click()"); await waitFor("document.querySelector('#cp-file')");
  await setFiles('#cp-file', [csv]);
  await js("document.querySelector('#cp-name').value='机械2301班'; document.querySelector('#cp-gs').value='5'; document.querySelector('#cp-consent').click(); [...document.querySelectorAll('.modal .actions button')].at(-1).click()");
  await waitFor("document.querySelector('.cp-pipe')", 8000); await sleep(3200);
  const cp = await js("return { stages: document.querySelectorAll('.cp-pipe li.done').length, rows: document.querySelectorAll('.cp-assign tbody tr').length, first: document.querySelector('.cp-assign tbody tr')?.innerText.split(String.fromCharCode(9)).join(' ') || '', privacy: [...document.querySelectorAll('.cp-pipe li small')].map(s=>s.textContent).join(' / ') }");
  check(cp.stages === 6 && cp.rows === 30 && /丢弃列：姓名/.test(cp.privacy) && !/某某/.test(cp.first), `群体数据：6 个处理阶段、30 行分配到学生智能体、姓名列已丢弃 ${JSON.stringify({ ...cp, privacy: cp.privacy.slice(0, 80) })}`);
  await shot('A05-class-profile');
  await js("[...document.querySelectorAll('.modal .actions button')].at(-1).click()"); await waitFor("location.pathname === '/classroom'", 8000); await sleep(1500);
  const sel = await js("return { v: document.querySelector('#cl-groups').value, size: document.querySelector('.cl-gsel b').textContent }");
  check(/^profile:/.test(sel.v) && sel.size === '30人', `演课场已选中班级画像 ${JSON.stringify(sel)}`);
  await click('#pl-play'); await waitFor("document.querySelectorAll('.cl-group').length === 6", 15000); await sleep(1500);
  const run = (await api('GET', '/api/runs?module=classroom')).runs[0];
  const v = await api('GET', `/api/runs/${run.run_id}`);
  const studs = v.profiles.filter((p) => p.kind === 'student_agent');
  check(studs.length === 30 && studs[0].traits.profile_code && v.run.config.class_profile_id, `按画像开课：30 名学生智能体（6 组），逐人参数来自画像（第 1 位对应 ${studs[0].traits.profile_code}）`);
  await shot('A06-classroom-profile');
  await click('#pl-pause'); await sleep(600); await js("document.querySelector('#finish').click()"); await sleep(300); await js("const b=[...document.querySelectorAll('.modal .actions button')].at(-1); if(b) b.click();"); await sleep(900);
  await js("localStorage.removeItem('yz-class-profile')");

  // ---- 自定义教师入席研讨 ----
  const seats = ['leader', 'designer', 'subject', 'ideology', 'assessor', 'evidence', 'industry', 'junior', 'custom1'];
  const r = await api('POST', '/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'lesson_plan', seats, material_ids: (await api('GET', '/api/materials')).materials.slice(0, 1).map((m) => m.material_id), kp_limit: 1 });
  await go(`/seminar?run=${r.run_id}`); await waitFor("document.querySelectorAll('.sw-agent').length === 9", 10000);
  await click('#pl-play'); await sleep(9000); await click('#pl-pause'); await sleep(600);
  const cs = await js("const c=document.querySelector('.sw-agent.custom'); return { name: c?.querySelector('.sw-an b')?.textContent, cited: [...document.querySelectorAll('#feed .sw-msg')].some(m=>/我以往的教学资料《/.test(m.textContent)), custSpoke: [...document.querySelectorAll('#feed .sw-msg')].some(m=>/顾怀瑾/.test(m.querySelector('.sw-mh b')?.textContent||'')) }");
  check(/顾怀瑾/.test(cs.name || '') && cs.cited, `自定义教师入席（虚线卡）；专业教师发言引用了训练资料 ${JSON.stringify(cs)}`);
  await js("document.querySelector('.sw-room').scrollIntoView({block:'center'})"); await sleep(400);
  await shot('A07-seminar-custom-teacher');
  await api('POST', `/api/runs/${r.run_id}/finish`, {});
} catch (e) { note(`FAIL ${e.message}`); console.log(e.stack); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
