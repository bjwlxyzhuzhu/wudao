// Teacher front-end: router, header, login, library/editor, rating, export, account. Home page lives in home.js.
import { get, post, put, key, download, downloadPost, ApiError } from './api.js';
import { esc, $, $$, toast, fail, modal, confirmBox, formData, fmtTime, TYPE_NAME, MODULE_NAME, STATUS_NAME, SOURCE_NAME, tour, resetTours } from './ui.js';
import { renderSeminar } from './seminar.js';
import { renderClassroom } from './classroom.js';
import { pageHome as renderHome } from './home.js';
import { setAgentRegistry, userAvatar, avatarPicker } from './avatar3d.js';
import { mountAssistant } from './assistant.js';
import { renderAgents } from './agents-page.js';
import { renderResearch } from './research-page.js';
import { ioButtons, bindIo } from './smart-io.js';

const root = document.getElementById('app');
export const state = { me: null, balance: null, catalog: null };
let dispose = null;

// ---------- session ----------
export async function refreshMe() {
  try {
    const r = await get('/api/me');
    state.me = r.user; state.balance = r.balance;
    $('#credit-available').textContent = r.balance.available;
    $('#credit-reserved').textContent = r.balance.reserved ? ` · 冻结 ${r.balance.reserved}` : '';
    $('#user-btn').innerHTML = `<span class="hdr-ava">${userAvatar(r.user.avatar_key, r.user.user_id)}</span>${esc(r.user.display_name)} ▾`;
    return r;
  } catch { return null; }
}
export async function catalog() { if (!state.catalog) { state.catalog = await get('/api/catalog'); setAgentRegistry({ roles: state.catalog.agent_roles, studentAvatars: state.catalog.student_avatars }); } return state.catalog; }
export const invalidateCatalog = () => { state.catalog = null; };

window.addEventListener('yz:unauth', () => { if (location.pathname !== '/login') navigate('/login'); });
window.addEventListener('yz:mustchange', () => { if (location.pathname !== '/account') { toast('首次登录请先修改密码', true); navigate('/account'); } });

// ---------- router ----------
const routes = { '/login': pageLogin, '/': () => renderHome(root, { navigate, getCatalog: catalog }), '/seminar': (q) => stage(renderSeminar, q), '/classroom': (q) => stage(renderClassroom, q), '/library': pageLibrary, '/rating': pageRating, '/export': pageExport, '/account': pageAccount, '/agents': (q) => stage((r, ctx) => renderAgents(r, { ...ctx, invalidate: invalidateCatalog }), q), '/research': (q) => renderResearch(root, { navigate, query: q }) };
export function navigate(path, replace = false) { if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path); route(); }
async function route() {
  if (dispose) { try { dispose(); } catch { /* ignore */ } dispose = null; }
  const url = new URL(location.href);
  const fn = routes[url.pathname] || routes['/'];
  const navKey = { '/rating': '/research', '/export': '/research' }[url.pathname] || url.pathname;
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.link === navKey));
  helpBtn.hidden = url.pathname === '/login';
  if (url.pathname !== '/login') {
    if (!state.me) { const me = await refreshMe(); if (!me) return navigate('/login', true); }
    $('#header').hidden = false;
    if (state.me.must_change_password && url.pathname !== '/account') return navigate('/account', true);
  } else $('#header').hidden = true;
  root.innerHTML = '';
  try { const d = await fn(Object.fromEntries(url.searchParams)); if (typeof d === 'function') dispose = d; } catch (e) { if (!(e instanceof ApiError && e.status === 401)) { root.innerHTML = `<div class="notice red">${esc(e.message)}</div>`; console.error(e); } }
}
window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-link]');
  if (a && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('#user-menu').classList.remove('open'); navigate(a.dataset.link); }
  if (!e.target.closest('#user-menu')) $('#user-menu').classList.remove('open');
});
$('#user-btn').addEventListener('click', () => { const m = $('#user-menu'); m.classList.toggle('open'); $('#user-btn').setAttribute('aria-expanded', m.classList.contains('open')); });
$('#logout').addEventListener('click', async () => {
  $('#user-menu').classList.remove('open');
  const how = await modal({ title: '退出登录', body: `<div class="logout-opts"><p>请选择退出方式：</p>
      <p class="small"><b>退出登录</b>：只结束登录，保留本机的界面偏好（主题、字号、倍速、简洁视图、指引记录等）。</p>
      <p class="small"><b>退出并清空缓存</b>：同时清除本浏览器中平台保存的偏好、指引记录、临时草稿与思思的对话记录，适合公用电脑。</p>
      <div class="notice small">两种方式都不会删除服务器上的教案、课件、研究数据等任何成果。</div></div>`,
    buttons: [{ label: '取消', value: null }, { label: '退出并清空缓存', value: 'clear', cls: 'danger' }, { label: '退出登录', value: 'logout', cls: 'primary' }] });
  if (!how) return;
  try { await post('/api/auth/logout'); } catch { /* 会话可能已过期 */ }
  state.me = null; state.catalog = null;
  if (how === 'clear') {
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    // 只清除本平台的缓存键（yz-*）与会话存储；旧版本地研究数据 yanzhi-study-v1 保留，避免误删未迁移的数据
    try { Object.keys(localStorage).filter((k) => k.startsWith('yz-')).forEach((k) => localStorage.removeItem(k)); } catch { /* storage unavailable */ }
    try { sessionStorage.clear(); } catch { /* storage unavailable */ }
    try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch { /* ignore */ }
    location.replace('/login?cleared=1'); return;
  }
  navigate('/login');
});
$('#credit-pill').addEventListener('click', () => showLedger());

async function stage(renderer, q) { await catalog(); return renderer(root, { state, refreshMe, navigate, query: q }); }

export async function showLedger() {
  const r = await get('/api/credits');
  const TYPES = { initial_grant: '初始赠送', admin_grant: '管理员分配', admin_deduct: '管理员扣减', reserve: '任务预占', settle: '成功结算', release: '释放', reversal: '冲正' };
  await modal({ title: '积分与流水', wide: true, body: `<div class="row" style="margin-bottom:10px"><span class="badge gold">总余额 ${r.balance.total}</span><span class="badge warn">冻结 ${r.balance.reserved}</span><span class="badge cyan">可用 ${r.balance.available}</span></div>
    <p class="small muted">积分是平台资源配额，不是人民币。每次成功完成的真实模型回复按费率计费；查看、编辑、流转、导出与演示不收费。</p>
    <div class="scroll-x" style="max-height:50vh"><table class="data"><thead><tr><th>时间</th><th>类型</th><th>总余额变动</th><th>冻结变动</th><th>之后 总/冻结</th><th>原因</th></tr></thead><tbody>
    ${r.ledger.map((l) => `<tr><td class="small">${fmtTime(l.created_at)}</td><td>${TYPES[l.type] || l.type}</td><td>${l.amount > 0 ? '+' : ''}${l.amount}</td><td>${l.reserved_delta > 0 ? '+' : ''}${l.reserved_delta}</td><td>${l.total_after} / ${l.reserved_after}</td><td class="small">${esc(l.reason || '')}</td></tr>`).join('')}</tbody></table></div>` });
}

