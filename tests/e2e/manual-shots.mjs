// 演示型操作手册截图（Chrome DevTools Protocol，无 npm 依赖）：一门课从大纲 → 课件 → 课堂往返，班级与教师数据，量规与科研数据。
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

// 演示型操作手册截图：一门课（电工电子技术 · 基尔霍夫定律）从大纲 → 课件 → 课堂 → 反馈修订 → 班级与教师训练后第二轮上课 → 盲评、量规、科研数据导入导出。
// 截图保存到 public/manual/img（JPEG）。科研演示项目以“【演示】”命名，结束时删除；不提交任何人工评分。
import { writeFileSync as wf } from 'node:fs';
const API = `const api=async(m,p,b)=>{const r=await fetch(p,{method:m,headers:{'content-type':'application/json','x-yz-csrf':'1'},body:b?JSON.stringify(b):undefined});return r.json();};`;
const api = (m, p, b) => js(`${API} return api(${JSON.stringify(m)}, ${JSON.stringify(p)}, ${b ? JSON.stringify(b) : 'undefined'});`);
async function setFiles(sel, paths) {
  const { root } = await cdp('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  await cdp('DOM.setFileInputFiles', { nodeId, files: paths });
  await js(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new Event('change', { bubbles: true }))`);
}
const IMG = arg('img', 'public/manual/img'); mkdirSync(IMG, { recursive: true });
const DEMO = new URL('../../public/manual/demo/', import.meta.url);
const demo = (n) => decodeURIComponent(new URL(n, DEMO).pathname).replace(/^\/([A-Za-z]:)/, '$1');
async function snap(name) { await js("document.querySelectorAll('.toast').forEach(t=>t.remove())"); await sleep(150); const r = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 80 }); wf(join(IMG, `${name}.jpg`), Buffer.from(r.data, 'base64')); note(`snap ${name}.jpg`); }
async function hl(...sels) {
  await js(`if(!document.getElementById('demo-hl-css')){const s=document.createElement('style');s.id='demo-hl-css';s.textContent='.demo-hl{outline:4px solid #ff2d55 !important;outline-offset:3px;border-radius:10px;box-shadow:0 0 0 9px rgba(255,45,85,.18) !important;position:relative;z-index:5}';document.head.appendChild(s);}
    document.querySelectorAll('.demo-hl').forEach(e=>e.classList.remove('demo-hl'));
    ${JSON.stringify(sels)}.forEach((q,i)=>{const el=document.querySelector(q); if(el){el.classList.add('demo-hl'); if(i===0) el.scrollIntoView({block:'center'});}});`); await sleep(350);
}
const lastBtn = () => js("[...document.querySelectorAll('.modal .actions button')].at(-1).click()");
const waitRun = async (id, ms = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await api('GET', `/api/runs/${id}`); if (['completed', 'cancelled', 'failed'].includes(v.run.status)) return v; await sleep(1000); } throw new Error('run timeout'); };
let pid = null;
try {
  await connect(); await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('DOM.enable');
  await viewport(1440, 900);
  // 登录页：思思（登录前用本地知识库回答）与注册时选择头像
  await go('/login'); await waitFor("document.querySelector('#sisi-orb')", 8000); await js("localStorage.setItem('yz-sisi-seen','1'); localStorage.setItem('yz-sisi-voice','0'); sessionStorage.clear();");
  if (await js("return !!document.querySelector('#reg')")) { await click('#reg'); await waitFor("document.querySelector('.ava-pick')"); await js("document.querySelector('input[name=reg-ava][value=u05]').click()"); await sleep(300); await hl('.modal .ava-pick'); await snap('00-register-avatar'); await js("document.querySelector('.modal .actions button').click()"); await sleep(300); }
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("['home','seminar','classroom','library','agents'].forEach(k=>localStorage.setItem('yz-tour-'+k,'1')); localStorage.setItem('yz-theme','light'); localStorage.setItem('yz-exec-mode','demo'); localStorage.removeItem('yz-lib'); localStorage.setItem('yz-blind','0'); localStorage.removeItem('yz-class-profile'); localStorage.removeItem('yz-seats'); localStorage.setItem('yz-fs','m');");
  for (const j of (await api('GET', '/api/jobs')).jobs) if (['running', 'paused'].includes(j.status)) await api('POST', `/api/jobs/${j.job_id}/cancel`, {});
  for (const m of ['seminar', 'classroom']) for (const r of (await api('GET', `/api/runs?module=${m}`)).runs) if (['running', 'paused', 'ready', 'awaiting_human'].includes(r.status)) await api('POST', `/api/runs/${r.run_id}/finish`, {});
  for (const p of (await api('GET', '/api/research/projects')).projects) if (/^【演示】/.test(p.title)) await api('DELETE', `/api/research/projects/${p.project_id}`);

  if (arg('only') !== '3') {
  // ===== 主线一：大纲 → 课件 → 课堂 → 反馈修订 =====
  await go('/'); await sleep(1200); await hl('.hx-card.seminar', '.hdr-manual'); await snap('01-home');
  await js("sessionStorage.removeItem('yz-sisi-history'); document.querySelectorAll('.demo-hl').forEach(e=>e.classList.remove('demo-hl'))"); await click('#sisi-orb'); await waitFor("!document.querySelector('#sisi-panel').hidden");
  await js("const t=document.querySelector('#sisi-q'); t.value='怎么把课件送到演课场上课？'; document.querySelector('#sisi-form').requestSubmit()");
  await waitFor("document.querySelectorAll('#sisi-msgs .sisi-m.a').length >= 2 && !document.querySelector('.sisi-typing')", 20000); await sleep(400);
  await snap('01b-sisi'); await click('#sisi-close'); await sleep(300);
  await go('/seminar'); await waitFor("document.querySelector('#new-run')", 10000); await sleep(600);
  await hl('#new-run', '#mode-top'); await snap('02-seminar-new');
  await click('#new-run'); await waitFor("document.querySelector('#w-file')", 8000);
  await setFiles('#w-file', [demo('电工电子技术讲义.txt')]);
  await waitFor("document.querySelector('#w-analysis .wiz-card')", 15000); await sleep(600);
  await js("const set=(k,v)=>{const c=document.querySelector(`[data-out=${k}]`); if(c.checked!==v){c.checked=v; c.dispatchEvent(new Event('change'));}}; set('lesson_plan',false); set('exercises',false); set('syllabus',true); set('courseware',true); const p=document.querySelector('#w-primary'); p.value='syllabus'; p.dispatchEvent(new Event('change'));");
  await sleep(800);
  await hl('#w-analysis .wiz-card'); await snap('03-task-import');
  await hl('.wiz-outs', '#w-primary', '#w-cp'); await snap('04-task-outputs');
  const before = (await api('GET', '/api/jobs')).jobs.map((j) => j.job_id);
  await lastBtn();
  let job = null; for (let i = 0; i < 40 && !job; i++) { job = (await api('GET', '/api/jobs')).jobs.find((j) => !before.includes(j.job_id)); if (!job) await sleep(300); }
  for (let i = 0; i < 300; i++) { job = await api('GET', `/api/jobs/${job.job_id}`); if (['completed', 'failed'].includes(job.status)) break; await sleep(500); }
  check(job.status === 'completed', `任务完成：${job.steps.map((s) => s.label).join(' → ')}`);
  await go('/seminar'); await sleep(2500); await hl('.job'); await snap('05-task-done');
  const sylId = job.steps.find((s) => s.key === 'discuss').artifact_ids[0], cwId = job.steps.find((s) => s.type === 'courseware').artifact_ids[0];
  await go('/library?q=电工电子'); await waitFor("document.querySelector('.lib-group')", 8000); await sleep(500); await hl('.lib-group'); await snap('06-library');
  await go(`/library?id=${sylId}`); await waitFor("document.querySelector('#sec-learners')", 8000); await sleep(500); await hl('#sec-learners'); await snap('07-syllabus');
  await go(`/library?id=${cwId}`); await waitFor("document.querySelector('#to-class')", 8000); await sleep(500); await hl('#to-class'); await snap('08-courseware');
  await click('#to-class'); await sleep(500); await lastBtn(); await waitFor("location.pathname === '/classroom'", 10000);
  await waitFor("document.querySelector('#pl-play') && !document.querySelector('#pl-play').disabled", 10000); await sleep(1500);
  await hl('#pl-play', '.cl-gsel'); await snap('09-classroom-ready');
  await js("document.querySelector('[data-speed=\"20\"]')?.click()"); await click('#pl-play'); await waitFor("document.querySelectorAll('.cl-group').length >= 6", 15000); await sleep(14000);
  await js("document.querySelectorAll('.demo-hl').forEach(e=>e.classList.remove('demo-hl')); window.scrollTo(0,0)"); await snap('10-classroom-live');
  await click('#pl-pause'); await sleep(800); await click('#finish'); await sleep(400); await js("const b=[...document.querySelectorAll('.modal .actions button')].at(-1); if(b) b.click();"); await sleep(1200);
  await click('#fb'); await waitFor("[...document.querySelectorAll('.modal .actions button')].some(b=>/返回研课场/.test(b.textContent))", 10000); await sleep(400);
  await hl('.modal .actions button.primary'); await snap('11-feedback');
  await lastBtn(); await waitFor("location.pathname === '/seminar'", 10000);
  const revRun = new URL(await js('return location.href')).searchParams.get('run');
  await sleep(6000); await js("document.querySelectorAll('.demo-hl').forEach(e=>e.classList.remove('demo-hl'))"); await snap('12-revise-running');
  await waitRun(revRun); await go(`/seminar?run=${revRun}`); await sleep(2000);
  if (!(await js("return !!document.querySelector('#accept')"))) await js("const b=[...document.querySelectorAll('#sw-tabs button')].find(x=>/成果/.test(x.textContent)); if(b) b.click();");
  await sleep(600);
  if (await js("return !!document.querySelector('#accept')")) { await hl('#accept'); await snap('13-accept'); await click('#accept'); await sleep(1500); }
  else { note('未找到 #accept，改用接口确认'); await api('POST', `/api/runs/${revRun}/accept`, {}); }
  const cw2 = (await api('GET', '/api/home')).current.seminar;
  check(cw2.type === 'courseware' && cw2.version >= 2, `修订后的课件成为研课场当前产物（v${cw2.version}）`);
  await go(`/library?id=${cw2.artifact_id}`); await waitFor("document.querySelector('#to-class')", 8000);
  await js("document.querySelector('details.panel')?.setAttribute('open','')"); await sleep(300); await hl('details.panel', '#to-class'); await snap('14-courseware-v2');

  // ===== 主线二：班级与教师 / 学生智能体数据 =====
  await go('/agents'); await waitFor("document.querySelectorAll('.agc').length === 10", 10000); await sleep(600);
  await hl('.agc[data-k=subject] [data-act=train]'); await snap('15-agents');
  await js("document.querySelector('.agc[data-k=subject] [data-act=train]').click()"); await waitFor("document.querySelector('#tr-files')");
  await setFiles('#tr-files', [demo('专业教师说课稿-演示用示例.txt')]); await js("document.querySelector('#tr-consent').click()"); await sleep(300);
  await hl('.modal .principles', '#tr-consent'); await snap('16-train-principles');
  await lastBtn(); await waitFor("document.querySelectorAll('.modal .trv-pipe li.done').length === 8 && /已完成/.test(document.querySelector('.modal .trv-box h4')?.textContent || '')", 60000); await sleep(1000);
  await js("document.querySelector('.modal').scrollTop = 0"); await hl('.trv-pipe'); await snap('17-train-done');
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='关闭').click()"); await sleep(600);
  await js("document.querySelector('.agp-tabs [data-tab=students]').click()"); await waitFor("document.querySelectorAll('.stu-card').length === 40");
  await js("document.querySelector('#cp-import').click()"); await waitFor("document.querySelector('#cp-file')");
  await setFiles('#cp-file', [demo('电气2401班画像-演示用虚构数据.csv')]);
  await js("document.querySelector('#cp-name').value='电气2401班（演示）'; document.querySelector('#cp-gs').value='5'; document.querySelector('#cp-consent').click(); [...document.querySelectorAll('.modal .actions button')].at(-1).click()");
  await waitFor("document.querySelector('.cp-pipe')", 8000); await sleep(3500); await hl('.cp-pipe'); await snap('18-class-profile');
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>/关闭|完成|稍后/.test(b.textContent))?.click() || document.querySelector('.modal-back')?.remove()"); await sleep(500);
  // 第二轮：修订后的课件 + 班级画像 + 训练后的教师
  await go(`/library?id=${cw2.artifact_id}`); await waitFor("document.querySelector('#to-class')", 8000);
  await click('#to-class'); await sleep(500); await lastBtn(); await waitFor("location.pathname === '/classroom'", 10000);
  await waitFor("document.querySelector('#cl-groups')", 10000); await sleep(1000);
  await js("const s=document.querySelector('#cl-groups'); const o=[...s.options].find(x=>/^profile:/.test(x.value) && /电气2401/.test(x.textContent)); s.value=o.value; s.dispatchEvent(new Event('change'))"); await sleep(800);
  await hl('.cl-gsel', '#pl-play'); await snap('19-classroom-profile');
  await js("document.querySelector('[data-speed=\"20\"]')?.click()"); await click('#pl-play'); await waitFor("document.querySelectorAll('.cl-group').length >= 6", 15000); await sleep(14000);
  await js("document.querySelectorAll('.demo-hl').forEach(e=>e.classList.remove('demo-hl')); window.scrollTo(0,0)"); await snap('20-classroom-round2');
  await click('#pl-pause'); await sleep(600);

  }
  // ===== 主线三：量规、盲评、科研数据 =====
  await go('/rating?blind=1'); await waitFor("document.querySelector('#blind')", 10000); await sleep(600);
  await type('#rater', 'R01');
  await js("document.querySelectorAll('.side fieldset').forEach(f=>{const r=f.querySelector('input[value=\"3\"]')||f.querySelector('input[type=radio]'); if(r) r.checked=true;})");
  await hl('.rate-tools', '#rater'); await snap('21-blind-rating');
  await click('#imp'); await waitFor("document.querySelector('#rj')");
  await js(`document.querySelector('#rj').value = ${JSON.stringify(readFileSync(demo('课件思政融入量规-演示用.json'), 'utf8'))};`);
  await js("[...document.querySelectorAll('.modal .actions button')][1].click()"); await waitFor("document.querySelector('#rpv .notice')", 8000);
  await hl('#rpv .notice'); await snap('22-rubric-import');
  await js("document.querySelector('.modal .actions button').click()"); await sleep(600);
  // 科研项目
  await go('/research'); await waitFor("document.querySelector('#rs-new')"); await click('#rs-new'); await waitFor("document.querySelector('#np-t')");
  await type('#np-t', '【演示】电工电子技术课堂学习体验调查'); await type('#np-c', 'DEMO1'); await lastBtn(); await waitFor("document.querySelector('#pf')", 8000);
  await waitFor("document.querySelector('#pf input[name=title]')?.value.includes('【演示】')", 10000);
  pid = new URL(await js('return location.href')).searchParams.get('p');
  await type('textarea[name=rqs]', 'RQ1：两组学生的课堂学习体验是否存在差异？'); await js("document.querySelector('#pf').requestSubmit()"); await sleep(900);
  await js("window.scrollTo(0,0)"); await hl('.rs-tabs', '.rs-check'); await snap('23-research-project');
  await js("document.querySelector('[data-tab=participants]').click()"); await waitFor("document.querySelector('.io-bar[data-io=participants] .io-imp')");
  await click('.io-bar[data-io=participants] .io-imp'); await waitFor("document.querySelector('#io-file')");
  await setFiles('#io-file', [demo('研究名册-演示用虚构数据.csv')]); await waitFor("document.querySelector('.io-map')", 8000); await sleep(400);
  await hl('.io-map'); await snap('24-smart-import');
  await lastBtn(); await waitFor("document.querySelectorAll('[data-consent]').length === 12", 8000);
  const inst = await api('POST', '/api/research/instruments', { project_id: pid, kind: 'scale', name: '课堂学习体验量表（演示）', code: 'LE', scale: [1, 5], source_status: 'self_developed' }); if (!inst.instrument) throw new Error(JSON.stringify(inst) + ' pid=' + pid);
  await go(`/research?p=${pid}&tab=instruments&i=${inst.instrument.instrument_id}`); await waitFor("document.querySelector('.io-bar[data-io=scale_items] .io-imp')", 8000);
  for (const [bar, file] of [['scale_items', '学习体验量表题项-演示用.csv'], ['responses', '学习体验作答-演示用虚构数据.csv']]) {
    await click(`.io-bar[data-io=${bar}] .io-imp`); await waitFor("document.querySelector('#io-file')"); await setFiles('#io-file', [demo(file)]); await waitFor("document.querySelector('.io-map')", 8000); await sleep(300);
    await js("const s=document.querySelector('#io-skip'); if(s) s.checked=true;"); await lastBtn(); await sleep(1500);
  }
  await js("document.querySelector('#in-an').click()"); await waitFor("document.querySelector('#in-res table')", 8000); await sleep(300);
  await hl('#in-res'); await snap('25-alpha');
  await js("document.querySelector('[data-tab=export]').click()"); await waitFor("document.querySelector('#x-go')"); await sleep(300);
  await hl('#x-go', '.rs-xlist'); await snap('26-export');
  // 账号：头像与退出方式
  await go('/account'); await waitFor("document.querySelector('#ava-panel')", 8000); await sleep(400); await hl('#ava-panel', '.hdr-ava'); await snap('27-avatar');
  await js("document.querySelector('#user-btn').click()"); await sleep(200); await js("document.querySelector('#logout').click()"); await waitFor("document.querySelector('.modal .logout-opts')"); await sleep(300);
  await hl('.modal'); await snap('28-logout'); await js("document.querySelector('.modal .actions button').click()"); await sleep(300);
  // 思思的训练
  await go('/agents?tab=assistant'); await waitFor("document.querySelector('#sisi-train')", 10000); await click('#sisi-train'); await waitFor("document.querySelector('.sisi-train table + h4, .sisi-train .trv-pipe')", 15000); await sleep(600);
  await js("window.scrollTo(0,0)"); await hl('.sisi-train .trv-pipe'); await snap('29-sisi-train');
  check(true, '截图完成');
} catch (e) { note(`FAIL ${e.message}`); console.log(e.stack); process.exitCode = 1; }
finally {
  try { if (pid) { await api('DELETE', `/api/research/projects/${pid}`); note('已删除【演示】科研项目'); } } catch { /* ignore */ }
  try { chrome.kill(); } catch { /* gone */ }
}
