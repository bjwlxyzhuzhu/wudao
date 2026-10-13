// Real-browser walkthrough via Chrome DevTools Protocol (no npm deps): 科研数据中心、产物库分组、盲评、表格智能导入。
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

// 科研数据中心与产物库走查：产物库分组筛选；研究项目 → 名册智能导入（姓名列忽略）→ 退出 → 量表题项与作答导入 → α；话语转录导入与盲编 → κ；盲评模式；产物表格导入。
// 测试项目以“【E2E测试】”命名，结束时删除；产物表格导入只填入编辑区、不保存。
import { writeFileSync as wf } from 'node:fs';
const API = `const api=async(m,p,b)=>{const r=await fetch(p,{method:m,headers:{'content-type':'application/json','x-yz-csrf':'1'},body:b?JSON.stringify(b):undefined});return r.json();};`;
const api = (m, p, b) => js(`${API} return api(${JSON.stringify(m)}, ${JSON.stringify(p)}, ${b ? JSON.stringify(b) : 'undefined'});`);
async function setFiles(sel, paths) {
  const { root } = await cdp('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  await cdp('DOM.setFileInputFiles', { nodeId, files: paths });
  await js(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new Event('change', { bubbles: true }))`);
}
const tmp = mkdtempSync(join(tmpdir(), 'yz-rs-'));
const f = (name, text) => { const p = join(tmp, name); wf(p, `﻿${text}`); return p; };
const roster = f('名册.csv', `编号,姓名,组别,性别,是否签署知情同意书\n${Array.from({ length: 8 }, (_, i) => `P${String(i + 1).padStart(2, '0')},某某${i},${i < 4 ? 'EXP' : 'CTL'},${i % 2 ? '男' : '女'},同意`).join('\n')}\nP09,某某9,XYZ,女,同意\n`);
const items = f('题项.csv', '题号,维度,题目,反向\nSE1,A,我能把价值目标写成可观察的行为,否\nSE2,A,我能为思政目标设计评价证据,否\nSE3,A,我很难把思政元素和专业内容联系起来,是\nSE4,B,我愿意在教研中分享设计,否\n');
const resp = f('作答.csv', `被试编码,时间点,Q1,SE2,第3题,SE4\n${[[4, 4, 2, 3], [5, 4, 1, 4], [2, 3, 4, 2], [3, 3, 3, 3], [4, 5, 2, 4], [2, 2, 4, 3], [3, 4, 2, 3], [5, 5, 1, 5]].map((r, i) => `P${String(i + 1).padStart(2, '0')},前测,${r.join(',')}`).join('\n')}\n`);
const trans = f('转录.csv', '课次,序号,说话人,话语\nL1,1,T,同学们先看这个零件的图纸。\nL1,2,S01,老师我觉得公差是0.04\nL1,3,T,为什么？依据是什么？\nL1,4,S02,因为上偏差减下偏差。\nL1,5,T,很好，那检测数据能不能改？\nL1,6,S01,不能，数据必须真实可追溯。\n');
const codes = f('编码表.csv', '代码,名称,定义\nI,发起,教师提问或布置任务\nR,回应,学生回答\nF,反馈,教师评价或追问\n');
let pid = null;
async function importVia(btnSel, file, { skip = false } = {}) {
  await js(`document.querySelector(${JSON.stringify(btnSel)}).click()`); await waitFor("document.querySelector('#io-file')");
  await setFiles('#io-file', [file]); await waitFor("document.querySelector('.io-map')", 8000); await sleep(300);
  if (skip) await js("const s=document.querySelector('#io-skip'); if(s) s.checked=true;");
  const info = await js("return { cols: [...document.querySelectorAll('.io-map tbody tr')].map(tr=>[tr.cells[0].textContent, tr.querySelector('select').value]), sum: document.querySelector('.io-sum').innerText, pii: document.querySelector('.io-pv, #io-pv .notice')?.innerText || '' }");
  return info;
}
const commit = async () => { await js("[...document.querySelectorAll('.modal .actions button')].at(-1).click()"); await sleep(1200); };
try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('DOM.enable');
  await viewport(1440, 900);
  await go('/login');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("['home','seminar','classroom'].forEach(k=>localStorage.setItem('yz-tour-'+k,'1')); localStorage.setItem('yz-theme','light'); localStorage.removeItem('yz-lib'); localStorage.setItem('yz-blind','0'); localStorage.removeItem('yz-coder');");
  for (const p of (await api('GET', '/api/research/projects')).projects) if (/^【E2E测试】/.test(p.title)) await api('DELETE', `/api/research/projects/${p.project_id}`);

  // ---- 产物库：分组、筛选、版本线折叠 ----
  await go('/library'); await waitFor("document.querySelector('.lib-group')", 8000);
  const lib = await js("return { groups: document.querySelectorAll('.lib-group').length, subs: [...document.querySelectorAll('.lib-subh')].map(h=>h.childNodes[1]?.textContent).slice(0,6), cards: document.querySelectorAll('.lib-card').length, versions: document.querySelectorAll('.lib-vers').length, head: document.querySelector('h1').nextElementSibling.textContent }");
  check(lib.groups >= 1 && lib.subs.length >= 2 && lib.cards > 0 && /条版本线/.test(lib.head), `产物库按课程分组、组内按层级分组，版本线折叠 ${JSON.stringify(lib)}`);
  await shot('R01-library-grouped');
  await js("const s=document.querySelector('#lf-group'); s.value='level'; s.dispatchEvent(new Event('change'))"); await sleep(300);
  const lv = await js("return [...document.querySelectorAll('.lib-group > summary b')].map(b=>b.textContent)");
  const order = ['专业层', '课程层', '课堂层', '练习与评价', '反馈与反思', '知识图谱', '其他'];
  check(lv.length >= 2 && lv.every((x, i) => i === 0 || order.indexOf(x) > order.indexOf(lv[i - 1])), `按层级分组且顺序为 专业→课程→课堂→评价→反馈 ${JSON.stringify(lv)}`);
  await js("const s=document.querySelector('#lf-level'); s.value='assess'; s.dispatchEvent(new Event('change'))"); await sleep(300);
  const onlyAssess = await js("const c=[...document.querySelectorAll('.lib-card')]; return c.length>0 && c.every(x=>x.dataset.level==='assess')");
  check(onlyAssess, '层级筛选“练习与评价”只显示试卷与练习');
  const nLatest = await js("return document.querySelectorAll('.lib-card').length"); await js("document.querySelector('#lf-latest').click()"); await sleep(300);
  const nAll = await js("return document.querySelectorAll('.lib-card').length");
  check(nAll >= nLatest, `取消“只显示最新版”后显示全部版本（${nLatest} → ${nAll}）`);

  // ---- 科研数据中心：新建项目 ----
  await go('/research'); await waitFor("document.querySelector('#rs-new')");
  await click('#rs-new'); await waitFor("document.querySelector('#np-t')");
  await type('#np-t', '【E2E测试】多智能体数字教研对课程思政设计能力的影响'); await type('#np-c', 'E2ET');
  await js("const s=document.querySelector('#np-f'); s.value='教育技术学'; s.dispatchEvent(new Event('change'))");
  await commit(); await waitFor("document.querySelector('#pf')", 8000);
  pid = new URL(await js('return location.href')).searchParams.get('p');
  const ov = await js("return { tabs: [...document.querySelectorAll('.rs-tabs button')].map(b=>b.textContent), checks: document.querySelectorAll('.rs-check li').length, cond: document.querySelector('textarea[name=conditions]').value, tp: document.querySelector('textarea[name=timepoints]').value }");
  check(ov.tabs.length === 6 && ov.checks >= 8 && /EXP=实验组/.test(ov.cond) && /T0=前测/.test(ov.tp), `新建项目：6 个页签、发表前自检、默认组别与时间点 ${JSON.stringify(ov)}`);
  await type('textarea[name=rqs]', 'RQ1：平台研课能否提升教师课程思政教学设计能力？'); await type('input[name=e_body]', '某校伦理委员会'); await type('input[name=e_number]', 'TEST-0001');
  await js("document.querySelector('#pf').requestSubmit()"); await sleep(900);
  const eth = await js("return [...document.querySelectorAll('.rs-check li')].find(li=>/伦理审查/.test(li.textContent)).className");
  check(eth === 'ok', `保存后“伦理审查”自检通过（${eth}）`);
  await shot('R02-research-design');

  // ---- 被试名册：智能导入（姓名列被忽略、组别校验）→ 退出 ----
  await js("document.querySelector('[data-tab=participants]').click()"); await waitFor("document.querySelector('.io-bar[data-io=participants] .io-imp')");
  const im = await importVia('.io-bar[data-io=participants] .io-imp', roster, { skip: true });
  const pii = await js("return [...document.querySelectorAll('#io-pv .notice')].map(n=>n.textContent).join(' ')");
  const map = Object.fromEntries(im.cols);
  check(map['编号'] === 'code' && map['姓名'] === '' && map['组别'] === 'condition' && map['是否签署知情同意书'] === 'consent' && /姓名/.test(pii) && /有问题 1/.test(im.sum), `名册：表头自动对应，姓名列被忽略，未设置的组别 XYZ 被标出 ${JSON.stringify({ map, sum: im.sum })}`);
  await shot('R03-import-roster');
  await commit(); await waitFor("document.querySelectorAll('[data-consent]').length === 8", 8000);
  await js("const s=document.querySelector('[data-consent]'); s.value='withdrawn'; s.dispatchEvent(new Event('change'))"); await sleep(1200);
  const wd = await js("return { dim: document.querySelectorAll('tr.rs-dim').length, purge: !!document.querySelector('[data-purge]'), flow: document.querySelector('.rs-flow').innerText.split(String.fromCharCode(10)).join('') }");
  check(wd.dim === 1 && wd.purge && /7已同意/.test(wd.flow), `一名被试退出：行变灰、可删除其数据、流程计数更新 ${JSON.stringify(wd)}`);

  // ---- 量表：题项与作答导入 → α ----
  const inst = await api('POST', '/api/research/instruments', { project_id: pid, kind: 'scale', name: '课程思政设计效能感（自编·测试）', code: 'SE', scale: [1, 5], source_status: 'self_developed' });
  await go(`/research?p=${pid}&tab=instruments&i=${inst.instrument.instrument_id}`); await waitFor("document.querySelector('.io-bar[data-io=scale_items] .io-imp')", 8000);
  await importVia('.io-bar[data-io=scale_items] .io-imp', items); await commit(); await waitFor("document.querySelectorAll('#in-detail tbody tr').length === 4", 8000);
  const ri = await importVia('.io-bar[data-io=responses] .io-imp', resp, { skip: true });
  check(ri.cols.map((c) => c[1]).join(',') === 'participant_code,timepoint,item:SE1,item:SE2,item:SE3,item:SE4', `作答宽表：Q1/第3题等表头识别为题项 ${JSON.stringify(ri.cols)}`);
  await commit(); await sleep(800);
  await js("document.querySelector('#in-an').click()"); await waitFor("document.querySelector('#in-res table')", 8000);
  const an = await js("return { head: document.querySelector('#in-res p').textContent, rows: [...document.querySelectorAll('#in-res table:first-of-type tr')].slice(1).map(tr=>[...tr.cells].slice(0,5).map(c=>c.textContent).join('|')) }");
  check(an.rows.length === 2 && an.rows.some((r) => /^T0\|A\|3\|7\|0\.\d+/.test(r)) && /排除/.test(an.head), `α 按维度计算（退出者作答已排除，反向题已反转）${JSON.stringify(an)}`);
  await js("document.querySelector('#in-res').scrollIntoView({block:'start'})"); await sleep(300);
  await shot('R04-scale-alpha');

  // ---- 话语编码：导入转录 → 两位编码者盲编 → κ ----
  await go(`/research?p=${pid}&tab=coding`); await waitFor("document.querySelector('.io-bar[data-io=units] .io-imp')", 8000);
  await importVia('.io-bar[data-io=units] .io-imp', trans); await commit(); await sleep(600);
  const cb = await api('POST', '/api/research/codebooks', { project_id: pid, name: 'IRF', mode: 'exclusive', framework: 'Sinclair & Coulthard (1975)' });
  await go(`/research?p=${pid}&tab=coding&cb=${cb.codebook.codebook_id}`); await waitFor("document.querySelector('.io-bar[data-io=codes] .io-imp')", 8000);
  await importVia('.io-bar[data-io=codes] .io-imp', codes); await commit(); await waitFor("document.querySelectorAll('.rs-code').length === 3", 8000);
  const codeAs = async (coder, seq) => {
    await type('#cd-coder', coder); await waitFor(`document.querySelector('.rs-units[data-coder="${coder}"]') && document.querySelectorAll('.rs-unit').length === 6`, 8000);
    for (let i = 0; i < 6; i++) { await js(`document.querySelectorAll('.rs-unit')[${i}].querySelector('.chip[data-code="${seq[i]}"]').click()`); await sleep(250); }
  };
  await codeAs('C1', ['I', 'R', 'F', 'R', 'F', 'R']);
  await shot('R05-coding-blind');
  await codeAs('C2', ['I', 'R', 'I', 'R', 'F', 'R']);
  const blindOk = await js("return [...document.querySelectorAll('.rs-unit')].map(u=>[...u.querySelectorAll('.chip.on')].map(c=>c.dataset.code).join('')).join(',')");
  check(blindOk === 'I,R,I,R,F,R', `盲编：C2 只看到自己的编码 ${blindOk}`);
  await js("document.querySelector('#cd-irr').click()"); await waitFor("document.querySelector('#cd-res table')", 8000);
  const k = await js("return document.querySelector('#cd-res').innerText");
  check(/C1 × C2/.test(k) && /0\.833/.test(k) && /Krippendorff/.test(k), `编码者一致性：一致率 .833、κ 与 α、分歧清单 ${k.slice(0, 160).split(String.fromCharCode(10)).join(' / ')}`);
  await js("document.querySelector('#cd-res').scrollIntoView({block:'center'})"); await sleep(300);
  await shot('R06-coding-irr');

  // ---- 盲评模式 ----
  await go('/rating?blind=1'); await waitFor("document.querySelector('#blind')", 8000); await sleep(500);
  const bl = await js("return { on: document.querySelector('#blind').checked, first: document.querySelector('[data-ev] .small')?.textContent || '', sel: document.querySelector('#run-sel option')?.textContent || '', io: !!document.querySelector('.io-bar[data-io=ratings]') }");
  check(bl.on && /^待评 1$/.test(bl.first) && !/真实模型|演示|:/.test(bl.sel) && bl.io, `盲评：隐藏发言者/生成方式/时间，提供评分导入导出 ${JSON.stringify(bl)}`);
  await shot('R07-rating-blind');
  await js("localStorage.setItem('yz-blind','0')");

  // ---- 产物表格：导入到编辑区（不保存）----
  const arts = (await api('GET', '/api/artifacts')).artifacts;
  const lp = arts.find((a) => a.type === 'lesson_plan' && a.module === 'seminar') || arts[0];
  await go(`/library?id=${lp.artifact_id}`); await waitFor("document.querySelector('.io-bar[data-io=artifact_section]')", 8000);
  const secInfo = await js("const bar=document.querySelector('.io-bar[data-io=artifact_section]'); const sec=bar.closest('section'); return { key: JSON.parse(bar.dataset.ctx).section_key, heads: [...sec.querySelectorAll('thead th')].map(t=>t.textContent.replace(' 🔒','')).filter(Boolean), rows: sec.querySelectorAll('tbody tr').length }");
  const tbl = f('表格.csv', `${secInfo.heads.join(',')}\n${secInfo.heads.map((h, i) => `导入${i}`).join(',')}\n`);
  await importVia(`#sec-${secInfo.key} .io-imp`, tbl);
  await commit(); await sleep(600);
  const after = await js(`return document.querySelectorAll('#sec-${secInfo.key} tbody tr').length`);
  check(after === secInfo.rows + 1, `产物表格导入：按列名填入编辑区 ${secInfo.rows} → ${after} 行（未保存）`);
  await js(`document.querySelector('#sec-${secInfo.key}').scrollIntoView({block:'center'})`); await sleep(300);
  await shot('R08-artifact-table-import');

  // ---- 研课场：学情依据可选班级画像 ----
  const cat = await api('GET', '/api/catalog');
  check(Array.isArray(cat.class_profiles), `研课场新建研讨可选择班级画像作为学情依据（现有 ${cat.class_profiles.length} 份）`);
} catch (e) { note(`FAIL ${e.message}`); console.log(e.stack); process.exitCode = 1; }
finally {
  try { if (pid) await api('DELETE', `/api/research/projects/${pid}`); note('已删除测试项目'); } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* gone */ }
}
