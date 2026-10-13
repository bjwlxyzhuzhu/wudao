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

// 演课场走查：40 人 · 8 组 × 5 人、组级概览、个体聚焦、教师点名（学生/小组）、发言队列、思政要点、反馈回研讨。
const until = async (cond, ms = 20000) => { try { await waitFor(cond, ms); return true; } catch { return false; } };
const NL = 'String.fromCharCode(10)';
try {
  await connect();
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await viewport(1440, 900);
  await go('/login');
  await type('input[name=login]', arg('teacher')); await type('input[name=password]', arg('password'));
  await js("document.querySelector('#lf').requestSubmit()"); await sleep(1200);
  await js("['home','seminar','classroom'].forEach(k=>localStorage.setItem('yz-tour-'+k,'1')); localStorage.setItem('yz-theme','light'); localStorage.removeItem('yz-fs'); localStorage.setItem('yz-exec-mode','demo'); localStorage.removeItem('yz-groups'); localStorage.setItem('yz-speed','5');");
  // 研讨 → 课堂：先把研讨当前产物送入课堂，保证是“新导入的教案”
  await go('/'); await sleep(800);
  // 保证研课场的当前产物是一份单课教案（之前的走查可能把课堂反馈送回了研讨）
  await js("const H={'content-type':'application/json','x-yz-csrf':'1'}; const a=(await (await fetch('/api/artifacts?module=seminar')).json()).artifacts.find(x=>x.type==='lesson_plan'); if(a) await fetch('/api/artifacts/'+a.artifact_id+'/current',{method:'POST',headers:H,body:'{}'});");
  await go('/'); await sleep(1000);
  if (await js("return !!document.querySelector('.arrow-btn[data-from=seminar]:not(:disabled)')")) {
    await js("document.querySelector('.arrow-btn[data-from=seminar]').click()"); await waitFor("document.querySelector('.modal')");
    await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='确认').click()"); await sleep(1500);
  }
  await go('/classroom'); await waitFor("document.querySelector('#pl-play')"); await sleep(800);
  const top = await js(`return { btn: document.querySelector('#pl-play').textContent, dis: document.querySelector('#pl-play').disabled, single: !!document.querySelector('#single'), btns: [...document.querySelectorAll('.pl-btn')].map(b=>b.textContent.trim()).join('|'), groups: document.querySelector('#cl-groups').selectedOptions[0].textContent, size: document.querySelector('.cl-gsel b').textContent, badges: document.querySelector('#st-badges').innerText.split(${NL}).join(' ') }`);
  check(!top.dis && /开始上课/.test(top.btn) && !top.single && top.btns === '回退|开始上课|暂停|快进|下课' && top.groups === '8组 × 5人' && top.size === '40人', `默认 40 人 · 8 组 × 5 人，可直接开课 ${JSON.stringify(top)}`);
  await click('#pl-play');
  await waitFor("document.querySelectorAll('.cl-group').length === 8", 15000);
  await until("document.querySelectorAll('#cl-live .cl-ev, #cl-live .cl-now').length >= 2 && [...document.querySelectorAll('.cl-m b')][2]?.textContent !== '0'", 40000);
  const lay = await js(`const g=document.querySelector('.cl-group'); return { groups: document.querySelectorAll('.cl-group').length, bigAvatarsPerGroup: g.querySelectorAll('.cl-grep > .cl-ava').length, dotsPerGroup: g.querySelectorAll('.cl-dots .sd').length, metrics: document.querySelectorAll('.cl-m').length, bars: document.querySelectorAll('.cl-bar').length,
    fits: document.querySelector('.cl-stage').getBoundingClientRect().bottom <= innerHeight + 1, overflow: document.documentElement.scrollWidth > innerWidth, off: [...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,4).map(e=>e.tagName+'.'+String(e.className).slice(0,30)+' '+Math.round(e.getBoundingClientRect().right)), legend: document.querySelector('#cl-legend').innerText.split(${NL}).join(' ') }`);
  check(lay.groups === 8 && lay.bigAvatarsPerGroup === 1 && lay.dotsPerGroup === 4 && lay.metrics === 6 && lay.bars === 8 && !lay.overflow, `8 个小组各 1 位代表 + 4 个状态点；6 项指标与 8 组活跃度；无横向滚动 ${JSON.stringify(lay)}`);
  const look = await js(`return { names: [...document.querySelectorAll('.cl-grn b')].slice(0, 3).map(b=>b.textContent), av3d: document.querySelectorAll('#scene .av3d, #scene .av-img').length, stages: document.querySelectorAll('#cl-stages .stg li').length, eta: document.querySelector('#cl-stages .stg-eta')?.textContent || '', teacher: document.querySelector('#cl-teacher b')?.textContent }`);
  check(look.names.every((n) => !/^学生\d/.test(n)) && look.av3d >= 8 && look.stages >= 3 && /模拟课时剩/.test(look.eta) && /苏婉清/.test(look.teacher), `学生固定姓名与 3D 形象、教学环节进程与预计下课时间 ${JSON.stringify(look)}`);
  let pk = false; for (let i = 0; i < 60 && !pk; i++) { pk = await js("return !!document.querySelector('.cl-main .pkt')"); if (!pk) await sleep(150); }
  check(pk, '学生发言时有信息包从小组飞向教师（或教师回应飞向小组）');
  await shot('C01-classroom-40-8x5');
  // 小组详情：5 名成员
  await js("document.querySelector('.cl-group[data-group=G2]').click()"); await waitFor("document.querySelector('.modal .cl-gd')");
  const gd = await js("return { rows: document.querySelectorAll('.modal .cl-gd tbody tr').length, title: document.querySelector('.modal h3').textContent }");
  check(gd.rows === 5, `点击第 2 组展开 5 名成员 ${JSON.stringify(gd)}`);
  await shot('C02-classroom-group-detail');
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent==='关闭').click()"); await sleep(300);
  // 暂停后点名：由被点名学生回应
  if (await js("return !document.querySelector('#pl-pause').disabled")) await click('#pl-pause');
  await sleep(1500);
  // 点名后：在事件记录中，紧跟教师点名的下一条发言必须来自被点名的学生 / 该组成员
  const afterCall = (prefix) => js(`const runs=(await (await fetch('/api/runs?module=classroom')).json()).runs; const v=await (await fetch('/api/runs/'+runs[0].run_id)).json();
    const names=Object.fromEntries(v.profiles.map(p=>[p.agent_id,p])); const ev=v.events; const i=ev.map(e=>e.actor_type==='human'&&new RegExp('${prefix}').test(e.target_actor||'')).lastIndexOf(true);
    const nx=ev.slice(i+1).find(e=>e.actor_type!=='system'); return { call: ev[i]?.text||'', target: ev[i]?.target_actor||'', next: nx ? (names[nx.actor_id]?.name||nx.actor_id)+'@'+(names[nx.actor_id]?.group_id||'') : '', nextId: nx?.actor_id||'', nextGroup: names[nx?.actor_id]?.group_id||'' }`);
  await js("document.querySelector('#t-random').click()"); await sleep(800);
  await click('#pl-play'); await sleep(3000); await click('#pl-pause'); await sleep(600);
  const c1 = await afterCall('^S');
  check(c1.target && c1.nextId === c1.target, `随机点名：${c1.call.slice(0, 12)}… → 下一位发言 ${c1.next}`);
  await js("const s=document.querySelector('#t-group'); s.value='G3'; s.dispatchEvent(new Event('change'))"); await sleep(800);
  await click('#pl-play'); await sleep(3000); await click('#pl-pause'); await sleep(600);
  const c2 = await afterCall('^G3$');
  check(c2.nextGroup === 'G3', `指定第 3 组发言 → 由该组 ${c2.next} 代表回应`);
  await shot('C03-classroom-teacher-call');
  // 发言队列 / 重点学生 / 思政要点
  // 播放器：回退进入回看、回到实时、快进
  await click('#pl-back'); await sleep(700);
  const rv = await js("return { state: document.querySelector('#pl-state').textContent, play: document.querySelector('#pl-play').textContent }");
  check(/回看/.test(rv.state) && /回到实时/.test(rv.play), `回退：进入回看（只读回放） ${JSON.stringify(rv)}`);
  await click('#pl-play'); await sleep(800);
  check(!/回看/.test(await js("return document.querySelector('#pl-state').textContent")), '点“回到实时”退出回看并继续上课');
  const b0 = await js("return parseFloat(document.querySelector('#pl-buf').style.width)");
  await click('#pl-fwd'); await sleep(500);
  await waitFor("!/快进中/.test(document.querySelector('#pl-state').textContent)", 90000);
  const b1 = await js("return parseFloat(document.querySelector('#pl-buf').style.width)");
  check(b1 > b0, `快进：已上课时从 ${b0.toFixed(1)}% 推进到 ${b1.toFixed(1)}%`);
  await shot('C03b-classroom-player');
  if (await js("return !document.querySelector('#pl-pause').disabled")) await click('#pl-pause'); await sleep(800);
  await js("document.querySelector('.cl-rail [data-view=queue]').click()"); await sleep(400);
  check(await js("return !!document.querySelector('.cl-queue')"), '发言队列视图可用');
  await shot('C04-classroom-queue');
  await js("document.querySelector('.cl-rail [data-view=focus]').click()"); await sleep(300);
  const focus = await js("return [...document.querySelectorAll('.cl-focus-grid .cl-focus small')].map(s=>s.textContent)");
  check(focus.length >= 1 && focus.length <= 6, `重点学生（≤6）：${focus.join('；')}`);
  await js("document.querySelector('.cl-rail [data-view=groups]').click()"); await sleep(300); await shot('C05-classroom-groups-expanded');
  await js("document.querySelector('.cl-rail [data-view=ideo]').click()"); await sleep(300);
  const ideo = await js("return { blocks: document.querySelectorAll('.cl-ideo').length, cites: document.querySelectorAll('.cl-ideo cite').length, empty: !!document.querySelector('#scene .cl-empty') }");
  check(ideo.empty || ideo.cites >= 1, `思政要点可追溯到课堂发言 ${JSON.stringify(ideo)}`);
  await shot('C06-classroom-ideology');
  await js("document.querySelector('.cl-rail [data-view=class]').click()");
  // 其他分辨率与深色
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    await viewport(w, h); await go('/classroom'); await sleep(1500);
    const f = await js("return { groupsH: Math.round(document.querySelector('.cl-body').getBoundingClientRect().height), frame: !!document.querySelector('.cl-room .rf-plate'), overflow: document.documentElement.scrollWidth > innerWidth }");
    check(f.groupsH >= 200 && f.frame && !f.overflow, `${w}×${h} 教室外框、小组区可读、无横向滚动 ${JSON.stringify(f)}`); await shot(`C07-classroom-${w}`);
  }
  await viewport(1440, 900); await js("localStorage.setItem('yz-theme','dark')"); await go('/classroom'); await sleep(1500); await shot('C08-classroom-dark'); await js("localStorage.setItem('yz-theme','light')");
  // 结束 → 生成课堂反馈 → 返回研课场继续改进
  await go('/classroom'); await sleep(1200);
  await js("document.querySelector('#finish').click()"); await sleep(400); await js("const b=[...document.querySelectorAll('.modal .actions button')].at(-1); if(b) b.click();"); await sleep(1000);
  await click('#fb'); await waitFor("document.querySelector('.modal')");
  const hasBack = await js("return [...document.querySelectorAll('.modal .actions button')].some(b=>b.textContent.includes('返回研课场继续改进'))");
  await js("[...document.querySelectorAll('.modal .actions button')].find(b=>b.textContent.includes('返回研课场继续改进')).click()");
  await waitFor("location.pathname === '/seminar'", 10000); await sleep(1500);
  const rev = await js("return { run: new URL(location.href).searchParams.get('run'), revising: /依据反馈/.test(document.querySelector('#st-badges')?.textContent || '') || /修订/.test(document.querySelector('#feed')?.textContent || '') }");
  check(hasBack && rev.run && rev.revising, `课堂反馈 → 返回研课场继续改进：一步带回反馈并开始依据反馈修订原产物 ${JSON.stringify(rev)}`);
} catch (e) { note(`FAIL ${e.message}`); console.log(e.stack); process.exitCode = 1; }
finally { try { chrome.kill(); } catch { /* gone */ } }
