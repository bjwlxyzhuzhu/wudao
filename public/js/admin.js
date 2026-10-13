// Admin console. Every action is authorised server-side (admin-scope session + is_admin).
import { get, post, put, del, download } from './api.js';
import { esc, $, $$, toast, fail, modal, confirmBox, formData, fmtTime } from './ui.js';

const app = document.getElementById('app');
let me = null;
const LEDGER_TYPES = { initial_grant: '初始赠送', admin_grant: '管理员分配', admin_deduct: '管理员扣减', reserve: '任务预占', settle: '成功结算', release: '释放', reversal: '冲正' };

window.addEventListener('yz:unauth', () => { if (location.pathname !== '/admin/login') go('/admin/login'); });
function go(path) { history.pushState(null, '', path); route(); }
window.addEventListener('popstate', route);
document.addEventListener('click', (e) => { const a = e.target.closest('.admin-nav a'); if (a && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); } });
$('#logout').addEventListener('click', async () => { await post('/api/admin/auth/logout'); me = null; go('/admin/login'); });

async function route() {
  const p = location.pathname;
  if (p === '/admin/login') return login();
  if (!me) { try { me = (await get('/api/admin/me')).user; } catch { return go('/admin/login'); } }
  $('#header').hidden = false; $('#shell').hidden = false; $('#login-root').innerHTML = '';
  $('#who').textContent = `${me.display_name}（${me.login}）`;
  if (me.must_change_password) return changePw();
  const tab = p.split('/')[2] || 'overview';
  $$('.admin-nav a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  app.innerHTML = '';
  try { await ({ overview, teachers, credits, models, templates, runs, settings }[tab] || overview)(); } catch (e) { app.innerHTML = `<div class="notice red">${esc(e.message)}</div>`; }
}

function login() {
  $('#header').hidden = true; $('#shell').hidden = true;
  $('#login-root').innerHTML = `<div class="login-wrap" style="position:relative;z-index:1"><form class="panel login-card" id="lf"><div class="fs-switch" role="group" aria-label="字号"><button type="button" data-fs-set="m" title="标准字号">A</button><button type="button" data-fs-set="l" title="较大字号">A</button><button type="button" data-fs-set="xl" title="特大字号">A</button></div><div class="theme-switch" role="group" aria-label="显示模式"><button type="button" data-theme-set="auto" title="自动：跟随系统">◐</button><button type="button" data-theme-set="light" title="浅色">☀</button><button type="button" data-theme-set="dark" title="深色">☾</button></div><div class="login-logo"><img src="/img/logo-full.png" alt="研思智境 · Research · Reflection · Simulation · Improvement · Multi-Agent Teaching Research Intelligence"></div><h1 class="login-title">管理员登录</h1><div class="small muted login-sub">研思智境平台后台 · 与教师入口分开的会话</div>
    <div style="display:grid;gap:12px"><label>登录名<input name="login" autocomplete="username"></label><label>密码<input name="password" type="password" autocomplete="current-password"></label><button class="primary">登录</button><a class="small" href="/login">← 教师入口</a>
    <p class="small faint">首个管理员账号通过受保护的部署初始化命令创建（npm run init-admin），系统不内置默认密码。</p></div></form></div>`;
  $('#lf').addEventListener('submit', async (e) => { e.preventDefault(); try { me = (await post('/api/admin/auth/login', formData(e.target))).user; go('/admin'); } catch (err) { fail(err); } });
}
async function changePw() {
  app.innerHTML = `<form class="panel" id="pw" style="max-width:460px"><h2>请先修改初始密码</h2><div style="display:grid;gap:10px"><label>原密码<input type="password" name="old_password"></label><label>新密码<input type="password" name="new_password"></label><button class="primary">修改</button></div></form>`;
  $('#pw').addEventListener('submit', async (e) => { e.preventDefault(); try { await post('/api/admin/auth/password', formData(e.target)); me = null; toast('已修改'); route(); } catch (err) { fail(err); } });
}

// ---------- 概览 ----------
async function overview() {
  const o = await get('/api/admin/overview');
  app.innerHTML = `<div class="toolbar"><h1>概览</h1></div><div class="kpis">
    <div class="kpi"><b>${o.teachers}</b><span>教师账号（启用 ${o.active_teachers}）</span></div><div class="kpi"><b>${o.runs}</b><span>运行总数（进行中 ${o.running}）</span></div>
    <div class="kpi"><b>${o.credits_granted}</b><span>累计分配积分（含初始赠送）</span></div><div class="kpi"><b>${o.credits_consumed}</b><span>累计消耗积分（成功调用结算）</span></div>
    <div class="kpi"><b>${o.credits_reserved}</b><span>当前冻结（未结算预占）</span></div><div class="kpi"><b>${o.credits_deducted}</b><span>管理员扣减</span></div>
    <div class="kpi"><b>${o.model_calls.total}</b><span>模型调用（成功 ${o.model_calls.succeeded} / 失败 ${o.model_calls.failed}）</span></div>
    <div class="kpi"><b>${o.model_calls.success_rate == null ? '—' : `${o.model_calls.success_rate}%`}</b><span>模型成功率</span></div></div>
    <div class="grid2"><div class="panel"><h2>模型状态</h2><p>${o.model_status.code === 'ok' ? '<span class="badge green">默认模型可用</span>' : `<span class="badge warn">${esc(o.model_status.message)}</span>`}</p><p class="small muted">费用信息：${esc(o.cost_info)}</p></div>
    <div class="panel"><h2>密钥保护</h2><p class="small">主密钥来源：<b>${o.master_key_source === 'env' ? '环境变量 YANZHI_MASTER_KEY' : '服务端数据目录 master.key（开发模式）'}</b></p>${o.master_key_source === 'env' ? '' : '<div class="notice small">正式部署请设置环境变量 YANZHI_MASTER_KEY 并妥善保管，不要提交到代码库。</div>'}</div></div>`;
}

// ---------- 教师管理 ----------
async function teachers() {
  const q = new URLSearchParams(location.search).get('q') || '';
  const r = await get(`/api/admin/users?q=${encodeURIComponent(q)}`);
  app.innerHTML = `<div class="toolbar"><h1>教师管理</h1><input id="q" placeholder="搜索登录名/显示名/假名" value="${esc(q)}" style="width:240px"><button id="search">搜索</button><span class="grow"></span><button class="primary" id="add">创建/邀请教师</button></div>
    <div class="panel scroll-x"><table class="data"><thead><tr><th>登录名</th><th>显示名</th><th>身份</th><th>状态</th><th>总/冻结/可用</th><th>最近登录</th><th>创建</th><th>操作</th></tr></thead><tbody>
    ${r.users.map((u) => `<tr><td>${esc(u.login)}</td><td>${esc(u.display_name)}</td><td>${u.is_teacher ? '<span class="badge">教师</span>' : ''} ${u.is_admin ? '<span class="badge red">管理员</span>' : ''}</td>
      <td>${u.status === 'active' ? '<span class="badge green">启用</span>' : '<span class="badge warn">停用</span>'}${u.must_change_password ? ' <span class="badge">待改密</span>' : ''}</td>
      <td>${u.total_balance} / ${u.reserved_balance} / <b>${u.available}</b></td><td class="small">${fmtTime(u.last_login_at)}</td><td class="small">${fmtTime(u.created_at)}</td>
      <td><div class="row"><button class="small" data-ledger="${u.user_id}">流水</button><button class="small" data-status="${u.user_id}:${u.status === 'active' ? 'disabled' : 'active'}">${u.status === 'active' ? '停用' : '启用'}</button>
        <button class="small" data-role="${u.user_id}:${u.is_teacher ? 1 : 0}:${u.is_admin ? 1 : 0}">身份</button><button class="small" data-reset="${u.user_id}">重置密码</button></div></td></tr>`).join('')}</tbody></table></div>`;
  $('#search').addEventListener('click', () => go(`/admin/teachers?q=${encodeURIComponent($('#q').value)}`));
  $('#add').addEventListener('click', async () => {
    const res = await modal({ title: '创建/邀请教师账号', body: `<div style="display:grid;gap:10px"><label>登录名<input id="nl"></label><label>显示名<input id="nd"></label>
      <label class="inline"><input type="checkbox" id="nt" checked> 教师身份（获得一次性初始积分）</label><label class="inline"><input type="checkbox" id="na"> 管理员身份</label>
      <p class="small muted">系统生成一次性临时密码，教师首次登录须修改。</p></div>`,
      buttons: [{ label: '取消', value: null }, { label: '创建', cls: 'primary', handler: async () => post('/api/admin/users', { login: $('#nl').value, display_name: $('#nd').value, is_teacher: $('#nt').checked, is_admin: $('#na').checked }) }] });
    if (res) { await modal({ title: '账号已创建', body: `<p>登录名：<b>${esc(res.user.login)}</b></p><p>一次性临时密码：<b class="mono" style="font-size:calc(16px * var(--fs))">${esc(res.temporary_password)}</b></p><p class="small muted">请通过安全渠道告知教师；此密码不会再次显示。初始积分：${res.balance.total}</p>` }); teachers(); }
  });
  $$('[data-status]').forEach((b) => b.addEventListener('click', async () => {
    const [id, st] = b.dataset.status.split(':');
    if (!(await confirmBox(st === 'disabled' ? '停用账号' : '启用账号', st === 'disabled' ? '<p>停用后阻止新登录与新模型请求；进行中的运行将被停止并释放未用预占（已完成调用照常结算），历史数据保留。</p>' : '<p>恢复该账号登录。</p>'))) return;
    try { await post(`/api/admin/users/${id}/status`, { status: st }); toast('已更新'); teachers(); } catch (e) { fail(e); }
  }));
  $$('[data-role]').forEach((b) => b.addEventListener('click', async () => {
    const [id, t, a] = b.dataset.role.split(':');
    const ok = await modal({ title: '调整身份', body: `<label class="inline"><input type="checkbox" id="rt" ${t === '1' ? 'checked' : ''}> 教师</label><br><label class="inline"><input type="checkbox" id="ra" ${a === '1' ? 'checked' : ''}> 管理员</label><p class="small muted">首次授予教师身份时一次性发放初始积分（不会重复发放）。调整后该用户需重新登录。</p>`,
      buttons: [{ label: '取消', value: null }, { label: '保存', cls: 'primary', handler: async () => post(`/api/admin/users/${id}/roles`, { is_teacher: $('#rt').checked, is_admin: $('#ra').checked }) }] });
    if (ok) teachers();
  }));
  $$('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmBox('重置密码', '<p>将生成一次性临时密码并注销该用户所有会话。</p>'))) return;
    try { const r2 = await post(`/api/admin/users/${b.dataset.reset}/reset-password`); await modal({ title: '临时密码', body: `<p class="mono" style="font-size:calc(16px * var(--fs))">${esc(r2.temporary_password)}</p><p class="small muted">仅显示一次。</p>` }); } catch (e) { fail(e); }
  }));
  $$('[data-ledger]').forEach((b) => b.addEventListener('click', () => showLedger(b.dataset.ledger)));
}

