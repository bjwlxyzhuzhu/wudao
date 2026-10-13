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

try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900);

  // --- login ---
  await go('/login');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await shot('01-login-1440');
  await click('#lf button[type=submit]'); await sleep(1200);
  check((await js('return location.pathname')) === '/', '教师登录后进入首页');

  // --- home before any artifact ---
  await go('/'); await sleep(600);
  check(await js("return !!document.querySelector('.tour-card')"), '首次进入首页显示浮动操作指引');
  await shot('02a-home-tour-1440');
  await js("localStorage.setItem('yz-tour-home','1'); localStorage.setItem('yz-tour-seminar','1'); localStorage.setItem('yz-tour-classroom','1');");
  await go('/'); await sleep(1500);
  await shot('02-home-empty-1440');
  const h0 = await js(`return {arrows:document.querySelectorAll('.arrows .arrow-btn').length, disabled:[...document.querySelectorAll('.arrow-btn')].every(b=>b.disabled), selects:document.querySelectorAll('.arrows select, .home select').length, visibleText:[...document.querySelectorAll('.arrows *')].filter(e=>e.children.length===0 && e.textContent.trim() && getComputedStyle(e).opacity!=='0' && e.tagName!=='path').map(e=>e.textContent.trim())}`);
  check(h0.arrows === 2 && h0.selects === 0 && h0.visibleText.length === 0, `首页中间仅两个方向箭头（无下拉/说明文字；无当前产物时禁用=${h0.disabled}）${JSON.stringify(h0)}`);

  // 清理上一次中断走查遗留的进行中任务，保证从干净状态开始
  await js("const H={'content-type':'application/json','x-yz-csrf':'1'}; for (const j of (await (await fetch('/api/jobs')).json()).jobs) if (['running','paused'].includes(j.status)) await fetch('/api/jobs/'+j.job_id+'/cancel',{method:'POST',headers:H,body:'{}'});");
  // --- seminar: create a demo run through the UI ---
  await go('/seminar'); await waitFor("document.querySelector('.sw-agent.head')");
  const table = await js(`const seats=[...document.querySelectorAll('.sw-agent[data-agent]')]; const head=document.querySelector('.sw-agent.head'); const sc=document.querySelector('#scene').getBoundingClientRect(); const tk=document.querySelector('.sw-talk').getBoundingClientRect(); return {n:seats.length, head:head.dataset.agent, headText:head.innerText, talkVisible: tk.height>250, sceneVisible: sc.height >= 300, around: new Set(seats.map(s=>Math.round(parseFloat(s.style.top)/10))).size }`);
  check(table.n >= 6 && table.head === 'M0' && /主持/.test(table.headText) && table.around >= 3, `数字教研室圆桌（默认 8 位教师），组长主持 ${JSON.stringify(table)}`);
  check(table.talkVisible && table.sceneVisible, '研讨区与会议室圆桌都有足够空间');
  await shot('03-seminar-idle-1440');
  // --- new task: import course content (paste lecture notes) → choose outputs → execute on the server ---
  const LECTURE = readFileSync(new URL('../fixtures/机械质量检测讲义.txt', import.meta.url), 'utf8');
  await click('#new-run'); await waitFor("document.querySelector('#w-paste-btn')");
  await click('#w-paste-btn'); await type('#w-text', LECTURE); await click('#w-paste-add');
  await waitFor("document.querySelectorAll('.kp').length >= 5", 15000);
  await js(`document.querySelector('[data-out="exam"]').click(); const m=document.querySelector('#w-min'); m.value='15'; m.dispatchEvent(new Event('change')); const p=document.querySelector('#w-pace'); p.value='watch'; p.dispatchEvent(new Event('change'));`);
  await sleep(1200);
  await shot('04-seminar-task-wizard-1440');
  const wiz = await js(`return { kps: document.querySelectorAll('.kp').length, on: document.querySelectorAll('.kp.on').length, name: document.querySelector('[data-cg="name"]').value, hours: document.querySelector('[data-cg="hours"]').value, est: document.querySelector('#w-est').innerText }`);
  check(wiz.kps >= 5 && wiz.on === 4 && wiz.name === '机械质量检测' && wiz.hours === '32' && /将依次执行[\s\S]*知识点研讨[\s\S]*模拟上课（15 分钟）[\s\S]*依据课堂反馈修订/.test(wiz.est) && /不消耗积分/.test(wiz.est), `导入后自动识别课程信息与知识点，并列出将执行的任务链 ${JSON.stringify({ ...wiz, est: wiz.est.slice(0, 60) })}`);
  await js("document.querySelector('.modal .mbody').parentElement.scrollTop = 99999"); await sleep(300); await shot('04b-seminar-task-wizard-steps-1440');
  await js(`[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent.includes('开始执行')).click();`);
  await waitFor("document.querySelectorAll('.sw-steps > li').length === 8 && /执行中/.test(document.querySelector('.sw-sum')?.textContent || '')", 20000);
  await waitFor("[...document.querySelectorAll('#feed .sw-msg')].some(i=>i.querySelector('.sw-kind')?.textContent==='讲解')", 30000);
  await waitFor("[...document.querySelectorAll('#feed .sw-msg')].some(i=>i.textContent.includes('思政融入'))", 30000);
  const live = await js(`return {active:document.querySelectorAll('.sw-agent.st-speaking, .sw-agent.st-thinking').length, explain:[...document.querySelectorAll('#feed .sw-msg')].find(i=>i.querySelector('.sw-kind')?.textContent==='讲解')?.textContent.split(String.fromCharCode(10)).join(' ').replace(/ +/g,' ').trim() || '', steps: document.querySelectorAll('.sw-steps > li').length, pauseOn:!document.querySelector('#pl-pause').disabled, state:document.querySelector('#pl-state').textContent}`);
  // 发言者高亮只在两条发言之间短暂存在：若快照恰在间隙，再在 6 秒内采样（出现过即可）
  if (!live.active) { for (let k = 0; k < 40 && !live.active; k++) { await sleep(150); live.active = await js("return document.querySelectorAll('.sw-agent.st-speaking, .sw-agent.st-thinking').length"); } }
  check(live.active >= 1 && /出处/.test(live.explain) && live.steps === 8 && live.pauseOn && /任务自动执行/.test(live.state), `围绕具体知识点研讨（讲解含出处），任务进度 ${live.steps} 步 ${JSON.stringify({ ...live, explain: live.explain.slice(0, 60) })}`);
  await shot('05-seminar-knowledge-discussion-1440');
  // ask a question about the course knowledge itself
  const pos = await js(`const b=document.querySelector('.participate').getBoundingClientRect(); const a=document.querySelector('#pl-pause').getBoundingClientRect(); return {bx:b.right, by:b.bottom, ax:a.right, ay:a.top, W:innerWidth, H:innerHeight}`);
  check(pos.bx > pos.W - 60 && pos.by > pos.H - 60 && pos.ay < 200, `顶部播放器条暂停键、右下参与按钮位置 ${JSON.stringify(pos)}`);
  await click('.participate'); await sleep(500);
  const focus = await js(`return { focused: document.activeElement?.id === 'sw-text', backdrop: !!document.querySelector('.modal-back') }`);
  check(focus.focused && !focus.backdrop, `参与研课：直接在研讨区输入，无遮罩 ${JSON.stringify(focus)}`);
  await type('#sw-text', '系统误差和随机误差有什么区别？');
  await shot('06-seminar-participate-1440');
  await js("document.querySelector('#sw-form').requestSubmit()");
  await waitFor("[...document.querySelectorAll('#feed .sw-msg')].some(i=>i.textContent.includes('可以对照两者的定义'))", 30000);
  const qa = await js("return [...document.querySelectorAll('#feed .sw-msg')].find(i=>i.textContent.includes('可以对照两者的定义')).textContent");
  check(/系统误差[\s\S]*随机误差/.test(qa) && /《[^》]+》/.test(qa), `提问课程知识：依据导入材料回答并注明出处（${qa.slice(0, 50)}…）`);
  await shot('06b-seminar-knowledge-answer-1440');
  // pause and resume the task
  await click('#pl-pause'); await waitFor("document.querySelector('.sw-sum') && document.querySelector('.sw-sum').textContent.includes('已暂停')", 10000);
  await sleep(1500); // 暂停前已提交的发言可能在下一次轮询才渲染
  const n1 = await js("return document.querySelectorAll('#feed .sw-msg').length"); await sleep(2500);
  const n2 = await js("return document.querySelectorAll('#feed .sw-msg').length");
  check(n1 === n2 && (await js("return document.querySelector('#pl-play').textContent")).includes('继续任务'), `暂停后任务不再推进（${n1}→${n2}），可继续`);
  await shot('07a-seminar-task-paused-1440');
  await click('#pl-play'); await sleep(800);
  check(await js("return document.querySelector('.sw-sum').textContent.includes('执行中')"), '继续后任务恢复执行');
  await waitFor("document.querySelector('.sw-side') && document.querySelector('.sw-side').textContent.includes('全部完成')", 420000);
  await sleep(1200);
  const res = await js(`return { done: document.querySelectorAll('.sw-steps > li.done').length, total: document.querySelectorAll('.sw-steps > li').length, links: [...document.querySelectorAll('.sw-arts a')].map(a=>a.textContent) }`);
  check(res.done === res.total && res.links.length >= 7, `任务链全部完成，每步留下成果（${res.links.length} 个）：${res.links.join('；').slice(0, 120)}`);
  await shot('07-seminar-task-completed-1440');

  // --- home with current artifact: right arrow confirm ---
  await go('/');
  await hover('.arrow-btn[data-from=seminar]');
  await shot('08-home-arrow-hover-1440');
  const nx0 = await js("return fetch('/api/transfers').then(r=>r.json()).then(j=>j.transfers.length)");
  await realClick('.arrow-btn[data-from=seminar]'); await waitFor("document.querySelector('.modal')");
  const m = await js("return {text:document.querySelector('.modal').innerText, selects:document.querySelectorAll('.modal select, .modal input').length}");
  check(/研课场 → 演课场/.test(m.text) && m.selects === 0, `确认弹窗只含方向/源产物/摘要，无选择与表单 ${JSON.stringify(m.text.slice(0, 80))}`);
  await shot('09-home-transfer-confirm-1440');
  await js(`[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='取消').click();`); await sleep(400);
  const cancelled = await js("return fetch('/api/transfers').then(r=>r.json()).then(j=>j.transfers.length)");
  check(cancelled === nx0, '取消流转不写入');
  await realClick('.arrow-btn[data-from=seminar]'); await waitFor("document.querySelector('.modal')");
  await js(`[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='确认').click();`); await sleep(1200);
  check((await js("return fetch('/api/transfers').then(r=>r.json()).then(j=>j.transfers.length)")) === nx0 + 1, '确认后仅创建一次流转');
  await shot('10-home-after-transfer-1440');
  await viewport(1920, 1080); await go('/'); await shot('11-home-1920');
  await viewport(390, 844, true); await go('/'); await shot('12-home-390');
  const mob = await js(`const a=document.querySelectorAll('.arrow-btn'); return {rot:getComputedStyle(a[0].querySelector('svg')).transform, label:a[0].getAttribute('aria-label'), overflow: document.documentElement.scrollWidth > innerWidth}`);
  check(mob.rot !== 'none' && /研课场.*演课场/.test(mob.label) && !mob.overflow, `手机端箭头改为上下方向且标签写清源/目标、无横向滚动 ${JSON.stringify(mob)}`);
  await go('/seminar'); await sleep(800); await shot('13-seminar-390');
  await viewport(1440, 900);

  // --- classroom: 40 students, autonomous random participation ---
  await go('/classroom'); await sleep(800);
  await click('#new-run'); await waitFor("document.querySelector('#c-size')");
  await js(`document.querySelector('#c-size').value='40'; document.querySelector('#c-class').value='50'; document.querySelector('#c-speed').value='20'; document.querySelector('#c-org').value='group'; document.querySelector('#c-free').value='high'; document.querySelector('#c-seed').value='shot-seed-1'; document.querySelector('#c-turns').value='60'; document.querySelector('#c-size').dispatchEvent(new Event('change'));`);
  await sleep(700); await shot('14-classroom-setup-1440');
  await js(`[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent.includes('创建并开始')).click();`);
  await waitFor("Number(document.querySelectorAll('.cl-m b')[2]?.textContent) >= 6", 60000);
  for (let i = 0; i < 30; i++) { if (await js("return !!document.querySelector('.cl-group.gs-speaking, .cl-group.gs-report') && document.querySelectorAll('.cl-dots .sd-hand, .cl-grep .st-hand').length>0")) break; await sleep(500); }
  await shot('15-classroom-live-1440');
  await click('.participate'); await sleep(300);
  await js(`document.querySelector('#cp-role').value='student';`); await type('#cp-text', '老师，数据不完整时是否可以先放行再复检？');
  await click('#cp-send'); await sleep(2400);
  await shot('16-classroom-human-1440');
  await click('#cp-close'); await sleep(200);
  const cls = await js(`return fetch(location.pathname.replace('/classroom','/api/runs?module=classroom')).then(r=>r.json()).then(async j=>{const v=await (await fetch('/api/runs/'+j.runs[0].run_id)).json(); const st=v.events.filter(e=>/^S\\d/.test(e.actor_id)).map(e=>e.actor_id); const hum=v.events.findIndex(e=>e.actor_type==='human'); return {n:v.events.length, students:st.length, distinct:new Set(st).size, silences:v.events.filter(e=>e.kind==='silence').length, peer:v.events.filter(e=>/^S\\d/.test(e.target_actor||'')).length, afterHuman: v.events[hum+1]?.actor_id, profiles:v.profiles.length}})`);
  check(cls.profiles === 41 && cls.distinct >= 3 && cls.peer >= 1 && cls.afterHuman === 'T', `课堂自主参与（短窗口观察）：学生发言 ${cls.students} 次、${cls.distinct} 人；沉默 ${cls.silences}；同伴互动 ${cls.peer}；真人学生发言后由教师回应=${cls.afterHuman}（重复发言/非名单顺序另由 400 步调度测试 V15 验证）`);
  // finish the class and generate classroom feedback (timing: planned vs simulated)
  await js("document.querySelector('#finish').click()"); await sleep(400); await js("const b=[...document.querySelectorAll('.modal .actions button')].at(-1); if(b) b.click();"); await sleep(1000); await click('#fb'); await waitFor("document.querySelector('.modal')");
  await js(`[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='查看反馈').click();`); await sleep(1500);
  const fbTiming = await js("return !!document.querySelector('#sec-timing') && document.querySelectorAll('#sec-timing tbody tr').length");
  check(fbTiming > 0, `课堂反馈含各环节计划与模拟用时（${fbTiming} 个环节）`);
  await js("document.querySelector('#sec-timing')?.scrollIntoView()"); await sleep(300); await shot('16b-classroom-feedback-1440');
  await viewport(1920, 1080); await go('/classroom'); await sleep(1200); await shot('17-classroom-1920');
  await viewport(390, 844, true); await go('/classroom'); await sleep(1200); await shot('18-classroom-390');
  const mo = await js('return document.documentElement.scrollWidth > innerWidth');
  check(!mo, '手机端课堂无横向滚动');
  await viewport(1440, 900);

  // --- library/editor & export page ---
  await go('/library'); await sleep(600); await shot('19-library-1440');
  const first = await js("return ([...document.querySelectorAll('.lib-card .lib-open[data-link]')].find((c) => c.textContent.includes('单课教案') && !c.textContent.includes('课堂反馈')) || document.querySelector('.lib-card .lib-open[data-link]'))?.dataset.link");
  if (first) { await go(first); await sleep(900); await shot('20-editor-1440'); }
  const ideoPanel = await js("return [...document.querySelectorAll('.panel h2')].some(h=>h.textContent.includes('思政融入自检'))");
  check(ideoPanel, '产物编辑器显示课程思政融入自检');
  await go('/export'); await sleep(600); await click('#pv'); await sleep(900); await shot('21-export-preview-1440');
  await go('/rating'); await sleep(900); await shot('22-rating-1440');

  // --- admin ---
  if (arg('admin')) {
    await go('/admin/login'); await type('#lf input[name=login]', arg('admin')); await type('#lf input[name=password]', arg('admin-password'));
    await click('#lf button'); await sleep(1200);
    await shot('23-admin-overview-1440');
    for (const [p, n] of [['/admin/teachers', '24-admin-teachers'], ['/admin/credits', '25-admin-credits'], ['/admin/models', '26-admin-models'], ['/admin/templates', '27-admin-templates'], ['/admin/runs', '28-admin-runs']]) { await go(p); await sleep(900); await shot(`${n}-1440`); }
    const leak = await js("return fetch('/api/admin/models').then(r=>r.text())");
    check(!/sk-[A-Za-z0-9]{8,}/.test(leak), '后台模型列表不含完整密钥');
  }
} catch (e) {
  note(`ERROR ${e.message}`); process.exitCode = 1;
} finally {
  writeFileSync(join(OUT, 'browser-run-log.txt'), `${new Date().toISOString()} ${BASE}\n${log.join('\n')}\n`);
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
}
