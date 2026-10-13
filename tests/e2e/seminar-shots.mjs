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

// 研课场工作台走查：布局、真实数据、教师智能体状态、@教师插话、暂停/继续、深浅主题与多分辨率。
const LECTURE = readFileSync(new URL('../fixtures/机械质量检测讲义.txt', import.meta.url), 'utf8');
const quick = arg('quick', '0') === '1';
try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900);
  await go('/login');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("localStorage.setItem('yz-tour-seminar','1'); localStorage.setItem('yz-tour-home','1'); localStorage.setItem('yz-theme','light'); localStorage.removeItem('yz-fs'); localStorage.setItem('yz-exec-mode','demo');");
  // 清理上一次中断走查遗留的进行中任务，保证从干净状态开始
  await js("const H={'content-type':'application/json','x-yz-csrf':'1'}; for (const j of (await (await fetch('/api/jobs')).json()).jobs) if (['running','paused'].includes(j.status)) await fetch('/api/jobs/'+j.job_id+'/cancel',{method:'POST',headers:H,body:'{}'});");
  await js("localStorage.removeItem('yz-seats')");
  await go('/seminar'); await waitFor("document.querySelector('.sw-agent')", 10000); await sleep(900);
  const lay = await js(`const r=(s)=>document.querySelector(s).getBoundingClientRect(); const t=r('.sw-talk'), s=r('.sw-side'), tb=r('.sw-table'), d=r('.sw-dock');
    return { agents: document.querySelectorAll('.sw-agent').length, names:[...document.querySelectorAll('.sw-agent .sw-an b')].map(b=>b.textContent), head: document.querySelector('.sw-agent.head b')?.textContent,
      talkW: Math.round(t.width), sideW: Math.round(s.width), upperH: Math.round(t.height), tableH: Math.round(tb.height), overflow: document.documentElement.scrollWidth > innerWidth,
      avatars3d: document.querySelectorAll('.sw-agent .av3d, .sw-agent .av-img').length, frame: !!document.querySelector('.sw-room.room-frame .rf-plate'), headTitle: document.querySelector('.sw-agent.head small')?.textContent }`);
  check(lay.agents >= 6 && /陈立诚/.test(lay.head) && lay.headTitle === '教研组长' && !lay.overflow && lay.talkW > lay.sideW && lay.upperH >= 300 && lay.avatars3d === lay.agents && lay.frame, `研讨区 + 会议室外框、每位教师 3D 形象与固定姓名、组长主持 ${JSON.stringify(lay)}`);
  await shot('S01-seminar-1440-light');
  if (!quick) {
    // 新建任务（边执行边观看）
    await click('#new-run'); await waitFor("document.querySelector('#w-paste-btn')");
    await click('#w-paste-btn'); await type('#w-text', LECTURE); await click('#w-paste-add');
    await waitFor("document.querySelectorAll('.kp').length >= 5", 15000);
    await js(`const p=document.querySelector('#w-pace'); p.value='watch'; p.dispatchEvent(new Event('change')); const c=document.querySelector('#w-class'); if(c.checked) c.click();`);
    await sleep(600);
    await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='开始执行').click()");
    await waitFor("document.querySelectorAll('#feed .sw-msg').length >= 4", 40000);
    await waitFor("document.querySelector('.sw-agent.st-speaking') || document.querySelector('.sw-agent.st-thinking')", 15000);
    const live = await js(`return { speaking: [...document.querySelectorAll('.sw-agent.st-speaking .sw-an b')].map(b=>b.textContent), thinking: [...document.querySelectorAll('.sw-agent.st-thinking .sw-an b')].map(b=>b.textContent),
      core: document.querySelector('#sw-core').innerText.split(String.fromCharCode(10)).join(' | '), cnt: document.querySelector('.sw-cnt')?.innerText, running: document.querySelectorAll('.sw-steps > li.running').length,
      rel: document.querySelectorAll('#feed .sw-rel').length, ideoTags: document.querySelectorAll('#feed .tg.ideo').length, evid: document.querySelectorAll('#feed .tg.ok, #feed .tg.evid').length }`);
    check(live.speaking.length + live.thinking.length >= 1 && /正在研讨/.test(live.core) && /\d+\/\d+/.test(live.cnt || '') && live.running === 1, `研讨进行中：状态来自真实编排 ${JSON.stringify(live)}`);
    const room = await js(`return { agents: document.querySelectorAll('.sw-agent').length, stages: [...document.querySelectorAll('#sw-stages .stg li b')].map(b=>b.textContent), eta: document.querySelector('#stg-eta')?.textContent || '', plate: document.querySelector('#rf-stage')?.textContent }`);
    check(room.agents === 8 && room.stages.join('>') === '任务分配>讨论交流>写作初稿>对抗质询>打磨修改>整合汇总>集体评审>形成终稿' && /已用/.test(room.eta), `会议室 8 位教师；研课八步顺序进程与预计完成时间 ${JSON.stringify(room)}`);
    let pkt = false; for (let i = 0; i < 40 && !pkt; i++) { pkt = await js("return !!document.querySelector('#scene .pkt')"); if (!pkt) await sleep(150); }
    check(pkt, '新发言时有信息包从发言教师飞向回应对象');
    await js("document.querySelector('.sw-room').scrollIntoView({block:'center'})"); await sleep(300);
    await shot('S02-seminar-running');
    // @ 证据审查教师 提问
    await click('#sw-at'); await waitFor("document.querySelector('#sw-at-pop [data-m]')");
    await js("[...document.querySelectorAll('#sw-at-pop [data-m]')].find(b=>/证据审查/.test(b.textContent)).click()");
    await type('#sw-text', '这个知识点的定义出处能核对一下吗？');
    await js("document.querySelector('#sw-form').requestSubmit()");
    await waitFor("[...document.querySelectorAll('#feed .sw-msg.human')].length >= 1", 8000);
    await waitFor("[...document.querySelectorAll('#feed .sw-msg')].some(m=>/回应 你/.test(m.innerText))", 30000);
    const reply = await js("const m=[...document.querySelectorAll('#feed .sw-msg')].find(m=>/回应 你/.test(m.innerText)); return m.querySelector('.sw-mh b').textContent + '：' + m.querySelector('.sw-mt').textContent.slice(0,60)");
    check(/证据审查/.test(reply), `@证据审查教师后由其回应：${reply}`);
    await shot('S03-seminar-at-reply');
    // 筛选
    await js("document.querySelector('#sw-filter [data-f=ideo]').click()"); await sleep(300);
    const fi = await js("return [...document.querySelectorAll('#feed .sw-msg')].every(m=>m.querySelector('.tg.ideo'))");
    check(fi, '“思政建议”筛选只显示课程思政相关发言');
    await js("document.querySelector('#sw-filter [data-f=all]').click()");
    // 暂停/继续
    await click('#pl-pause'); await sleep(2500);
    const n1 = await js("return document.querySelectorAll('#feed .sw-msg').length"); await sleep(3000);
    const n2 = await js("return document.querySelectorAll('#feed .sw-msg').length");
    check(n1 === n2 && /继续/.test(await js("return document.querySelector('#pl-play').textContent")), `暂停后不再推进（${n1}→${n2}）`);
    // 播放器：回退进入回看，再回到实时
    await click('#pl-back'); await sleep(700);
    const rv = await js("return { state: document.querySelector('#pl-state').textContent, n: document.querySelectorAll('#feed .sw-msg').length }");
    check(/回看/.test(rv.state) && rv.n <= n2, `回退：回看较早的研讨（显示 ${rv.n} 条） ${rv.state}`);
    await click('#pl-play'); await sleep(600);
    check(!/回看/.test(await js("return document.querySelector('#pl-state').textContent")), '回到实时');
    check(!(await js("return !!document.querySelector('#single')")) && (await js("return [...document.querySelectorAll('.pl-btn')].map(b=>b.textContent.trim()).join('|')")) === '回退|继续任务|暂停|快进|结束任务', '播放器按钮：回退 · 开始/继续 · 暂停 · 快进 · 结束（无单步）');
    await click('#pl-play'); await sleep(1500);
    // 研讨成果页
    await js("document.querySelector('#sw-tabs [data-tab=outcome]').click()"); await sleep(400);
    await shot('S04-seminar-outcome');
    await js("document.querySelector('#sw-tabs [data-tab=progress]').click()");
    // 快速跑完：切到快速节奏由服务端完成（直接等待任务结束）
    await waitFor("/已完成|全部完成/.test(document.querySelector('.sw-side').innerText) && !/执行中/.test(document.querySelector('.sw-sum').innerText)", 240000);
    await shot('S05-seminar-done');
  }
  for (const [w, h] of [[1920, 1080], [1366, 768]]) { await viewport(w, h); await go('/seminar'); await sleep(1500); const f = await js("return { msgsH: Math.round(document.querySelector('#feed').getBoundingClientRect().height), tableH: Math.round(document.querySelector('.sw-table').getBoundingClientRect().height), overflow: document.documentElement.scrollWidth > innerWidth }"); check(f.msgsH >= 180 && f.tableH >= 300 && !f.overflow, `${w}×${h} 研讨区与会议室都清楚、无横向滚动 ${JSON.stringify(f)}`); await shot(`S06-seminar-${w}`); }
  await viewport(1440, 900); await js("localStorage.setItem('yz-theme','dark')"); await go('/seminar'); await sleep(1500); await shot('S07-seminar-dark');
  await js("localStorage.setItem('yz-theme','light')");
  await viewport(768, 1024, true); await go('/seminar'); await sleep(1500); check(!(await js('return document.documentElement.scrollWidth > innerWidth')), '平板宽度无横向滚动'); await shot('S08-seminar-768');
} catch (e) { note(`FAIL ${e.message}`); console.log(e.stack); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