// ---------- login ----------
async function pageLogin() {
  const cfg = await get('/api/public-config').catch(() => ({}));
  root.innerHTML = `<div class="login-wrap"><form class="panel login-card" id="lf" autocomplete="on">
    <div class="fs-switch" role="group" aria-label="字号"><button type="button" data-fs-set="m" title="标准字号">A</button><button type="button" data-fs-set="l" title="较大字号">A</button><button type="button" data-fs-set="xl" title="特大字号">A</button></div><div class="theme-switch" role="group" aria-label="显示模式"><button type="button" data-theme-set="auto" title="自动：跟随系统">◐</button><button type="button" data-theme-set="light" title="浅色">☀</button><button type="button" data-theme-set="dark" title="深色">☾</button></div><div class="login-logo"><img src="/img/logo-full.png" alt="研思智境 · Research · Reflection · Simulation · Improvement · Multi-Agent Teaching Research Intelligence"></div><h1 class="login-title">“研—演—评—改”多智能体数字教研实验工坊</h1><div class="small muted login-sub">教师登录</div>
    <div style="display:grid;gap:12px"><label>登录名<input name="login" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary" type="submit">登录</button>
    <div class="row small"><a href="/admin/login">管理员入口</a><span class="grow"></span>${cfg.self_register ? '<a href="#" id="reg">注册教师账号</a>' : '<span class="faint">账号由管理员开通</span>'}</div></div></form></div>`;
  if (new URLSearchParams(location.search).get('cleared')) toast('已退出并清空本机缓存');
  $('#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await post('/api/auth/login', formData(e.target)); state.me = null; await refreshMe(); navigate(state.me?.must_change_password ? '/account' : '/'); } catch (err) { fail(err); }
  });
  $('#reg')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await modal({ title: '注册教师账号', wide: true, body: `<div style="display:grid;gap:10px"><label>登录名<input id="rl" autocomplete="username"></label><label>显示名<input id="rn"></label><label>密码（≥8位，含字母和数字）<input id="rp" type="password" autocomplete="new-password"></label>
      <div><div class="small" style="margin-bottom:6px">选择头像（3D 水晶球，注册后也可以在“账号”页更换）</div>${avatarPicker('u01', 'reg-ava')}</div></div>`,
      buttons: [{ label: '取消', value: null }, { label: '注册', cls: 'primary', handler: async (m) => { await post('/api/auth/register', { login: $('#rl', m).value, display_name: $('#rn', m).value, password: $('#rp', m).value, avatar_key: m.querySelector('input[name="reg-ava"]:checked')?.value || 'u01' }); toast('注册成功，请登录'); } }] });
  });
}

// ---------- library & editor ----------
// 产物分层：专业 → 课程 → 课堂 → 练习评价 → 反馈反思 → 知识图谱
const LEVELS = [['program', '专业层', ['talent_plan']], ['course', '课程层', ['syllabus', 'course_design', 'semester_plan', 'teaching_schedule']], ['lesson', '课堂层', ['lesson_plan', 'courseware']],
  ['assess', '练习与评价', ['exercises', 'exam']], ['feedback', '反馈与反思', ['classroom_feedback', 'reflection_report']], ['map', '知识图谱', ['knowledge_map']], ['other', '其他', []]];
const levelOf = (type) => (LEVELS.find(([, , ts]) => ts.includes(type)) || LEVELS.at(-1))[0];
const ORIGIN = (o) => (o === 'model_generated_draft' ? ['ai', '大模型生成'] : o === 'demo_skeleton_draft' ? ['local', '本地生成'] : o === 'knowledge_seminar' ? ['local', '知识点研讨'] : o === 'compiled_from_events' ? ['local', '事件汇编'] : o === 'teacher_edit' || o === 'teacher_authored' ? ['human', o === 'teacher_edit' ? '教师修改' : '教师新建'] : String(o).startsWith('transfer_from_') ? ['transfer', '模块流转'] : o === 'legacy_v2_migration' ? ['other', '旧版迁移'] : ['other', o]);
const ORIGIN_GROUPS = { ai: '大模型生成', local: '本地生成 / 汇编', human: '教师新建或修改', transfer: '模块流转', other: '其他' };