async function showLedger(uid) {
  const r = await get(`/api/admin/users/${uid}/ledger`);
  await modal({ title: '积分流水', wide: true, body: `<div class="row"><span class="badge gold">总 ${r.balance.total}</span><span class="badge warn">冻结 ${r.balance.reserved}</span><span class="badge cyan">可用 ${r.balance.available}</span>${r.reconcile.ok ? '<span class="badge green">账本对账一致</span>' : '<span class="badge red">账本不一致</span>'}</div>
    <div class="scroll-x" style="max-height:55vh;margin-top:10px"><table class="data"><thead><tr><th>时间</th><th>类型</th><th>金额</th><th>冻结</th><th>之后</th><th>原因</th><th>批次/运行</th><th></th></tr></thead><tbody>
    ${r.ledger.map((l) => `<tr><td class="small">${fmtTime(l.created_at)}</td><td>${LEDGER_TYPES[l.type] || l.type}</td><td>${l.amount}</td><td>${l.reserved_delta}</td><td>${l.total_after}/${l.reserved_after}</td><td class="small">${esc(l.reason || '')}</td><td class="mono">${esc(l.batch_id || l.run_id || '')}</td><td>${['settle', 'admin_grant', 'admin_deduct'].includes(l.type) ? `<button class="small ghost" data-rev="${l.entry_id}">冲正</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`,
    onMount: (m) => $$('[data-rev]', m).forEach((b) => b.addEventListener('click', async () => {
      const reason = prompt('冲正原因（必填）'); if (!reason) return;
      try { await post(`/api/admin/ledger/${b.dataset.rev}/reverse`, { reason }); toast('已冲正'); m.remove(); } catch (e) { fail(e); }
    })) });
}

// ---------- 积分管理 ----------
async function credits() {
  const r = await get('/api/admin/users');
  const list = r.users.filter((u) => u.is_teacher);
  app.innerHTML = `<div class="toolbar"><h1>积分管理</h1><span class="small muted">单人或批量分配/扣减；必须填写原因，预览对象与金额后确认提交。扣减不能侵犯冻结余额或使可用余额为负。</span></div>
    <div class="editor"><div class="panel scroll-x"><table class="data"><thead><tr><th><input type="checkbox" id="all" aria-label="全选"></th><th>教师</th><th>总/冻结/可用</th><th>调整数量（正=分配，负=扣减）</th></tr></thead><tbody>
      ${list.map((u) => `<tr><td><input type="checkbox" data-u="${u.user_id}"></td><td>${esc(u.display_name)} <span class="faint small">${esc(u.login)}</span></td><td>${u.total_balance}/${u.reserved_balance}/<b>${u.available}</b></td><td><input type="number" data-amt="${u.user_id}" style="width:120px" placeholder="同批量值"></td></tr>`).join('')}</tbody></table></div>
    <aside class="side"><div class="panel"><div style="display:grid;gap:10px"><label>批量值（未单独填写的已选教师）<input type="number" id="bulk" value="20"></label><label>调整原因（必填）<input id="reason" placeholder="如：课题组第二阶段配额"></label><button class="primary" id="pv">预览</button></div></div></aside></div>`;
  $('#all').addEventListener('change', (e) => $$('[data-u]').forEach((c) => { c.checked = e.target.checked; }));
  $('#pv').addEventListener('click', async () => {
    const items = $$('[data-u]').filter((c) => c.checked).map((c) => ({ user_id: c.dataset.u, amount: Number($(`[data-amt="${c.dataset.u}"]`).value || $('#bulk').value) }));
    const reason = $('#reason').value;
    try {
      const pv = (await post('/api/admin/credits/preview', { items, reason })).preview;
      const batch_id = `batch_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      const ok = await modal({ title: '确认积分调整', wide: true, body: `<p>原因：<b>${esc(reason)}</b> · 共 ${pv.length} 人 · 合计 ${pv.reduce((s, p) => s + p.amount, 0)}</p><table class="data"><tr><th>教师</th><th>调整</th><th>调整前 总/冻结/可用</th><th>调整后</th></tr>${pv.map((p) => `<tr><td>${esc(p.display_name)}</td><td>${p.amount > 0 ? '+' : ''}${p.amount}</td><td>${p.before.total}/${p.before.reserved}/${p.before.available}</td><td>${p.ok ? `${p.after.total}/${p.after.reserved}/${p.after.available}` : `<span style="color:var(--danger)">${esc(p.problem)}</span>`}</td></tr>`).join('')}</table>${pv.every((p) => p.ok) ? '' : '<div class="notice red">存在不可执行的扣减，整批不会提交。</div>'}<p class="small faint">批次号 ${batch_id}（网络重试不会重复发放）</p>`,
        buttons: [{ label: '取消', value: false }, { label: '确认提交', value: true, cls: 'primary' }] });
      if (!ok) return;
      const res = await post('/api/admin/credits/commit', { batch_id, items, reason });
      toast(res.replayed ? '该批次已提交过（未重复发放）' : `已提交 ${res.entries.length} 笔`); credits();
    } catch (e) { fail(e); }
  });
}

// ---------- 模型与 API Key ----------
async function models() {
  const r = await get('/api/admin/models');
  app.innerHTML = `<div class="toolbar"><h1>模型与 API Key</h1><span class="grow"></span><button class="primary" id="add">新增模型配置</button></div>
    <div class="notice small" style="margin-bottom:12px">API Key 仅服务端加密保存；页面、接口、日志、导出只显示“已配置/尾号”。连接测试会向供应商发出真实请求，可能产生真实 API 费用（不计入教师积分）。</div>
    <div class="panel scroll-x"><table class="data"><thead><tr><th>名称</th><th>接口</th><th>服务地址</th><th>模型ID</th><th>密钥</th><th>费率/并发/超时/max_tokens</th><th>状态</th><th>操作</th></tr></thead><tbody>
    ${r.models.map((m) => `<tr><td>${esc(m.name)}${m.is_default ? ' <span class="badge gold">默认</span>' : ''}</td><td class="small">${esc(r.kinds[m.kind])}</td><td class="mono">${esc(m.base_url)}</td><td class="mono">${esc(m.model_id)}</td>
      <td>${m.key_configured ? `<span class="badge green">已配置 · 尾号 ${esc(m.key_last4)}</span> <span class="faint small">v${m.key_version}</span>` : '<span class="badge warn">未配置</span>'}</td>
      <td class="small">${m.credit_rate} 积分/次 · ${m.concurrency} · ${m.timeout_ms / 1000}s · ${m.max_tokens}</td><td>${m.enabled ? '<span class="badge green">启用</span>' : '<span class="badge">停用</span>'}</td>
      <td><div class="row"><button class="small" data-edit="${m.provider_id}">编辑</button><button class="small" data-key="${m.provider_id}">${m.key_configured ? '轮换密钥' : '设置密钥'}</button>${m.key_configured ? `<button class="small danger" data-rmkey="${m.provider_id}">移除密钥</button>` : ''}${m.key_configured ? `<button class="small" data-remote="${m.provider_id}">获取可用模型</button>` : ''}<button class="small" data-test="${m.provider_id}">连接测试</button></div></td></tr>`).join('') || '<tr><td colspan="8" class="faint">尚未配置模型。真实模型模式将不可用（教师仍可使用本地生成）。</td></tr>'}</tbody></table></div>`;
  // New configurations default to DeepSeek V4.1 Flash; its API model ID is `deepseek-flash` (verified via GET /models).
  const DEEPSEEK = { name: 'DeepSeek', kind: 'openai_compatible', base_url: 'https://api.deepseek.com', model_id: 'deepseek-flash', credit_rate: 1, concurrency: 2, timeout_ms: 60000, max_tokens: 1200, is_default: true };
  const form = (m = {}) => `<div class="grid2"><label>名称<input name="name" value="${esc(m.name || '')}"></label><label>接口类型<select name="kind">${Object.entries(r.kinds).map(([k, v]) => `<option value="${k}" ${m.kind === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <label>服务地址 base_url（https）<input name="base_url" value="${esc(m.base_url || '')}" placeholder="https://api.example.com/v1"></label><label>模型ID<input name="model_id" value="${esc(m.model_id || '')}"></label>
    <label>教师积分费率（每次成功调用）<input name="credit_rate" type="number" min="1" max="100" value="${m.credit_rate ?? 1}"></label><label>并发上限<input name="concurrency" type="number" min="1" max="20" value="${m.concurrency ?? 2}"></label>
    <label>超时（毫秒）<input name="timeout_ms" type="number" value="${m.timeout_ms ?? 60000}"></label><label>最大 token<input name="max_tokens" type="number" value="${m.max_tokens ?? 1200}"></label>
    <label>提供方费用信息（可选，仅备注）<input name="cost_info" value="${esc(m.cost_info || '')}"></label>${m.provider_id ? '' : '<label>API Key（仅提交，不回显）<input name="api_key" type="password" autocomplete="off"></label>'}
    <label class="inline"><input type="checkbox" name="enabled" ${m.enabled === false ? '' : 'checked'}> 启用</label><label class="inline"><input type="checkbox" name="is_default" ${m.is_default ? 'checked' : ''}> 设为默认路由</label></div>
    <p class="small faint">修改费率只对新任务生效（系统递增费率版本，运行快照保存当时费率）。</p>`;
  const edit = async (m) => {
    const ok = await modal({ title: m ? '编辑模型配置' : '新增模型配置', wide: true, body: `${m ? '' : '<div class="notice small" style="margin-bottom:10px">默认预填 DeepSeek（OpenAI 兼容接口）：服务地址 https://api.deepseek.com，模型 ID <b>deepseek-flash</b>（即 DeepSeek-V4.1-Flash）。填入 API Key 保存后，可点“获取可用模型”核对模型 ID，再点“连接测试”。</div>'}<form id="mf">${form(m || DEEPSEEK)}</form>`,
      buttons: [{ label: '取消', value: null }, { label: '保存', cls: 'primary', handler: async (el) => { const f = formData($('#mf', el)); if (m?.provider_id) f.provider_id = m.provider_id; if (!f.api_key) delete f.api_key; return post('/api/admin/models', f); } }] });
    if (ok) { toast('已保存'); models(); }
  };
  $('#add').addEventListener('click', () => edit(null));
  $$('[data-edit]').forEach((b) => b.addEventListener('click', () => edit(r.models.find((m) => m.provider_id === b.dataset.edit))));
  $$('[data-key]').forEach((b) => b.addEventListener('click', async () => {
    const ok = await modal({ title: '设置/轮换 API Key', body: '<label>新 API Key<input id="k" type="password" autocomplete="off"></label><p class="small muted">保存后旧密钥不可再取回；运行中的任务之后的请求使用新版本，历史调用记录保留密钥版本号但不保存密钥。</p>',
      buttons: [{ label: '取消', value: null }, { label: '保存', cls: 'primary', handler: async () => post(`/api/admin/models/${b.dataset.key}/key`, { api_key: $('#k').value }) }] });
    if (ok) { toast('密钥已保存'); models(); }
  }));
  $$('[data-rmkey]').forEach((b) => b.addEventListener('click', async () => { if (await confirmBox('移除密钥', '<p>移除后该模型不可用于真实调用。</p>', '移除', 'danger')) { await del(`/api/admin/models/${b.dataset.rmkey}/key`); models(); } }));
  $$('[data-remote]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const t = await get(`/api/admin/models/${b.dataset.remote}/remote`);
      if (!t.ok) { await modal({ title: '获取失败', body: `<p>${esc(`${t.code}：${t.message}`)}</p>` }); return; }
      const cfg = r.models.find((x) => x.provider_id === b.dataset.remote);
      const pick = await modal({ title: '供应商可用模型', body: `<p class="small muted">当前配置的模型 ID：<b class="mono">${esc(t.current)}</b>${t.models.some((x) => x.id === t.current) ? ' <span class="badge green">可用</span>' : ' <span class="badge red">不在列表中，调用会失败</span>'}</p>
        <div class="grid2">${t.models.map((x) => `<label class="inline"><input type="radio" name="rm" value="${esc(x.id)}" ${x.id === t.current ? 'checked' : ''}> <b class="mono">${esc(x.id)}</b>${x.name ? ` <span class="faint small">${esc(x.name)}</span>` : ''}</label>`).join('') || '<p class="faint">供应商未返回模型列表。</p>'}</div>`,
        buttons: [{ label: '关闭', value: null }, { label: '改用所选模型', cls: 'primary', handler: async (el) => { const v = $('input[name=rm]:checked', el)?.value; if (!v) return null; return post('/api/admin/models', { ...cfg, provider_id: cfg.provider_id, model_id: v }); } }] });
      if (pick) { toast('模型 ID 已更新'); models(); }
    } catch (e) { fail(e); } finally { b.disabled = false; }
  }));
  $$('[data-test]').forEach((b) => b.addEventListener('click', async () => {
    if (!(await confirmBox('连接测试', '<p>将向模型供应商发送一次最小请求（ping），<b>可能产生真实 API 费用</b>，不计入教师积分，操作会记入审计。</p>', '发送测试'))) return;
    b.disabled = true;
    try { const t = await post(`/api/admin/models/${b.dataset.test}/test`); await modal({ title: t.ok ? '连接成功' : '连接失败', body: `<dl class="kv"><dt>结果</dt><dd>${t.ok ? '成功' : esc(`${t.code}：${t.message}`)}</dd><dt>耗时</dt><dd>${t.latency_ms} ms</dd>${t.request_id ? `<dt>请求ID</dt><dd class="mono">${esc(t.request_id)}</dd>` : ''}${t.model_reported ? `<dt>返回模型</dt><dd>${esc(t.model_reported)}</dd>` : ''}</dl>` }); } catch (e) { fail(e); } finally { b.disabled = false; }
  }));
}

// ---------- 模板管理 ----------
async function templates() {
  const r = await get('/api/admin/templates');
  const KIND = { framework: '教学设计框架', artifact: '课程思政产物模板', rubric: '量规模板' };
  app.innerHTML = `<div class="toolbar"><h1>模板管理</h1><span class="small muted">发布新版本不影响已有产物（产物记录模板版本号）；至少保留一个已发布版本。</span></div>
    ${Object.entries(KIND).map(([k, label]) => `<div class="panel" style="margin-bottom:12px"><h2>${label}</h2><table class="data"><thead><tr><th>key</th><th>名称</th><th>版本</th><th>状态</th><th>创建</th><th>操作</th></tr></thead><tbody>
      ${r.templates.filter((t) => t.kind === k).map((t) => `<tr><td class="mono">${esc(t.key)}</td><td>${esc(t.name)}</td><td>v${t.version}</td><td>${t.status === 'published' ? '<span class="badge green">已发布</span>' : '<span class="badge">已停用</span>'}</td><td class="small">${fmtTime(t.created_at)}</td>
        <td><div class="row"><button class="small" data-view="${t.template_version_id}">查看/发布新版本</button><button class="small" data-st="${t.template_version_id}:${t.status === 'published' ? 'retired' : 'published'}">${t.status === 'published' ? '停用' : '发布'}</button></div></td></tr>`).join('')}</tbody></table></div>`).join('')}`;
  $$('[data-view]').forEach((b) => b.addEventListener('click', async () => {
    const t = r.templates.find((x) => x.template_version_id === b.dataset.view);
    const ok = await modal({ title: `${t.name} · v${t.version}`, wide: true, body: `<label>名称<input id="tn" value="${esc(t.name)}"></label><label style="margin-top:8px">模板 JSON<textarea id="tj" rows="18" class="mono">${esc(JSON.stringify(t.body, null, 2))}</textarea></label>`,
      buttons: [{ label: '关闭', value: null }, { label: '发布为新版本', cls: 'primary', handler: async () => post('/api/admin/templates', { kind: t.kind, key: t.key, name: $('#tn').value, body: JSON.parse($('#tj').value) }) }] });
    if (ok) { toast(`已发布 v${ok.version}`); templates(); }
  }));
  $$('[data-st]').forEach((b) => b.addEventListener('click', async () => { const [id, st] = b.dataset.st.split(':'); try { await post(`/api/admin/templates/${id}/status`, { status: st }); templates(); } catch (e) { fail(e); } }));
}

// ---------- 运行与审计 ----------
async function runs() {
  const [r, a] = await Promise.all([get('/api/admin/runs'), get('/api/admin/audit')]);
  app.innerHTML = `<div class="toolbar"><h1>运行与审计</h1><span class="small muted">仅显示任务状态、失败原因、请求ID与操作记录，不显示教学原文。</span><span class="grow"></span><button id="rec">执行对账</button><button id="fin">导出财务与模型使用（管理员）</button></div>
    <div class="panel" style="margin-bottom:12px"><h2>未结算预占（${r.reservations.length}）</h2><table class="data"><tr><th>教师假名</th><th>运行</th><th>预占</th><th>已用</th><th>在途</th><th>状态</th><th>创建</th></tr>${r.reservations.map((v) => `<tr><td>${esc(v.owner)}</td><td class="mono">${esc(v.run_id)}</td><td>${v.amount}</td><td>${v.used}</td><td>${v.inflight}</td><td>${esc(v.status)}</td><td class="small">${fmtTime(v.created_at)}</td></tr>`).join('') || '<tr><td colspan="7" class="faint">无</td></tr>'}</table></div>
    <div class="panel scroll-x" style="margin-bottom:12px"><h2>运行</h2><table class="data"><tr><th>运行</th><th>教师</th><th>模块</th><th>方式</th><th>状态</th><th>原因</th><th>调用/预算</th><th>创建</th><th></th></tr>${r.runs.map((x) => `<tr><td class="mono">${esc(x.run_id)}</td><td>${esc(x.owner)}</td><td>${x.module === 'seminar' ? '研课场' : '演课场'}</td><td>${esc(x.exec_mode)}</td><td>${esc(x.status)}</td><td class="small">${esc(x.stop_reason || '')}</td><td>${x.model_calls}/${x.budget_calls}</td><td class="small">${fmtTime(x.created_at)}</td><td>${['running', 'paused', 'awaiting_human', 'ready'].includes(x.status) ? `<button class="small danger" data-stop="${x.run_id}">停止</button>` : ''}</td></tr>`).join('')}</table></div>
    <div class="panel scroll-x" style="margin-bottom:12px"><h2>模型调用</h2><table class="data"><tr><th>时间</th><th>教师</th><th>模型</th><th>密钥版本</th><th>用途</th><th>状态</th><th>错误</th><th>请求ID</th><th>耗时</th><th>token 入/出</th><th>积分</th></tr>${r.calls.map((c) => `<tr><td class="small">${fmtTime(c.request_at)}</td><td>${esc(c.owner)}</td><td class="mono">${esc(c.model_id || '')}</td><td>${c.key_version ?? ''}</td><td class="small">${esc(c.purpose || '')}</td><td>${esc(c.status)}</td><td class="small">${esc(c.error_code || '')}</td><td class="mono">${esc(c.request_id || '')}</td><td>${c.latency_ms ?? ''}</td><td>${c.input_tokens ?? '—'}/${c.output_tokens ?? '—'}</td><td>${c.credits}</td></tr>`).join('') || '<tr><td colspan="11" class="faint">暂无</td></tr>'}</table></div>
    <div class="panel scroll-x"><h2>审计日志</h2><table class="data"><tr><th>时间</th><th>操作者</th><th>角色</th><th>操作</th><th>对象</th><th>详情</th><th>IP</th></tr>${a.audit.map((x) => `<tr><td class="small">${fmtTime(x.time)}</td><td>${esc(x.actor_login || '')}</td><td>${esc(x.actor_role || '')}</td><td>${esc(x.action)}</td><td class="mono">${esc(x.target_type || '')} ${esc(x.target_id || '')}</td><td class="mono">${esc(x.detail || '')}</td><td class="small">${esc(x.ip || '')}</td></tr>`).join('')}</table></div>`;
  $('#rec').addEventListener('click', async () => { const x = await post('/api/admin/reconcile'); toast(`对账完成：失败调用 ${x.failed_calls}，释放 ${x.released}，长时间未活动 ${x.stale_paused}`); runs(); });
  $('#fin').addEventListener('click', () => download('/api/admin/export/finance'));
  $$('[data-stop]').forEach((b) => b.addEventListener('click', async () => { if (await confirmBox('停止运行', '<p>停止后释放未用预占；已完成调用照常结算。</p>', '停止', 'danger')) { await post(`/api/admin/runs/${b.dataset.stop}/stop`); runs(); } }));
}

// ---------- 系统设置 ----------
async function settings() {
  const s = await get('/api/admin/settings');
  app.innerHTML = `<div class="toolbar"><h1>系统设置</h1></div><form class="panel" id="sf" style="max-width:720px"><div class="grid2">
    <label>新教师账号赠送积分（只影响之后新建的教师）<input type="number" name="signup_bonus" value="${s.signup_bonus}"></label>
    <label>单任务最大调用次数<input type="number" name="max_calls_per_task" value="${s.max_calls_per_task}"></label>
    <label>未活动运行释放预占（分钟）<input type="number" name="stale_run_minutes" value="${s.stale_run_minutes}"></label>
    <label>会话空闲过期（分钟）<input type="number" name="session_idle_minutes" value="${s.session_idle_minutes}"></label>
    <label class="inline"><input type="checkbox" name="self_register" ${s.self_register ? 'checked' : ''}> 开放教师自助注册（默认关闭）</label>
    <label class="inline"><input type="checkbox" name="assistant_model" ${s.assistant_model ? 'checked' : ''}> 数字客服思思使用平台共享的大模型（不扣教师积分；关闭后只用本地知识库回答）</label>
    <label>思思每位教师每小时的大模型问答上限（次）<input type="number" name="assistant_hourly_limit" min="0" max="1000" value="${s.assistant_hourly_limit}"></label></div>
    <p class="small faint">当前费率版本：v${s.pricing_version}。本期不包含每日/每月自动赠送，也不接支付。</p><button class="primary">保存</button></form>`;
  $('#sf').addEventListener('submit', async (e) => { e.preventDefault(); const f = formData(e.target); f.self_register = f.self_register ? 1 : 0; f.assistant_model = f.assistant_model ? 1 : 0; try { await put('/api/admin/settings', f); toast('已保存'); } catch (err) { fail(err); } });
}

route();