async function pageLibrary(q) {
  if (q.id) return pageEditor(q.id);
  const [r, home, cat] = await Promise.all([get('/api/artifacts'), get('/api/home'), catalog()]);
  const curIds = new Set([home.current.seminar?.artifact_id, home.current.classroom?.artifact_id].filter(Boolean));
  let pref = {}; try { pref = JSON.parse(localStorage.getItem('yz-lib') || '{}'); } catch { /* storage unavailable */ }
  const f = { q: q.q ?? '', group: q.group || pref.group || 'course', module: q.module ?? '', level: q.level ?? '', status: q.status ?? '', origin: q.origin ?? '', sort: q.sort || pref.sort || 'recent', latest: (q.latest ?? pref.latest ?? '1') !== '0' };
  // 同源版本线：每条线只显示最新版本，并记录版本数
  const lines = new Map();
  for (const a of r.artifacts) { const k = a.lineage_id || a.artifact_id; if (!lines.has(k)) lines.set(k, []); lines.get(k).push(a); }
  for (const vs of lines.values()) vs.sort((x, y) => y.version - x.version || String(y.created_at).localeCompare(String(x.created_at)));
  const draw = () => {
    const kw = f.q.trim().toLowerCase();
    let items = f.latest ? [...lines.values()].map((vs) => ({ ...vs.find((a) => curIds.has(a.artifact_id)) || vs[0], _versions: vs })) : r.artifacts.map((a) => ({ ...a, _versions: lines.get(a.lineage_id || a.artifact_id) }));
    items = items.filter((a) => (!f.module || a.module === f.module) && (!f.level || levelOf(a.type) === f.level) && (!f.origin || ORIGIN(a.origin)[0] === f.origin)
      && (!f.status || (f.status === 'current' ? curIds.has(a.artifact_id) : a.status === f.status)) && (!kw || `${a.title} ${a.course_name} ${a.unit} ${TYPE_NAME[a.type] || ''}`.toLowerCase().includes(kw)));
    items.sort((a, b) => (f.sort === 'title' ? a.title.localeCompare(b.title, 'zh') : f.sort === 'oldest' ? String(a.created_at).localeCompare(String(b.created_at)) : String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at))));
    const keyOf = { course: (a) => a.course_name || '未填写课程', level: (a) => levelOf(a.type), module: (a) => a.module, status: (a) => (curIds.has(a.artifact_id) ? 'current' : a.status), origin: (a) => ORIGIN(a.origin)[0], none: () => 'all' }[f.group];
    const labelOf = { course: (k) => k, level: (k) => LEVELS.find(([x]) => x === k)[1], module: (k) => MODULE_NAME[k], status: (k) => ({ current: '当前产物', draft: '草稿', saved: '已保存版本' }[k] || k), origin: (k) => ORIGIN_GROUPS[k], none: () => '全部产物' }[f.group];
    const groups = new Map(); for (const a of items) { const k = keyOf(a); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
    let order = [...groups.keys()];
    if (f.group === 'level') order.sort((a, b) => LEVELS.findIndex(([x]) => x === a) - LEVELS.findIndex(([x]) => x === b));
    const card = (a) => { const [ok, ol] = ORIGIN(a.origin); const n = a._versions?.length || 1; return `<div class="card lib-card" data-level="${levelOf(a.type)}"><a class="lib-open" href="/library?id=${a.artifact_id}" data-link="/library?id=${a.artifact_id}">
      <div class="row" style="gap:6px"><span class="badge">${MODULE_NAME[a.module]}</span><span class="badge">${esc(TYPE_NAME[a.type] || a.type)}</span>${curIds.has(a.artifact_id) ? '<span class="badge gold">当前产物</span>' : ''}<span class="badge ${a.status === 'draft' ? 'warn' : 'green'}">${a.status === 'draft' ? '草稿' : '已保存'}</span></div>
      <h4>${esc(a.title)}</h4><div class="small faint">${a.course_name ? `${esc(a.course_name)}${a.unit ? ` · ${esc(a.unit)}` : ''} · ` : ''}v${a.version}${n > 1 ? ` · 共 ${n} 个版本` : ''}</div>
      <div class="small faint"><span class="lib-origin o-${ok}">${esc(ol)}</span> · ${fmtTime(a.updated_at || a.created_at)}</div></a>
      ${f.latest && n > 1 ? `<details class="lib-vers"><summary class="small">历史版本（${n}）</summary><div class="row" style="gap:4px;margin-top:4px">${a._versions.map((x) => `<a class="badge ${x.artifact_id === a.artifact_id ? 'gold' : ''}" href="/library?id=${x.artifact_id}" data-link="/library?id=${x.artifact_id}">v${x.version}${x.status === 'draft' ? ' 草稿' : ''}</a>`).join('')}</div></details>` : ''}</div>`; };
    const sub = (list) => { if (f.group !== 'course') return `<div class="lib-list">${list.map(card).join('')}</div>`;
      return LEVELS.map(([k, l]) => { const xs = list.filter((a) => levelOf(a.type) === k); return xs.length ? `<div class="lib-sub"><h4 class="lib-subh"><span class="lvl lvl-${k}"></span>${l}<span class="faint">（${xs.length}）</span></h4><div class="lib-list">${xs.map(card).join('')}</div></div>` : ''; }).join(''); };
    const sel = (id, label, opts, v) => `<label class="lib-f"><span>${label}</span><select id="${id}">${opts.map(([k, l]) => `<option value="${k}" ${String(v) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    root.innerHTML = `<div class="row" style="margin-bottom:10px"><h1 style="margin:0;font-size:calc(22px * var(--fs));letter-spacing:3px">产物库</h1><span class="small faint">${lines.size} 条版本线 · ${r.artifacts.length} 个版本</span><span class="grow"></span><button class="primary" id="new">新建空白产物</button></div>
      <div class="lib-toolbar panel"><label class="lib-f lib-search"><span>搜索</span><input id="lf-q" type="search" value="${esc(f.q)}" placeholder="标题、课程、单元、类型"></label>
        ${sel('lf-group', '分组', [['course', '按课程 → 层级'], ['level', '按层级'], ['module', '按模块'], ['status', '按状态'], ['origin', '按来源'], ['none', '不分组']], f.group)}
        ${sel('lf-module', '模块', [['', '全部'], ['seminar', '研课场'], ['classroom', '演课场']], f.module)}
        ${sel('lf-level', '层级', [['', '全部'], ...LEVELS.map(([k, l]) => [k, l])], f.level)}
        ${sel('lf-status', '状态', [['', '全部'], ['current', '当前产物'], ['draft', '草稿'], ['saved', '已保存']], f.status)}
        ${sel('lf-origin', '来源', [['', '全部'], ...Object.entries(ORIGIN_GROUPS)], f.origin)}
        ${sel('lf-sort', '排序', [['recent', '最近更新'], ['oldest', '最早创建'], ['title', '标题']], f.sort)}
        <label class="inline lib-latest"><input type="checkbox" id="lf-latest" ${f.latest ? 'checked' : ''}> 每条版本线只显示最新版</label></div>
      ${!r.artifacts.length ? '<div class="empty">还没有产物。可在“研课场”中组织研讨生成，或新建空白产物。</div>' : !items.length ? '<div class="empty">没有符合筛选条件的产物。</div>'
        : order.map((k) => `<details class="lib-group" open><summary><b>${esc(labelOf(k))}</b><span class="badge">${groups.get(k).length}</span>${f.group === 'course' ? `<span class="small faint">${LEVELS.filter(([lv]) => groups.get(k).some((a) => levelOf(a.type) === lv)).map(([, l]) => l).join(' · ')}</span>` : ''}</summary>${sub(groups.get(k))}</details>`).join('')}`;
    const sync = () => { try { localStorage.setItem('yz-lib', JSON.stringify({ group: f.group, sort: f.sort, latest: f.latest ? '1' : '0' })); } catch { /* storage unavailable */ } };
    for (const [id, k] of [['lf-group', 'group'], ['lf-module', 'module'], ['lf-level', 'level'], ['lf-status', 'status'], ['lf-origin', 'origin'], ['lf-sort', 'sort']]) $(`#${id}`).addEventListener('change', (e) => { f[k] = e.target.value; sync(); draw(); });
    $('#lf-latest').addEventListener('change', (e) => { f.latest = e.target.checked; sync(); draw(); });
    let tmr; $('#lf-q').addEventListener('input', (e) => { clearTimeout(tmr); tmr = setTimeout(() => { f.q = e.target.value; draw(); $('#lf-q').focus(); const n = $('#lf-q').value.length; $('#lf-q').setSelectionRange(n, n); }, 250); });
    $('#new').addEventListener('click', newArtifact);
  };
  const newArtifact = async () => {
    const types = cat.artifact_types.filter((t) => !t.system_only);
    const v = await modal({ title: '新建空白产物（研课场）', body: `<div style="display:grid;gap:10px"><label>产物类型<select id="nt">${types.map((t) => `<option value="${t.key}">${esc(t.name)}</option>`).join('')}</select></label>
      <label>教学设计框架<select id="nf"><option value="">不使用框架</option>${cat.frameworks.map((f) => `<option value="${f.key}">${esc(f.name)}</option>`).join('')}</select></label>
      <label class="inline"><input type="checkbox" id="np"> 叠加 PDCA 改进循环</label><label>标题<input id="nn" placeholder="如：零件放行判断·单课教案"></label></div>`,
      buttons: [{ label: '取消', value: null }, { label: '创建', cls: 'primary', handler: async () => post('/api/artifacts', { module: 'seminar', type: $('#nt').value, framework_key: $('#nf').value || null, with_pdca: $('#np').checked, title: $('#nn').value }) }] });
    if (v?.artifact_id) navigate(`/library?id=${v.artifact_id}`);
  };
  draw();
}

async function pageEditor(id) {
  const cat = await catalog();
  let d = await get(`/api/artifacts/${id}`);
  const draw = () => {
    const a = d.artifact, b = a.body;
    const steps = b.framework?.steps || [];
    const UNIT_KEY = { syllabus: 'content', semester_plan: 'weeks', course_design: 'units', teaching_schedule: 'rows' };
    const unitRows = UNIT_KEY[a.type] ? b.sections.find((s) => s.key === UNIT_KEY[a.type])?.rows : null;
    const unitLabel = (r) => (a.type === 'semester_plan' ? `第${r.week}周 ${r.chapter}` : a.type === 'teaching_schedule' ? `第${r.week}周 ${r.lesson_no || ''} ${r.content || ''}` : `${r.unit} ${r.content}`);
    const cell = (sec, r, i, c) => {
      const v = esc(r[c.key] ?? ''); const at = `data-sec="${sec.key}" data-row="${i}" data-col="${c.key}"`;
      if (c.type === 'stage') return `<select ${at}><option value=""></option>${steps.map(([k, l]) => `<option value="${k}" ${r[c.key] === k || r[c.key] === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      if (c.type === 'select') return `<select ${at}><option value=""></option>${c.options.map((o) => `<option ${r[c.key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      if (c.type === 'longtext') return `<textarea ${at} rows="2">${v}</textarea>`;
      return `<input ${at} value="${v}" ${c.type === 'number' ? 'inputmode="numeric"' : ''}>`;
    };
    const system = cat.artifact_types.find((t) => t.key === a.type)?.system_only;
    root.innerHTML = `<div class="row" style="margin-bottom:12px"><button class="ghost" data-link="/library">← 产物库</button><span class="badge">${MODULE_NAME[a.module]}</span><span class="badge">${esc(TYPE_NAME[a.type] || a.type)}</span><span class="badge">v${a.version}</span><span class="badge ${a.status === 'draft' ? 'warn' : 'green'}">${a.status === 'draft' ? '草稿（可直接编辑）' : '已保存版本（编辑将生成新草稿）'}</span>${d.is_current ? '<span class="badge gold">当前产物</span>' : ''}</div>
    <div class="editor"><div>
      <div class="panel" style="margin-bottom:14px"><label>标题<input id="title" value="${esc(a.title)}"></label>
      ${b.notice ? `<div class="notice" style="margin-top:10px">${esc(b.notice)}</div>` : ''}
      ${b.framework ? `<p class="small muted" style="margin:10px 0 4px">教学设计框架：<b style="color:var(--gold)">${esc(b.framework.name)}</b>${b.with_pdca ? ' + PDCA 改进循环' : ''} · 步骤：${steps.map((s) => esc(s[1])).join(' → ')}</p>
        ${Object.keys(b.framework.fields || {}).length || (cat.frameworks.find((f) => f.key === b.framework.key)?.fields || []).length ? `<div class="grid2">${(cat.frameworks.find((f) => f.key === b.framework.key)?.fields || []).map(([k, l, ph]) => `<label>${esc(l)}<input data-fw="${k}" value="${esc(b.framework.fields?.[k] || '')}" placeholder="${esc(ph || '')}"></label>`).join('')}</div>` : ''}` : ''}
      <details class="more"><summary>课程信息（共用输入）</summary><div class="grid3">${cat.course_fields.map(([k, l, , t]) => `<label>${esc(l)}<input data-course="${k}" ${t === 'number' ? 'inputmode="numeric"' : ''} value="${esc(b.course?.[k] ?? '')}"></label>`).join('')}</div></details>
      ${unitRows ? `<label style="margin-top:10px">当前单元（导入演课场时执行的单元）<select id="unit"><option value="">未设定</option>${unitRows.map((r, i) => `<option value="${i}" ${String(b.current_unit) === String(i) ? 'selected' : ''}>${esc(unitLabel(r)).slice(0, 60)}</option>`).join('')}</select></label>` : ''}
      </div>
      ${b.sections.map((s) => `<section class="panel sec" id="sec-${s.key}"><div class="sec-head"><h3>${esc(s.title)}</h3>${s.author ? `<span class="badge">${esc(s.author)}</span>` : ''}${s.revision ? `<span class="badge">修订 ${s.revision}</span>` : ''}<span class="grow"></span>${s.kind === 'table' ? ioButtons('artifact_section', { artifact_id: a.artifact_id, section_key: s.key }, { importLabel: '导入表格', exportLabel: '导出表格', canImport: !system }) : ''}${!system && a.module === 'seminar' ? `<button class="small" data-regen="${s.key}">局部重生成</button>` : ''}</div>
        ${s.kind === 'text' ? `<textarea data-sec="${s.key}" data-text="1" rows="4">${esc(s.content || '')}</textarea>` : `<div class="scroll-x"><table class="etable"><thead><tr>${s.columns.map((c) => `<th class="${c.teacher_only ? 'tonly' : ''}" title="${c.teacher_only ? '仅教师可见：不进入学生卷与学生智能体上下文' : ''}">${esc(c.label)}${c.teacher_only ? ' 🔒' : ''}</th>`).join('')}<th></th></tr></thead>
          <tbody>${s.rows.map((r, i) => `<tr>${s.columns.map((c) => `<td class="${c.teacher_only ? 'tonly' : ''}" style="min-width:${c.type === 'longtext' ? 180 : c.type === 'number' ? 64 : 100}px">${cell(s, r, i, c)}</td>`).join('')}<td><button class="small ghost" data-delrow="${s.key}:${i}" aria-label="删除第${i + 1}行">✕</button></td></tr>`).join('')}</tbody></table></div>
          <button class="small" data-addrow="${s.key}" style="margin-top:6px">＋ 添加一行</button>`}</section>`).join('')}
    </div>
    <aside class="side">
      <div class="panel"><div style="display:grid;gap:8px">
        <button class="primary" id="save-draft">${a.status === 'draft' ? '保存草稿' : '编辑并生成新草稿'}</button>
        ${a.status === 'draft' ? '<button class="gold" id="save-version">保存为正式版本（教师已审阅）</button>' : ''}
        ${a.module === 'seminar' && (['lesson_plan', 'courseware', 'exercises', 'exam'].includes(a.type) || (b.current_unit != null && UNIT_KEY[a.type])) ? '<button class="gold" id="to-class" title="设为当前产物并导入演课场，直接开课">送到演课场上课 →</button>' : ''}
        <button id="set-current" ${d.is_current ? 'disabled' : ''}>${d.is_current ? '已是当前产物' : `设为${MODULE_NAME[a.module]}当前产物`}</button>
        <hr class="sep" style="margin:6px 0">
        <div class="row" style="gap:6px"><button class="small" data-exp="html">HTML 预览</button>${cat.docx_types.includes(a.type) ? '<button class="small" data-exp="docx">DOCX</button>' : '<span class="small faint">课件：页面结构+HTML预览（PPTX 另行验收）</span>'}<button class="small" data-exp="json">JSON</button></div>
        ${a.type === 'exam' ? '<div class="row" style="gap:6px"><button class="small" data-exp="docx" data-var="student">学生卷 DOCX</button><button class="small" data-exp="docx" data-var="answers">教师答案卷 DOCX</button></div>' : ['exercises'].includes(a.type) ? '<div class="row" style="gap:6px"><button class="small" data-exp="docx" data-var="student">学生版（隐藏答案）</button></div>' : ''}
      </div></div>
      <div class="panel"><h2>结构校验</h2><div class="issues">${d.issues.length ? d.issues.map((i) => `<div class="${i.level}">${i.level === 'error' ? '✕' : '!'} ${esc(i.message)}</div>`).join('') : '<div class="small" style="color:var(--green)">✓ 未发现结构问题</div>'}</div></div>
      ${d.ideology_check && (d.ideology_check.rows_total || d.ideology_check.value_goals) ? (() => { const k = d.ideology_check; return `<div class="panel"><h2>课程思政融入自检</h2><div class="kv small">
        <dt>含思政融入点的条目</dt><dd>${k.rows_total ? `${k.rows_with_ideology} / ${k.rows_total}${k.embedding === 'under' ? ' <span style="color:var(--warn)">偏少</span>' : k.embedding === 'over' ? ' <span style="color:var(--warn)">几乎每条都有，注意“贴标签”，宜少而精</span>' : ''}` : '（本类产物无逐条融入点）'}</dd>
        ${k.repeated_rows ? `<dt>同质化</dt><dd style="color:var(--warn)">${k.repeated_rows} 条融入点表述雷同，建议按各单元内容分别设计</dd>` : ''}
        ${k.n_detached ? `<dt>与专业内容脱节</dt><dd style="color:var(--warn)" title="${esc(k.detached_rows.join('、'))}">${k.n_detached} 条融入点与所在行的专业内容没有共同关键词（${esc(k.detached_rows.slice(0, 3).join('、'))}${k.n_detached > 3 ? '…' : ''}）</dd>` : ''}
        <dt>思政段落</dt><dd>${k.ideology_text_filled ? '已填写' : '<span style="color:var(--warn)">未填写或过短</span>'}</dd>
        <dt>口号化提示</dt><dd style="${k.slogan_like ? 'color:var(--warn)' : 'color:var(--green)'}">${k.slogan_like ? `${k.slogan_like} 处，建议写明专业情境与学生任务` : '未发现'}</dd>
        <dt>价值目标被活动/评价引用</dt><dd>${k.value_goals ? `${k.value_goals_linked} / ${k.value_goals}` : '未设价值目标'}</dd>
        <dt>“待核查”来源</dt><dd>${k.pending_sources} 处${k.pending_sources ? '（使用前请核实出处）' : ''}</dd>
        <dt>引用上传材料</dt><dd>${k.cites_materials ? '是' : '否'}</dd></div>
        <p class="small faint" style="margin:6px 0 0">自检只看结构与表述形式，不评价思政融入的实际质量；请结合七维量规人工评审。</p></div>`; })() : ''}
      ${d.derived.alignment ? `<div class="panel"><h2>目标—活动—评价一致性</h2><table class="data"><tr><th>目标</th><th>支撑阶段</th><th>评价</th></tr>${d.derived.alignment.map((m) => `<tr><td>${esc(m.goal)}</td><td class="small">${esc(m.activities.join('、') || '—')}</td><td class="small" style="${m.assessed_in.length ? '' : 'color:var(--warn)'}">${esc(m.assessed_in.join('、') || '未评价')}</td></tr>`).join('')}</table></div>` : ''}
      ${d.derived.matrix ? `<div class="panel"><h2>目标—内容—评价矩阵</h2><table class="data"><tr><th>目标</th><th>内容</th><th>考核</th></tr>${d.derived.matrix.map((m) => `<tr><td>${esc(m.goal)}</td><td class="small">${esc(m.content.join('、') || '—')}</td><td class="small">${esc(m.assessment.join('、') || '—')}</td></tr>`).join('')}</table></div>` : ''}
      ${d.derived.blueprint ? `<div class="panel"><h2>双向细目表（分值）</h2><div class="scroll-x"><table class="data"><tr><th>目标</th>${d.derived.blueprint.types.map((t) => `<th>${esc(t)}</th>`).join('')}</tr>${d.derived.blueprint.rows.map((r) => `<tr><td>${esc(r.goal)}</td>${r.cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div></div>` : ''}
      <details class="panel"><summary style="cursor:pointer;color:var(--gold)">产物详情／来源</summary><div class="chain" style="margin-top:8px">${d.provenance.map((p) => `<div><b>${esc(p.title)}</b> v${p.version} · ${MODULE_NAME[p.module]}<br><span class="faint">${esc(ORIGIN(p.origin)[1])} · ${fmtTime(p.created_at)}</span>${p.transfer ? `<br><span style="color:var(--cyan)">由${MODULE_NAME[p.transfer.from_module]}流转 · ${fmtTime(p.transfer.created_at)}</span>` : ''}${p.source_run_id ? `<br><span class="mono faint">运行 ${esc(p.source_run_id)}</span>` : ''}</div>`).join('')}</div>
        <h4 style="margin-top:12px;font-size:calc(13px * var(--fs))">同源版本</h4>${d.versions.map((v) => `<div class="small"><a href="/library?id=${v.artifact_id}" data-link="/library?id=${v.artifact_id}">v${v.version}</a> · ${MODULE_NAME[v.module]} · ${v.status === 'draft' ? '草稿' : '已保存'}</div>`).join('')}</details>
    </aside></div>`;
  };
  const collect = () => {
    const b = structuredClone(d.artifact.body);
    b.sections.forEach((s) => {
      if (s.kind === 'text') s.content = $(`[data-sec="${s.key}"][data-text]`).value;
      else s.rows = s.rows.map((r, i) => { const out = { ...r }; s.columns.forEach((c) => { const el = $(`[data-sec="${s.key}"][data-row="${i}"][data-col="${c.key}"]`); if (el) out[c.key] = el.value; }); return out; });
    });
    $$('[data-course]').forEach((el) => { b.course[el.dataset.course] = el.value; });
    if (b.framework) { b.framework.fields = { ...(b.framework.fields || {}) }; $$('[data-fw]').forEach((el) => { b.framework.fields[el.dataset.fw] = el.value; }); }
    if ($('#unit')) b.current_unit = $('#unit').value === '' ? null : Number($('#unit').value);
    return { title: $('#title').value, body: b };
  };
  const bind = () => {
    $$('[data-addrow]').forEach((btn) => btn.addEventListener('click', () => { const c = collect(); d.artifact.body = c.body; d.artifact.title = c.title; const s = d.artifact.body.sections.find((x) => x.key === btn.dataset.addrow); s.rows.push(Object.fromEntries(s.columns.map((col) => [col.key, '']))); draw(); bind(); }));
    $$('[data-delrow]').forEach((btn) => btn.addEventListener('click', () => { const [k, i] = btn.dataset.delrow.split(':'); const c = collect(); d.artifact.body = c.body; d.artifact.title = c.title; d.artifact.body.sections.find((x) => x.key === k).rows.splice(+i, 1); draw(); bind(); }));
    $('#save-draft').addEventListener('click', async () => {
      try { const r = await put(`/api/artifacts/${d.artifact.artifact_id}`, collect()); if (r.artifact.artifact_id !== d.artifact.artifact_id) { toast(`已生成新草稿 v${r.artifact.version}`); return navigate(`/library?id=${r.artifact.artifact_id}`, true); } d = r; draw(); bind(); toast('草稿已保存'); } catch (e) { fail(e); }
    });
    $('#save-version')?.addEventListener('click', async () => {
      const errors = d.issues.filter((i) => i.level === 'error').length;
      if (!(await confirmBox('保存为正式版本', `<p>保存后该版本不可覆盖，后续修改将生成新草稿。</p>${errors ? `<div class="notice red">仍有 ${errors} 项结构错误，建议修正后再保存。</div>` : ''}<p class="small muted">确认表示你已审阅 AI 辅助/演示生成的内容。</p>`, '保存版本'))) return;
      try { await put(`/api/artifacts/${d.artifact.artifact_id}`, collect()); d = await post(`/api/artifacts/${d.artifact.artifact_id}/save`, { reviewed: true }); draw(); bind(); toast('已保存为正式版本'); } catch (e) { fail(e); }
    });
    $('#set-current').addEventListener('click', async () => { try { d = await post(`/api/artifacts/${d.artifact.artifact_id}/current`); draw(); bind(); toast('已设为当前产物'); } catch (e) { fail(e); } });
    $('#to-class')?.addEventListener('click', async () => {
      const a = d.artifact;
      if (!(await confirmBox('送到演课场上课', `<p>将《${esc(a.title)}》v${a.version} 设为研课场当前产物，并导入演课场。进入演课场后点 ▶ 即可开课。</p>${a.status === 'draft' ? '<p class="small muted">这是草稿，会先保存为正式版本（表示你已审阅）。编辑区里未点“保存草稿”的修改不会带过去。</p>' : ''}`, '导入并去上课'))) return;
      try { await post(`/api/artifacts/${a.artifact_id}/current`); await post('/api/transfers', { from: 'seminar', idempotency_key: key('xfer'), save_draft: true }); toast('已导入演课场，点 ▶ 开课'); navigate('/classroom'); } catch (e) { fail(e); }
    });
    $$('[data-exp]').forEach((b) => b.addEventListener('click', () => {
      const f = b.dataset.exp, v = b.dataset.var || 'teacher';
      const url = `/api/artifacts/${d.artifact.artifact_id}/export?format=${f}&variant=${v}`;
      if (f === 'html') window.open(url, '_blank', 'noopener'); else download(url);
    }));
    $$('[data-regen]').forEach((b) => b.addEventListener('click', () => regenSection(d.artifact, b.dataset.regen)));
    // 表格导入：按列名智能对应后填入当前编辑区（尚未保存）；导出为已保存内容
    bindIo(root, { artifact_section: { title: '导入表格', hint: '第一行为表头，列名可以和本表的列名不完全一致，系统会自动对应；导入后请检查并点“保存草稿”。', onRecords: (records, mode, ctx) => {
      const c = collect(); d.artifact.body = c.body; d.artifact.title = c.title;
      const s = d.artifact.body.sections.find((x) => x.key === ctx.section_key); if (!s) return;
      const rows = records.map((r) => Object.fromEntries(s.columns.map((col) => [col.key, r[col.key] ?? ''])));
      s.rows = mode === 'replace' ? rows : [...s.rows, ...rows];
      draw(); bind();
    } } });
  };
  draw(); bind();
}

async function regenSection(a, sectionKey) {
  const cat = await catalog();
  const sec = a.body.sections.find((s) => s.key === sectionKey);
  let mode = cat.model_available ? 'model' : 'demo';
  const est = async () => { try { const e = await post('/api/runs/estimate', { module: 'seminar', exec_mode: mode, task: 'regen', target_artifact_id: a.artifact_id, section_key: sectionKey }); return `预计最多 ${e.max_calls} 次调用，最多 ${e.max_credits} 积分`; } catch (e) { return e.message; } };
  const ok = await modal({ title: `局部重生成：${sec.title}`, body: `<p class="small muted">只重新生成本段落，其他段落不变。已保存版本将生成新草稿。</p>
    <label>执行方式<select id="rg-mode"><option value="model" ${mode === 'model' ? 'selected' : ''} ${cat.model_available ? '' : 'disabled'}>真实模型${cat.model_available ? '' : `（不可用：${esc(cat.model_status.message)}）`}</option><option value="demo" ${mode === 'demo' ? 'selected' : ''}>演示骨架（不调用模型、不计费）</option></select></label>
    <div class="estimate" id="rg-est" style="margin-top:10px">…</div>`,
    onMount: async (m) => { const upd = async () => { mode = $('#rg-mode', m).value; $('#rg-est', m).textContent = await est(); }; $('#rg-mode', m).addEventListener('change', upd); upd(); },
    buttons: [{ label: '取消', value: false }, { label: '开始重生成', value: true, cls: 'primary' }] });
  if (!ok) return;
  try {
    const run = await post('/api/runs', { module: 'seminar', exec_mode: mode, task: 'regen', target_artifact_id: a.artifact_id, section_key: sectionKey });
    await post(`/api/runs/${run.run_id}/start`);
    for (let i = 0; i < 3; i++) { const s = await post(`/api/runs/${run.run_id}/step`, { idempotency_key: key('rg') }); if (s.ended) break; }
    const v = await get(`/api/runs/${run.run_id}`);
    await refreshMe();
    toast('段落已重生成'); navigate(`/library?id=${v.run.output_artifact_id}`, true);
  } catch (e) { fail(e); }
}

// ---------- rating ----------
async function pageRating(q) {
  const [runs, rubrics] = await Promise.all([get('/api/runs'), get('/api/rubrics')]);
  const runId = q.run || runs.runs.find((r) => r.started_at)?.run_id;
  const rubricList = rubrics.rubrics;
  let rubric = rubricList.find((r) => r.rubric_id === q.rubric) || rubricList[0];
  const v = runId ? await get(`/api/runs/${runId}`) : null;
  const names = Object.fromEntries((v?.profiles || []).map((p) => [p.agent_id, p.name]));
  let blind = q.blind === '1'; if (q.blind == null) { try { blind = localStorage.getItem('yz-blind') === '1'; } catch { /* storage unavailable */ } }
  const rater0 = () => { try { return localStorage.getItem('yz-rater') || ''; } catch { return ''; } };
  // 盲评：按“评价者 + 运行”做确定性乱序，隐藏发言者、生成方式与他人评分
  const seeded = (arr, seed) => { let h = 2166136261; for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0; const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; const j = h % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const evList = () => (blind ? seeded((v?.events || []).filter((e) => e.actor_type !== 'system'), `${rater0()}|${runId}`) : v?.events || []);
  let selected = v?.events.find((e) => e.event_id === q.event) || v?.events.find((e) => e.actor_type !== 'system');
  if (blind && !q.event) selected = evList()[0];
  const draw = async () => {
    const all0 = selected ? (await get(`/api/ratings?target_id=${selected.event_id}`)).ratings : [];
    const ratings = blind ? all0.filter((r) => r.rater_code === rater0()) : all0;
    const list = evList(); const runIdx = Object.fromEntries(runs.runs.filter((r) => r.started_at).map((r, i, arr) => [r.run_id, arr.length - i]));
    const dims = rubric.body.dimensions, [lo, hi] = rubric.body.scale;
    root.innerHTML = `<div class="row" style="margin-bottom:12px"><h1 style="margin:0;font-size:calc(22px * var(--fs));letter-spacing:3px">人工评分</h1><span class="grow"></span>
      <select id="run-sel" style="width:auto;max-width:420px" aria-label="选择运行">${runs.runs.filter((r) => r.started_at).map((r) => `<option value="${r.run_id}" ${r.run_id === runId ? 'selected' : ''}>${blind ? `${MODULE_NAME[r.module]} · 运行 ${runIdx[r.run_id]}` : `${MODULE_NAME[r.module]} · ${fmtTime(r.created_at)} · ${STATUS_NAME[r.status]} · ${r.exec_mode === 'model' ? '真实模型' : '演示'}`}</option>`).join('')}</select>
      <select id="rub-sel" style="width:auto">${rubricList.map((r) => `<option value="${r.rubric_id}" ${r.rubric_id === rubric.rubric_id ? 'selected' : ''}>${esc(r.name)}${/v\d+$/.test(r.name) ? '' : ` v${r.version}`}${r.builtin ? '' : '（自定义）'}</option>`).join('')}</select>
      <button id="imp">导入量规 JSON</button></div>
      <div class="row rate-tools"><label class="inline"><input type="checkbox" id="blind" ${blind ? 'checked' : ''}> 盲评模式</label><span class="small faint">${blind ? '已隐藏发言者身份、生成方式（真实模型 / 本地生成）和其他评价者的评分；事件顺序按你的评价者编码随机打乱。' : '多位评价者独立评分时建议开启，用于计算评分者一致性。'}</span><span class="grow"></span>${ioButtons('ratings', { rubric_id: rubric.rubric_id }, { importLabel: '导入评分', exportLabel: '导出评分' })}<button class="small" data-link="/research?tab=irr&r=${rubric.rubric_id}">一致性分析</button></div>
      <div class="notice" style="margin-bottom:12px">${esc(rubric.body.note || '')}</div>
      ${!v ? '<div class="empty">还没有可评分的运行。</div>' : `<div class="editor"><div class="panel" style="max-height:72vh;overflow:auto"><h2>事件（${list.length}）</h2>${list.map((e, i) => `<button class="card" data-ev="${e.event_id}" style="margin-bottom:6px;width:100%;${selected?.event_id === e.event_id ? 'border-color:var(--gold)' : ''}"><div class="small faint">${blind ? `待评 ${i + 1}` : `#${e.sequence} · ${esc(names[e.actor_id] || (e.actor_type === 'human' ? '真人' : e.actor_id))} · ${esc(e.kind)} · ${SOURCE_NAME[e.source] || e.source}`}</div><div>${esc(e.text.slice(0, 160))}</div></button>`).join('')}</div>
      <aside class="side"><div class="panel">${selected ? `<h2>评分：${blind ? `待评 ${list.findIndex((e) => e.event_id === selected.event_id) + 1}` : `#${selected.sequence}`}</h2><p class="small">${esc(selected.text)}</p>
        <label>评价者假名编码<input id="rater" value="${esc(localStorage.getItem('yz-rater') || '')}" placeholder="如 R01"></label>
        <div style="margin-top:10px;display:grid;gap:8px">${dims.map((dm) => `<fieldset style="border:1px solid var(--line);border-radius:8px;padding:6px 8px"><legend class="small" style="color:var(--gold)">${esc(dm.label)}</legend>
          <div class="row" style="gap:6px">${Array.from({ length: hi - lo + 1 }, (_, i) => `<label class="inline" title="${esc(dm.anchors[i])}"><input type="radio" name="d-${dm.key}" value="${lo + i}">${lo + i}</label>`).join('')}
          <label class="inline"><input type="radio" name="d-${dm.key}" value="not_rated" checked>未评</label><label class="inline"><input type="radio" name="d-${dm.key}" value="not_applicable">不适用</label><label class="inline"><input type="radio" name="d-${dm.key}" value="insufficient_evidence">证据不足</label></div>
          <div class="faint" style="font-size:max(12px, calc(11px * var(--fs)))">${dm.anchors.map((x, i) => `${lo + i}=${esc(x)}`).join('；')}</div></fieldset>`).join('')}</div>
        <label style="margin-top:8px">备注（依据）<textarea id="note"></textarea></label>
        <button class="primary" id="submit" style="margin-top:10px;width:100%">提交评分</button>
        <h4 style="margin-top:14px;font-size:calc(13px * var(--fs))">${blind ? '我的评分记录' : '评分记录（重评保留修订链）'}</h4>${ratings.map((r) => `<div class="small" style="border-left:2px solid var(--gold-2);padding-left:8px;margin:6px 0">${esc(r.rater_code)} · ${fmtTime(r.created_at)}${r.supersedes_rating_id ? ' · 重评' : ''}<br>${Object.entries(r.scores).map(([k, s]) => `${esc(dims.find((x) => x.key === k)?.label || k)}:${typeof s === 'number' ? s : { not_rated: '未评', not_applicable: '不适用', insufficient_evidence: '证据不足' }[s]}`).join('；')}</div>`).join('') || '<div class="small faint">暂无</div>'}` : '<div class="empty">选择左侧事件</div>'}</div></aside></div>`}`;
    $('#run-sel')?.addEventListener('change', (e) => navigate(`/rating?run=${e.target.value}${blind ? '&blind=1' : ''}`));
    $('#blind').addEventListener('change', (e) => { try { localStorage.setItem('yz-blind', e.target.checked ? '1' : '0'); } catch { /* storage unavailable */ } navigate(`/rating?run=${runId}&blind=${e.target.checked ? 1 : 0}`, true); });
    if (blind) $('#rater')?.addEventListener('change', (e) => { try { localStorage.setItem('yz-rater', e.target.value); } catch { /* storage unavailable */ } navigate(`/rating?run=${runId}&blind=1`, true); });
    bindIo(root, { ratings: { title: '导入评分', hint: '一行 = 一位评价者对一个对象（事件ID）的评分；各维度一列。', onDone: () => draw() } });
    $('#rub-sel')?.addEventListener('change', (e) => { rubric = rubricList.find((r) => r.rubric_id === e.target.value); draw(); });
    $$('[data-ev]').forEach((b) => b.addEventListener('click', () => { selected = v.events.find((e) => e.event_id === b.dataset.ev); draw(); }));
    $('#submit')?.addEventListener('click', async () => {
      const scores = Object.fromEntries(dims.map((dm) => { const x = $(`input[name="d-${dm.key}"]:checked`).value; return [dm.key, /^\d+$/.test(x) ? Number(x) : x]; }));
      try { localStorage.setItem('yz-rater', $('#rater').value); } catch { /* storage unavailable */ }
      try { await post('/api/ratings', { target_type: 'event', target_id: selected.event_id, rubric_id: rubric.rubric_id, rater_code: $('#rater').value, scores, note: $('#note').value }); toast('评分已保存'); draw(); } catch (e) { fail(e); }
    });
    $('#imp').addEventListener('click', importRubric);
  };
  await draw();
}

async function importRubric() {
  const sample = JSON.stringify({ key: 'my_rubric', name: '我的量规', scale: [0, 2], note: '说明', dimensions: [{ key: 'clarity', label: '表达清晰', anchors: ['不清楚', '基本清楚', '清楚'] }] }, null, 2);
  await modal({ title: '导入自定义量规（JSON）', wide: true, body: `<p class="small muted">校验结构 → 预览 → 保存为新版本；不改变历史评分。</p><textarea id="rj" rows="14" class="mono">${esc(sample)}</textarea><div id="rpv" style="margin-top:8px"></div>`,
    buttons: [{ label: '取消', value: null }, { label: '预览', handler: async (m) => { const p = await post('/api/rubrics/preview', JSON.parse($('#rj', m).value)); $('#rpv', m).innerHTML = `<div class="notice cyan">校验通过：${esc(p.preview.name)} · 将保存为 v${p.preview.version} · ${p.preview.dimensions.length} 个维度 · 等级 ${p.preview.scale.join('—')}</div>`; return false; } },
      { label: '保存', cls: 'primary', handler: async (m) => { const r = await post('/api/rubrics', JSON.parse($('#rj', m).value)); toast(`已导入 ${r.name} v${r.version}`); } }] });
  navigate('/rating', true);
}

// ---------- export ----------
async function pageExport() {
  const opt = await get('/api/export/options');
  root.innerHTML = `<h1 style="font-size:calc(22px * var(--fs));letter-spacing:3px">研究数据导出</h1>
  <p class="small muted">独立于首页箭头。先预览真实记录数、字段、缺失值与样例，再下载。研究导出不扣积分；不含 API Key、登录数据、积分流水。</p>
  <div class="editor"><form class="panel" id="xf"><div class="grid3">
    <label>模块<select name="module"><option value="">全部</option><option value="seminar">研课场</option><option value="classroom">演课场</option></select></label>
    <label>运行状态<select name="status"><option value="">全部</option>${Object.entries(STATUS_NAME).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
    <label>包类型<select name="package"><option value="shared">共享包（假名化、无自由文本）</option><option value="full">完整研究包（教师主动选择）</option></select></label>
    <label>开始日期<input type="date" name="from"></label><label>结束日期<input type="date" name="to"></label></div>
    <h4 style="margin:12px 0 6px;font-size:calc(13px * var(--fs))">数据来源</h4><div class="row">${Object.entries(SOURCE_NAME).map(([k, v]) => `<label class="inline"><input type="checkbox" data-src="${k}" checked>${v}</label>`).join('')}</div>
    <h4 style="margin:12px 0 6px;font-size:calc(13px * var(--fs))">数据类别</h4><div class="row">${Object.entries(opt.categories).map(([k, v]) => `<label class="inline"><input type="checkbox" data-cat="${k}" checked>${v}</label>`).join('')}</div>
    <h4 style="margin:12px 0 6px;font-size:calc(13px * var(--fs))">自由文本（仅完整研究包）</h4><div class="row"><label class="inline"><input type="checkbox" name="include_artifact_text">产物正文</label><label class="inline"><input type="checkbox" name="include_event_text">发言正文</label><label class="inline"><input type="checkbox" name="include_rating_notes">评分备注</label></div>
    <h4 style="margin:12px 0 6px;font-size:calc(13px * var(--fs))">指定运行（可选，不选=筛选范围内全部）</h4><div style="max-height:180px;overflow:auto;display:grid;gap:2px">${opt.runs.map((r) => `<label class="inline small"><input type="checkbox" data-run="${r.run_id}">${MODULE_NAME[r.module]} · ${fmtTime(r.created_at)} · ${STATUS_NAME[r.status]} · ${r.exec_mode}</label>`).join('') || '<span class="faint small">暂无运行</span>'}</div>
    <div class="row" style="margin-top:14px"><button type="button" id="pv">预览</button><button type="button" class="primary" id="dl">下载 ZIP</button></div></form>
    <aside class="side"><div class="panel" id="pvbox"><h2>预览</h2><div class="faint small">点击“预览”查看将导出的记录。</div></div></aside></div>`;
  const filters = () => {
    const f = formData($('#xf'));
    f.sources = $$('[data-src]').filter((x) => x.checked).map((x) => x.dataset.src);
    f.categories = $$('[data-cat]').filter((x) => x.checked).map((x) => x.dataset.cat);
    f.run_ids = $$('[data-run]').filter((x) => x.checked).map((x) => x.dataset.run);
    for (const k of ['module', 'status', 'from', 'to']) if (!f[k]) delete f[k];
    return f;
  };
  $('#pv').addEventListener('click', async () => {
    try {
      const p = await post('/api/export/preview', filters());
      $('#pvbox').innerHTML = `<h2>预览</h2><p class="small">${p.shared ? '共享包：假名化，不含自由文本' : '完整研究包'} · 另含 ${p.extra_files.concat(['dataset.json', 'README.md', 'data-dictionary.md', 'manifest.json']).join('、')}</p>
        ${p.tables.map((t) => `<details style="margin:6px 0"><summary><b>${t.name}</b> <span class="badge ${t.rows ? 'cyan' : ''}">${t.rows ? `${t.rows} 行` : '0 条 / 未采集'}</span></summary><div class="small" style="margin-top:4px">字段：${t.fields.map((f) => `${f}${t.missing[f] ? `<span class="faint">(缺${t.missing[f]})</span>` : ''}`).join('，')}</div>${t.sample ? `<pre class="mono" style="white-space:pre-wrap;max-height:160px;overflow:auto;background:var(--code-bg);padding:6px;border-radius:6px">${esc(JSON.stringify(t.sample, null, 1))}</pre>` : ''}</details>`).join('')}`;
    } catch (e) { fail(e); }
  });
  $('#dl').addEventListener('click', async () => { try { await downloadPost('/api/export/zip', filters(), 'yanzhi-research.zip'); toast('已开始下载'); } catch (e) { fail(e); } });
}

// ---------- account ----------
async function pageAccount() {
  const me = await refreshMe();
  let legacy = null; try { legacy = localStorage.getItem('yanzhi-study-v1'); } catch { /* unavailable */ }
  root.innerHTML = `<h1 style="font-size:calc(22px * var(--fs));letter-spacing:3px">账号、积分与备份</h1>
  <div class="grid2">
    <form class="panel" id="pw"><h2>${me.user.must_change_password ? '首次登录：请修改密码' : '修改密码'}</h2>${me.user.must_change_password ? '<div class="notice" style="margin-bottom:10px">管理员创建的临时密码需要先修改，才能使用其他功能。</div>' : ''}
      <div style="display:grid;gap:10px"><label>原密码<input type="password" name="old_password" autocomplete="current-password"></label><label>新密码（≥8位，含字母和数字）<input type="password" name="new_password" autocomplete="new-password"></label><button class="primary">修改密码</button></div></form>
    <div class="panel"><h2>积分</h2><div class="row"><span class="badge gold">总余额 ${me.balance.total}</span><span class="badge warn">冻结 ${me.balance.reserved}</span><span class="badge cyan">可用 ${me.balance.available}</span></div>
      <p class="small muted">新教师账号一次性获得初始积分；本期没有周期赠送与充值。积分由管理员分配。</p><button id="ledger">查看积分流水</button>
      <hr class="sep"><dl class="kv"><dt>登录名</dt><dd>${esc(me.user.login)}</dd><dt>研究假名</dt><dd class="mono">${esc(me.user.pseudonym)}</dd><dt>最近登录</dt><dd>${fmtTime(me.user.last_login_at)}</dd></dl></div>
    <div class="panel" id="ava-panel"><h2>我的头像</h2><p class="small muted">从 12 个 3D 水晶球头像中选择，保存后右上角会显示你的新头像。</p>${avatarPicker(me.user.avatar_key, 'my-ava')}<button class="primary" id="ava-save" style="margin-top:10px">保存头像</button></div>
    <div class="panel"><h2>完整备份</h2><p class="small muted">下载本人全部教学与研究数据（不含账号凭据、积分与密钥）。</p><button id="bk">下载个人备份 JSON</button></div>
    <div class="panel"><h2>恢复备份 / 迁移旧版本地数据</h2><p class="small muted">支持 v3 个人备份，以及旧版本地原型（localStorage 或其备份 JSON）。先做结构与引用校验、冲突预览；失败不部分覆盖；记录只归属到当前账号。</p>
      <input type="file" id="rf" accept="application/json,.json"> ${legacy ? '<button id="lg" class="gold" style="margin-top:8px">检测到本浏览器中的旧版本地数据，预览迁移</button>' : ''}</div>
  </div>`;
  $('#pw').addEventListener('submit', async (e) => { e.preventDefault(); try { await post('/api/auth/password', formData(e.target)); toast('密码已修改'); state.me = null; await refreshMe(); navigate('/'); } catch (err) { fail(err); } });
  $('#ledger').addEventListener('click', showLedger);
  $('#ava-save').addEventListener('click', async () => { const k = document.querySelector('input[name="my-ava"]:checked')?.value; if (!k) return toast('请选择一个头像', true); try { await put('/api/me/avatar', { avatar_key: k }); await refreshMe(); toast('头像已更新'); } catch (e) { fail(e); } });
  $('#bk').addEventListener('click', () => download('/api/backup'));
  $('#rf').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 35e6) return fail(new Error('文件过大')); try { await restoreFlow(JSON.parse(await f.text())); } catch (err) { fail(err.name === 'SyntaxError' ? new Error('不是有效的 JSON 文件') : err); } e.target.value = ''; });
  $('#lg')?.addEventListener('click', async () => { try { await restoreFlow(JSON.parse(legacy)); } catch (err) { fail(err); } });
}

async function restoreFlow(data) {
  const p = await post('/api/restore/preview', { data });
  if (!p.ok) return modal({ title: '校验未通过（未写入任何数据）', body: `<div class="notice red">${p.errors.map(esc).join('<br>')}</div>` });
  await modal({ title: p.format === 'legacy_v2_local' ? '迁移旧版本地数据' : '恢复个人备份', body: `<dl class="kv">${Object.entries(p.counts).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl><p class="small">已存在的记录：${p.conflicts} 条（${esc(p.conflict_policy)}）</p><label class="inline" style="margin-top:8px"><input type="checkbox" id="own"> 我确认将这些历史数据归属到当前账号（${esc(state.me.display_name)}）</label>`,
    buttons: [{ label: '取消', value: null }, { label: '确认导入', cls: 'primary', handler: async (m) => { if (!$('#own', m).checked) { toast('请勾选归属确认', true); return false; } const r = await post('/api/restore', { data, confirm_ownership: true }); toast(`导入 ${r.inserted} 条，跳过 ${r.skipped} 条`); } }] });
}

const helpBtn = document.createElement('button');
helpBtn.className = 'ghost'; helpBtn.innerHTML = '?<span class="lbl"> 指引</span>'; helpBtn.title = '重新查看本页操作指引'; helpBtn.setAttribute('aria-label', '重新查看本页操作指引');
helpBtn.addEventListener('click', () => { resetTours(); route(); });
document.querySelector('.header-tools').prepend(helpBtn);
window.addEventListener('yz:unauth', () => { helpBtn.hidden = true; });

mountAssistant({ isAuthed: () => !!state.me });
route();
