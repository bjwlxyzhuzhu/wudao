import { extractPose, drawSkeleton } from './pose.js';
import { computeMetrics, METRIC_VERSION } from './metrics.js';

const root = document.querySelector('#app');
const isRisk = location.pathname.startsWith('/wuan');
const state = { user: null, catalog: null, sessions: [], health: null, tab: isRisk ? 'health' : 'home', action: 'demi-plie', file: null, videoUrl: null, pose: null, referenceFile: null, referencePose: null, referenceMetrics: null, referenceKeyframes: [], referenceBusy: false, trainingId: null, report: null, busy: false, controller: null, poll: null };
const labels = { POSE_PENDING: '待提取姿态', METRICS_READY: '指标已完成', AI_PROCESSING: '分析中', WAITING_REVIEW: '待教师复核', PUBLISHED: '老师已确认', NEEDS_RECAPTURE: '需要重拍', WITHDRAWN: '已撤回' };
const escape = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const roleName = (role) => ({ student: '学生空间', teacher: '舞蹈教师', medic: '风险复核教师' }[role] || '未登录');
const day = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10);
const formatTime = (value) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const actionFallback = [
  { key: 'first-position', title: '一位站姿', tag: '静态基准 · 身体轴线', view: 'front' },
  { key: 'second-position', title: '二位站姿', tag: '静态基准 · 对称控制', view: 'front' },
  { key: 'demi-plie', title: '蹲', tag: '核心慢速基训 · 下肢控制', view: 'front' },
  { key: 'tendu', title: '擦地', tag: '核心慢速基训 · 腿部延伸', view: 'front' },
  { key: 'passe', title: '单腿蹲', tag: '单腿承重 · 平衡控制', view: 'front' },
  { key: 'degage', title: '控制', tag: '单腿承重 · 动态控制', view: 'side' },
];
const actions = () => state.catalog?.actions || actionFallback;
const action = () => actions().find((item) => item.key === state.action) || actions()[0];

async function api(method, path, body) {
  const response = await fetch(`/api/dance${path}`, { method, credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-yz-csrf': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) {
    if (response.status === 401) state.user = null;
    throw new Error(value.error?.message || '请求失败');
  }
  return value;
}

async function uploadVideo(path, file) {
  const response = await fetch(`/api/dance${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': file.type || 'video/mp4', 'x-yz-csrf': '1' }, body: file });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || '视频上传失败');
  return value;
}

async function reanalyzeSavedVideo(report) {
  if (!report.video_url) throw new Error('这条练习没有保存原视频，请重新选择视频');
  state.busy = true;
  state.controller = new AbortController();
  state.trainingId = report.training_id;
  render();
  try {
    const response = await fetch(report.video_url, { credentials: 'same-origin', signal: state.controller.signal });
    if (!response.ok) throw new Error('已保存的视频暂时无法读取，请重新选择视频');
    const blob = await response.blob();
    const type = blob.type || 'video/mp4';
    const extension = ({ 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' })[type] || 'mp4';
    const file = new File([blob], `dance-retry.${extension}`, { type });
    if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
    state.file = file;
    state.videoUrl = URL.createObjectURL(file);
    const extracted = await extractPose(file, {
      view: report.standard.view,
      captureKeyframes: !!(report.consent_cloud && state.catalog?.vision_configured),
      keyframeLimit: 6,
      signal: state.controller.signal,
      onProgress: ({ percent, message }) => {
        const label = document.querySelector('#saved-retry-message');
        const progress = document.querySelector('#saved-retry-progress');
        if (label) label.textContent = message;
        if (progress) progress.value = percent;
      },
    });
    state.pose = extracted.pose;
    state.report = await api('POST', `/sessions/${report.training_id}/pose`, extracted.pose);
    if (state.report.status !== 'METRICS_READY') {
      throw new Error(state.report.metrics?.flags?.join('；') || '本次姿态质量仍不足，请检查视频画面');
    }
    state.report = await api('POST', `/sessions/${report.training_id}/analyze`, { keyframes: extracted.keyframes });
  } finally {
    state.busy = false;
    render();
  }
}

let toastTimer;
function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message; element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 5500);
}

function dancer(variant = 0) {
  const legs = variant === 1 ? 'M192 179 Q183 223 167 277 M192 179 Q222 177 243 198 L211 213' : variant === 2 ? 'M192 179 Q180 227 169 277 M192 179 Q235 164 272 133' : 'M192 179 Q161 204 135 218 L151 277 M192 179 Q223 204 245 216 L227 277';
  return `<svg viewBox="0 0 370 320" fill="none" aria-hidden="true"><ellipse cx="189" cy="285" rx="117" ry="14" fill="#c9eaa1" opacity=".06"/><path d="M50 247Q20 115 165 42Q322-15 329 169" stroke="#c1d6a1" opacity=".12"/><path d="M55 266Q284 328 320 84" stroke="#c1d6a1" opacity=".2" stroke-dasharray="3 8"/><path d="M185 106Q158 127 132 119L83 77M201 105Q225 125 250 105L289 59" stroke="#acc991" stroke-width="16" stroke-linecap="round" opacity=".22"/><path d="M190 106 Q184 136 192 179" stroke="#bace9c" stroke-width="29" stroke-linecap="round" opacity=".20"/><path d="${legs}" stroke="#afc697" stroke-width="18" stroke-linecap="round" stroke-linejoin="round" opacity=".24"/><ellipse cx="194" cy="78" rx="15" ry="20" fill="#bdcda1" opacity=".30"/><path d="M187 103L169 118L130 118L84 77 M201 103L220 122L251 105L289 59 M169 118L178 174L207 174L220 122 M178 174L192 179L207 174 ${legs}" stroke="#c5ef8e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><g fill="#e1ffc0">${[[169,118],[130,118],[84,77],[220,122],[251,105],[289,59],[178,174],[207,174],[192,179]].map(([horizontal,vertical]) => `<circle cx="${horizontal}" cy="${vertical}" r="3.2"/>`).join('')}</g><path d="M193 43v17M180 49l5 12" stroke="#e5e9cb" stroke-width="2" opacity=".5"/><path d="M61 284h266" stroke="#bbd298" opacity=".25"/></svg>`;
}

const statusTone = { WAITING_REVIEW: 'wait', AI_PROCESSING: 'wait', METRICS_READY: 'wait', POSE_PENDING: 'muted', PUBLISHED: 'done', NEEDS_RECAPTURE: 'redo', WITHDRAWN: 'muted' };
const statusTag = (status) => `<span class="tag tone-${statusTone[status] || 'muted'}">${labels[status] || escape(status)}</span>`;
const viewName = (view) => view === 'side' ? '侧面拍摄' : '正面拍摄';
const today = () => new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });

function shell(content) {
  const navigation = isRisk ? [['health','今日状态'],['loads','训练负荷']] : state.user?.role === 'teacher' ? [['home','工作台'],['standards','动作标准'],['review','训练复核'],['history','训练记录']] : [['home','今天练什么'],['practice','开始练习'],['history','成长记录']];
  document.body.classList.toggle('risk-page', isRisk);
  document.title = isRisk ? '舞智正姿 · 舞安智护' : '舞智正姿 · 高校芭蕾基本功自主学习';
  content = content.replaceAll('3–30 秒', '3 秒至 1 分 30 秒').replaceAll('3—30 秒', '3 秒至 1 分 30 秒').replace('20 MB 以内', '100 MB 以内').replace('不超过 20 MB', '不超过 100 MB')
    .replace('本机提取姿态角度，只保存统计数据，不上传或留存原视频。', '本机提取角度；保存统计和最多 3 张遮脸示范帧用于授权 AI 对照，不保存原视频。')
    .replace('向云端模型发送最多 6 张遮挡面部的关键帧。', '勾选后向千问发送最多 6 张遮脸学生关键帧，与老师示范关键帧和角度统计对照。')
    .replace('<span class="step-no">4</span>授权</h2>', '<span class="step-no">4</span>AI 云端分析与授权</h2><p class="cloud-consent-intro">勾选千问分析后，上传完成且骨架检测合格时会自动调用 AI；不勾选则只做本机姿态分析。</p>')
    .replace('勾选后向千问发送最多 6 张遮脸学生关键帧，与老师示范关键帧和角度统计对照。遮挡不能保证完全匿名。', '<b>授权本次调用千问 AI</b>　发送最多 6 张遮脸关键帧，对照老师示范与角度统计。遮脸不保证完全匿名。')
    .replace('当前没有配置视觉模型，这一项不可用，只做本机指标分析。', '千问视觉模型暂未启用，当前不能进行云端分析；请管理员在模型设置中配置千问视觉模型。')
    .replace('勾选千问分析后，上传完成且骨架检测合格时会自动调用 AI；不勾选则只做本机姿态分析。', state.catalog?.vision_configured ? '勾选后，上传完成且骨架检测合格时会自动调用千问；不勾选则只做本机姿态分析。' : '千问视觉模型当前未启用，因此云端分析不可选；请管理员先完成模型配置。');
  if (state.report?.status === 'NEEDS_RECAPTURE' && state.report.video_url && state.report.metrics?.version !== METRIC_VERSION) {
    const oldFlags = (state.report.metrics?.flags || []).map(escape).join('<br>');
    if (oldFlags) content = content.replace(`<div class="notice warning">${oldFlags}</div>`, '');
  } else {
    content = content.replaceAll('检测到多人或镜像，已排除相应帧', '这是旧版检测结果。模型只统计人体候选，没有识别镜子；请重新选择视频按新版规则检测。');
  }
  root.innerHTML = `<div class="app-shell"><aside class="sidebar"><a class="brand" href="${isRisk ? '/wuan' : '/wujing'}"><img src="/dance/mark.svg" alt=""><div><b>舞智正姿</b><small>${isRisk ? '训练健康' : '高校芭蕾基本功学习'}</small></div></a>${state.user ? `<nav class="nav" aria-label="主导航">${navigation.map(([target,label]) => `<button data-tab="${target}" class="${state.tab === target ? 'active' : ''}" ${state.tab === target ? 'aria-current="page"' : ''} ${state.busy ? 'disabled' : ''}>${label}</button>`).join('')}</nav>` : ''}<div class="sidebar-bottom"><a class="product-link" href="${isRisk ? '/wujing' : '/wuan'}">切换到${isRisk ? '舞镜智练' : '舞安智护'}<small>${isRisk ? '技能训练' : '训练健康打卡'}</small></a>${state.user ? `<div class="profile"><div class="avatar" aria-hidden="true">${escape(state.user.name?.slice(0,1) || '舞')}</div><div><b>${escape(state.user.name)}</b><small>${roleName(state.user.role)}</small></div></div><button class="link-button" data-command="logout">退出账号</button>` : ''}</div></aside><main class="main" id="main"><header class="topbar"><span class="date">${today()}</span></header>${content}<footer class="footer-note">${isRisk ? '训练状态记录与健康教育，不能替代医生诊断。' : '姿态指标是教学参考，正式反馈由老师确认。'}</footer></main></div>`;
  if (state.user) {
    const account = document.createElement('button');
    account.className = 'mobile-account link-button';
    account.textContent = '退出账号';
    account.dataset.command = 'logout';
    account.disabled = state.busy;
    document.querySelector('.topbar').append(account);
  }
  wireVideo();
}

function heading(title, description = '') {
  return `<div class="page-heading"><h1>${title}</h1>${description ? `<p>${description}</p>` : ''}</div>`;
}

function sessionRows(sessions, emptyText = '还没有练习记录', emptyHint = '选一个动作，录下第一轮练习。') {
  return sessions.length ? `<div class="rows">${sessions.map((session) => `<button class="session-row" data-session="${session.training_id}"><span class="row-main"><b>${escape(session.standard.title)}</b><small>${escape(session.student_code)}　${formatTime(session.created_at)}　标准 v${session.standard.version}</small></span>${statusTag(session.status)}<span class="row-go">查看</span></button>`).join('')}</div>` : `<div class="empty"><p>${emptyText}</p><small>${emptyHint}</small></div>`;
}

function referenceSummary(metrics) {
  if (!metrics) return '<p class="hint">还没有教师参考数据。添加示范视频后，千问可对照参考角度统计辅助分析。</p>';
  const readings = Object.values(metrics.metrics || {}).filter((metric) => !metric.uncertain && metric.value !== null).map((metric) => `${escape(metric.label)} ${metric.value.toFixed(metric.unit === '°' ? 1 : 3)}${escape(metric.unit)}`);
  return `<p class="reference-result">已提取 ${metrics.valid_frames} 个有效帧 · ${readings.join(' / ') || '无可用角度数据'}</p>`;
}

function checkpointList(standard, fallback) {
  if (!standard) return `<p class="figure-note">${escape(fallback)}</p><p class="pending-note">老师还没有为这个动作发布标准。</p>`;
  return `<ol class="checkpoints">${standard.checkpoints.map((item) => `<li>${escape(item)}</li>`).join('')}</ol>`;
}

function home() {
  const teacher = state.user?.role === 'teacher';
  const current = state.sessions.filter((session) => session.status !== 'WITHDRAWN');
  const waiting = current.filter((session) => session.status === 'WAITING_REVIEW');
  const published = current.filter((session) => session.status === 'PUBLISHED').length;
  if (teacher) {
    const unpublished = actions().filter((item) => !item.standard).length;
    const lead = waiting.length ? `今天有 <b>${waiting.length}</b> 段练习等你复核。` : unpublished ? `还有 <b>${unpublished}</b> 个动作没有发布标准，学生暂时无法练习。` : '目前没有待复核的练习。';
    shell(`<section class="lead"><div><h1>${escape(state.user.name)}，你好</h1><p>${lead}</p></div>${waiting.length ? '<button class="primary" data-tab="review">去复核</button>' : unpublished ? `<button class="primary" data-action="${actions().find((item) => !item.standard).key}">发布标准</button>` : ''}</section>
    <section class="panel library"><div class="panel-head"><h2>动作教学库</h2><small>学生只能练习已发布标准的动作</small></div>${actions().map((item, index) => `<div class="library-row"><div class="library-figure">${dancer(index)}</div><div class="library-text"><h3>${escape(item.title)}</h3><p>${escape(item.description || item.tag)}</p><small>${viewName(item.view)}</small></div><div class="library-state">${item.standard ? `<span class="tag tone-done">已发布 v${item.standard.version}</span><small>${item.standard.checkpoints.length} 个检查点</small>` : '<span class="tag tone-wait">未发布</span><small>学生暂不可练</small>'}</div><button class="${item.standard ? '' : 'primary'}" data-action="${item.key}">${item.standard ? '修改标准' : '发布标准'}</button></div>`).join('')}</section>
    <div class="split"><section class="panel"><div class="panel-head"><h2>最近练习</h2>${current.length > 4 ? '<button class="link-button" data-tab="history">全部记录</button>' : ''}</div>${sessionRows(current.slice(0, 4), '学生还没有提交练习', '发布动作标准后，学生就可以开始录制。')}</section><section class="panel figures"><h2>班级概况</h2><dl class="stats"><div><dt>练习记录</dt><dd>${current.length}</dd></div><div><dt>等你复核</dt><dd>${waiting.length}</dd></div><div><dt>已发布反馈</dt><dd>${published}</dd></div></dl></section></div>`);
    return;
  }
  const chosen = action(), index = actions().indexOf(chosen), standard = chosen.standard;
  shell(`${heading('今天练什么', '选一个动作，先看老师的检查点，再录下这一轮。')}
  <section class="feature"><div class="feature-figure">${dancer(index)}<small>动作示意，不是你的分析结果</small></div><div class="feature-body"><div class="feature-title"><h2>${escape(chosen.title)}</h2>${standard ? `<span class="tag tone-done">老师标准 v${standard.version}</span>` : '<span class="tag tone-wait">等待老师发布</span>'}</div><p class="feature-meta">${escape(chosen.tag)}　${viewName(standard?.view || chosen.view)}</p>${standard ? `<h3>老师的检查点</h3>` : ''}${checkpointList(standard, chosen.description || '')}<div class="feature-actions">${standard ? `<button class="primary" data-action="${chosen.key}">开始这次练习</button>` : ''}</div></div></section>
  <div class="picker" role="group" aria-label="选择动作">${actions().map((item, i) => `<button class="pick ${item.key === chosen.key ? 'active' : ''}" data-pick="${item.key}" aria-pressed="${item.key === chosen.key}"><span class="pick-figure">${dancer(i)}</span><span><b>${escape(item.title)}</b><small>${item.standard ? `标准 v${item.standard.version}` : '未发布'}</small></span></button>`).join('')}</div>
  <section class="panel"><div class="panel-head"><h2>我的练习记录</h2>${current.length ? `<small>${published} 段已有老师反馈</small>` : ''}</div>${sessionRows(current.slice(0, 4))}</section>`);
}

function login() {
  shell(`<section class="login"><div class="login-figure">${dancer(isRisk ? 0 : 2)}</div><div class="login-panel"><h1>${isRisk ? '登录舞安智护' : '登录舞智正姿'}</h1><p>学生、舞蹈教师和风险复核教师使用各自的账号。教师与学生均在本页登录，账号由管理员提供。首次登录请修改临时密码。管理员请进入下方管理后台。</p><p><a href="/admin">管理员后台</a> · 舞镜智练：高校芭蕾基本功自主学习</p><form id="login-form"><label class="field">登录名<input name="login" autocomplete="username" required placeholder="例如 dance_student"></label><label class="field">密码<input name="password" type="password" autocomplete="current-password" required></label><p class="login-error" id="login-error" role="alert"></p><button class="primary wide" type="submit">登录</button></form></div></section>`);
}

function standards() {
  if (state.user?.role !== 'teacher') return home();
  const chosen = action(), standard = chosen.standard;
  const view = standard?.view || chosen.view;
  const currentReference = standard?.view === view ? standard?.reference_metrics : null;
  const reference = state.referenceMetrics || currentReference;
  const referenceStatus = state.referenceBusy ? '正在本机提取…' : state.referencePose ? '新示范数据已就绪，将保存角度统计和遮脸对照帧。' : state.referenceFile ? `${escape(state.referenceFile.name)} · 请先提取` : currentReference ? (standard?.reference_frame_count ? `本版本已保存角度统计和 ${standard.reference_frame_count} 张遮脸对照帧；不选择新视频时，新版本会沿用。` : '本版本只有角度统计。若要让千问直接对照示范画面，请重新选择示范视频并发布新版本。') : standard?.reference_metrics ? '拍摄视角已更改，请上传匹配视角的新示范视频。' : '尚未添加；可稍后补到下一版标准。';
  shell(`${heading(standard ? `修改动作标准：${escape(chosen.title)}` : `发布动作标准：${escape(chosen.title)}`, '发布后固定为一个版本。已经提交的练习继续使用当时的版本。')}<div class="editor"><section class="panel"><form id="standard-form"><label class="field">练习动作<select name="action_key" id="standard-action">${actions().map((item) => `<option value="${item.key}" ${chosen.key===item.key?'selected':''}>${escape(item.title)}${item.standard ? `（已发布 v${item.standard.version}）` : '（未发布）'}</option>`).join('')}</select></label><div class="two-fields"><label class="field">动作名称<input name="title" required maxlength="80" value="${escape(standard?.title || chosen.title)}" data-preview="title"></label><label class="field">拍摄视角<select name="view" data-preview="view"><option value="front" ${view==='front'?'selected':''}>正面</option><option value="side" ${view==='side'?'selected':''}>侧面</option></select></label></div><label class="field">教学要求与安全边界<textarea name="instructions" maxlength="2000" required data-preview="instructions" placeholder="写清完成要求、需要保持的阶段，以及出现什么情况要立即停止">${escape(standard?.instructions || '')}</textarea></label><label class="field">检查点<span class="field-hint">每行一项，最多 6 项。写能在视频里看到的动作，比如“下蹲时膝盖朝向脚尖”。</span><textarea name="checkpoints" rows="6" required data-preview="checkpoints" placeholder="准备姿势站稳，双脚外开&#10;下蹲时膝盖朝向脚尖&#10;还原时躯干保持直立">${escape(standard?.checkpoints?.join('\n') || '')}</textarea></label><section class="reference-block"><h2>教师示范视频</h2><p class="field-hint">选择 3–30 秒、20 MB 以内的单人视频。本机提取姿态角度，只保存统计数据，不上传或留存原视频。</p><label class="file-button ${state.referenceBusy?'disabled':''}"><input id="standard-video" type="file" accept="video/mp4,video/webm,video/quicktime" ${state.referenceBusy?'disabled':''}><span>${state.referenceFile ? '更换示范视频' : '选择示范视频'}</span></label><button type="button" class="secondary" data-command="extract-reference" ${!state.referenceFile||state.referenceBusy?'disabled':''}>${state.referenceBusy?'正在提取…':'提取参考数据'}</button><p class="hint" id="reference-status">${referenceStatus}</p>${state.referenceBusy?'<div class="progress-wrap"><p id="reference-progress-label">准备处理…</p><progress id="reference-progress" max="100" value="0"></progress></div>':''}${referenceSummary(reference)}</section><label class="check"><input type="checkbox" name="confirm" required><span>我已审核以上要求，发布给本班学生使用。</span></label><button class="primary" type="submit" ${state.referenceBusy?'disabled':''}>${standard ? `发布新版本 v${standard.version + 1}` : '发布动作标准'}</button></form></section><aside class="preview" aria-live="polite"><h2>学生将看到</h2><div class="preview-card"><div class="preview-figure">${dancer(actions().indexOf(chosen))}</div><h3 data-out="title">${escape(standard?.title || chosen.title)}</h3><p class="feature-meta" data-out="view">${viewName(view)}</p><p data-out="instructions" class="preview-text">${escape(standard?.instructions || '') || '<span class="placeholder">教学要求会显示在这里</span>'}</p><ol class="checkpoints" data-out="checkpoints">${(standard?.checkpoints || []).map((item)=>`<li>${escape(item)}</li>`).join('') || '<li class="placeholder">检查点会逐条显示在这里</li>'}</ol></div><p class="aside-note">示范统计可作为动作参考，不代表标准答案或医学结论；正式反馈仍由你审核。</p></aside></div>`);
  if (state.referenceFile) {
    if (!state.referenceVideoUrl) state.referenceVideoUrl = URL.createObjectURL(state.referenceFile);
    document.querySelector('.preview').insertAdjacentHTML('afterbegin', `<section class="reference-visual"><h2>教师示范 · 骨架预览</h2><div class="video-stage"><video id="reference-preview-video" src="${escape(state.referenceVideoUrl)}" controls muted playsinline></video><canvas id="reference-pose-overlay" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none"></canvas></div><p class="hint">${state.referencePose ? '播放示范视频，查看实际提取的骨架随动作变化。' : '点击“提取参考数据”后显示骨架；原片仅在本机预览。'}</p></section>`);
    wireReferenceVideo();
  }
}

function practice() {
  if (!state.user) { state.tab = 'login'; return login(); }
  if (state.user.role === 'teacher') { state.tab = 'standards'; return standards(); }
  if (state.user.role !== 'student') { toast('风险复核教师请使用舞安智护'); return home(); }
  const chosen = action(), standard = chosen.standard;
  const missing = [!standard && '老师先发布这个动作的标准', !state.file && '选择一段练习视频'].filter(Boolean);
  shell(`${heading('开始练习', '原视频默认只留在这台电脑上。骨架和指标在本机提取，上传的只有指标；关键帧和原视频要你另外授权。')}<div class="studio"><form id="practice-form" class="steps-form"><section class="step-block"><h2><span class="step-no">1</span>选动作</h2><select id="practice-action" aria-label="练习动作" ${state.busy?'disabled':''}>${actions().map((item)=>`<option value="${item.key}" ${item.key===chosen.key?'selected':''}>${escape(item.title)}${item.standard ? '' : '（老师未发布）'}</option>`).join('')}</select></section><section class="step-block"><h2><span class="step-no">2</span>读老师的要求</h2>${standard ? `<p class="feature-meta">标准 v${standard.version}　${viewName(standard.view)}</p><p>${escape(standard.instructions)}</p><ol class="checkpoints">${standard.checkpoints.map((item)=>`<li>${escape(item)}</li>`).join('')}</ol><p class="hint">请按${viewName(standard.view)}，系统不会自动确认机位。</p>` : '<p class="pending-note">老师还没有为这个动作发布标准，暂时不能练习。可以先选其他动作。</p>'}</section><section class="step-block"><h2><span class="step-no">3</span>选择练习视频</h2><label class="file-button ${state.busy?'disabled':''}"><input id="video-file" type="file" accept="video/mp4,video/webm,video/quicktime" ${state.busy?'disabled':''}><span>${state.file ? '换一段视频' : '选择视频文件'}</span></label>${state.file ? `<p class="file-name">${escape(state.file.name)}　${(state.file.size/1024/1024).toFixed(1)} MB</p>` : '<p class="hint">3–30 秒，单人全身入镜，避开镜子，不超过 20 MB。</p>'}</section><section class="step-block"><h2><span class="step-no">4</span>授权</h2><label class="check"><input name="teaching" type="checkbox" required ${state.busy?'disabled':''}><span><b>必选</b>　提取并保存姿态指标，用于我的练习记录和本班老师的反馈。</span></label><label class="check ${!state.catalog?.vision_configured ? 'off' : ''}"><input name="cloud" type="checkbox" ${state.busy||!state.catalog?.vision_configured?'disabled':''}><span>向云端模型发送最多 6 张遮挡面部的关键帧。${!state.catalog?.vision_configured?'当前没有配置视觉模型，这一项不可用，只做本机指标分析。':'遮挡不能保证完全匿名。'}</span></label><label class="check"><input name="video" type="checkbox" ${state.busy?'disabled':''}><span>保存原视频给本班舞蹈老师查看，30 天后自动删除，不公开展示。</span></label></section><section class="step-block last"><button class="primary wide" type="submit" ${missing.length||state.busy?'disabled':''}>${state.busy?'正在处理…':'提取骨架并分析'}</button>${missing.length && !state.busy ? `<p class="hint">还差：${missing.join('；')}。</p>` : ''}<div class="progress-wrap" id="processing" ${state.busy?'':'hidden'}><p id="progress-message">准备处理…</p><progress id="pose-progress" max="100" value="0"></progress><button type="button" class="link-button" data-command="cancel">取消处理</button></div></section></form><div class="stage-col"><div class="video-stage">${state.videoUrl ? `<video id="practice-video" src="${escape(state.videoUrl)}" controls playsinline></video><canvas id="pose-overlay"></canvas>` : `<div class="video-placeholder">${dancer(actions().indexOf(chosen))}<p>选好视频后在这里预览，分析完成后会叠加骨架</p></div>`}</div><p class="aside-note">关闭页面后，没有授权保存的原视频无法找回；分析记录会保留。</p></div></div>`);
}

function metricCards(report) {
  return report.metrics ? `<div class="metrics">${Object.values(report.metrics.metrics).map((metric)=>`<div class="metric ${metric.uncertain ? 'uncertain' : ''}"><span>${escape(metric.label)}</span><b>${metric.value===null?'—':metric.value.toFixed(metric.unit==='°'?1:3)}<small>${metric.unit}</small></b><small>${metric.uncertain?'数据不足，不作结论':`有效帧 ${metric.frames_used}`}</small></div>`).join('')}</div><p class="hint">整段统计，二维投影，有效帧 ${Math.round(report.metrics.coverage*100)}%。“髋中点摆动”包含动作本身的位移，不等于稳定性评分。</p>`:'<div class="empty"><p>还没有姿态指标</p></div>';
}

function recovery(report) {
  if (state.user.role !== 'student') return '';
  if (report.status === 'NEEDS_RECAPTURE' && report.video_url && report.metrics?.version !== METRIC_VERSION) {
    return `<div class="notice action-notice"><div><b>${state.busy ? '正在按新版规则重新分析已上传视频' : '这条旧记录已保存原视频'}</b><p class="hint">${state.busy ? '视频只在本机重新提取；完成后会自动提交千问。' : '打开这条记录时会直接重算并提交千问，无需再次选择文件。'}</p>${state.busy ? '<div class="progress-wrap"><p id="saved-retry-message">准备读取已保存视频…</p><progress id="saved-retry-progress" max="100" value="0"></progress></div>' : ''}</div>${state.busy ? '<button data-command="cancel">取消</button>' : '<span class="tag tone-wait">待重新分析</span>'}</div>`;
  }
  if (report.status === 'METRICS_READY') return '<div class="notice action-notice"><span>姿态指标已保存。不发送关键帧也可以直接提交老师复核。</span><button class="primary" data-command="resume-analysis">提交老师复核</button></div>';
  if (report.status === 'POSE_PENDING') return '<div class="notice warning">这一轮的姿态没有提取完成。请重新选择视频开始一轮，或撤回这条空记录。</div>';
  return '';
}

function complianceCard(report, teacher) {
  const compliance = report.analysis?.compliance;
  if (!teacher || !compliance || compliance.status === 'unassessed') return '';
  const labels = { appears_compliant: '初步符合', needs_correction: '发现待纠正项', uncertain: '证据不足' };
  const tone = compliance.status === 'appears_compliant' ? 'done' : compliance.status === 'needs_correction' ? 'redo' : 'wait';
  return `<section class="panel drafts"><div class="panel-head"><h2>千问动作合规预判</h2><span class="tag tone-${tone}">${labels[compliance.status] || '待复核'}</span></div><p>${escape(compliance.summary)}</p>${compliance.evidence?.length ? `<small>依据：${compliance.evidence.map(escape).join('、')}</small>` : ''}<p class="hint">只对照老师发布的动作标准和角度证据，不代表医学安全；最终结论由教师确认。</p></section>`;
}

function reportPage() {
  const report = state.report;
  if (!report) return history();
  const feedback = report.feedback[0], teacher = state.user.role === 'teacher';
  const local = !teacher && state.trainingId === report.training_id ? state.videoUrl : null;
  const video = local || report.video_url;
  const videoCaption = teacher && video ? '<p class="hint">学生本次授权保存的练习视频</p>' : '';
  const agentState = { completed: '已完成，待老师判定', failed: '未完成，已降级', skipped: '未调用' };
  shell(`<div class="page-heading report-head"><div><h1>${escape(report.standard.title)}</h1><p>${escape(report.student_code)}　${formatTime(report.created_at)}　标准 v${report.standard.version}</p></div>${statusTag(report.status)}</div>${recovery(report)}<div class="report"><section>${videoCaption}<div class="video-stage">${video?`<video id="practice-video" src="${escape(video)}" controls playsinline></video>${local?'<canvas id="pose-overlay"></canvas>':''}`:`<div class="video-placeholder">${dancer()}<p>${report.status==='WITHDRAWN'?'这次的授权已撤回':teacher?'学生本次练习视频未授权保存或已过期':'原视频没有保存到服务器'}</p><small>这是动作示意，不是本次的分析结果</small></div>`}</div><div class="panel-head spaced"><h2>动作指标</h2><small>姿态测量，不是医学测量</small></div>${metricCards(report)}${report.metrics?.flags?.length?`<div class="notice warning">${report.metrics.flags.map(escape).join('<br>')}</div>`:''}<div class="panel-head spaced"><h2>分析进度</h2><small>${report.analysis?.mode==='multimodal'?'AI 辅助，结论以老师为准':'以实际分析状态为准'}</small></div><ul class="agents">${(report.analysis?.agents||state.catalog.roles).map((agent)=>`<li class="agent st-${agent.status || 'none'}"><span class="dot" aria-hidden="true"></span><span>${escape(agent.label)}</span><small>${agentState[agent.status]||'未调用'}</small></li>`).join('')}</ul><p class="hint">${escape(report.analysis?.message || (report.status==='AI_PROCESSING'?'后台正在分析，可以稍后从记录页回来查看。':'姿态提取完成后才能进入分析和复核。'))}</p>${complianceCard(report, teacher)}${teacher && report.analysis?.agents?.some((agent)=>agent.findings?.length)?`<section class="panel drafts"><h2>AI 草稿与证据</h2>${report.analysis.agents.flatMap((agent)=>(agent.findings||[]).map((finding)=>`<div class="finding"><small>${escape(agent.label)}　${finding.uncertain?'不确定':'待复核'}</small><p>${escape(finding.text)}</p><small>证据：${finding.evidence.map(escape).join('、')}</small></div>`)).join('')}</section>`:''}</section><section class="report-side"><div class="panel feedback ${feedback ? 'has-feedback' : ''}"><h2>${feedback?'老师的反馈':'等待老师复核'}</h2>${feedback?`<small>反馈 v${feedback.version}　${formatTime(feedback.created_at)}</small><h3>做得好的地方</h3><ul class="feedback-list">${feedback.strengths.map((item)=>`<li>${escape(item)}</li>`).join('')||'<li>本轮未单独填写</li>'}</ul><h3>这一轮优先改进</h3><ol class="feedback-list">${feedback.priorities.map((item)=>`<li>${escape(item)}</li>`).join('')||'<li>本轮没有新增的优先项</li>'}</ol><div class="next-drill"><h3>下一轮练习</h3><p>${escape(feedback.next_drill)}</p></div>`:'<p class="muted">AI 草稿不会直接作为正式评价。老师会结合视频、指标和教学要求确认后发布。</p>'}${!teacher && report.status!=='WITHDRAWN'?`<button class="primary wide" data-action="${escape(report.standard.action_key)}">再练一次</button>`:''}</div>${teacher&&['WAITING_REVIEW','PUBLISHED'].includes(report.status)?`<div class="panel"><h2>${feedback ? '修改并重新发布' : '复核并发布反馈'}</h2><form id="review-form"><label class="field">对 AI 建议的处理<select name="decision"><option value="modify">我独立填写或修改</option><option value="adopt">采纳 AI 建议</option><option value="reject">否决 AI 建议并补充</option></select></label><label class="field">做得好的地方<span class="field-hint">每行一项，最多两项</span><textarea name="strengths">${escape(feedback?.strengths.join('\n')||'')}</textarea></label><label class="field">优先改进<span class="field-hint">每行一项，最多三项</span><textarea name="priorities">${escape(feedback?.priorities.join('\n')||'')}</textarea></label><label class="field">下一轮练习提示<textarea name="next_drill" required maxlength="1000">${escape(feedback?.next_drill||'')}</textarea></label><button class="primary wide" type="submit">发布反馈</button></form></div>`:''}${!teacher&&report.status!=='WITHDRAWN'?'<button class="link-button danger" data-command="withdraw">撤回这次授权并删除分析数据</button>':''}</section></div>`);
  clearTimeout(state.poll);
  if (report.status==='AI_PROCESSING') state.poll=setTimeout(async()=>{try{state.report=await api('GET',`/sessions/${report.training_id}`);if(state.tab==='report')reportPage();}catch(error){toast(error.message);}},2000);
}

function history() {
  const review = state.tab==='review';
  const sessions = review?state.sessions.filter((session)=>session.status==='WAITING_REVIEW'):state.sessions;
  let comparison = '';
  if (state.user?.role==='student') {
    const complete = state.sessions.filter((session)=>session.status==='PUBLISHED' && session.metrics?.reliable);
    const latest=complete[0], prior=latest&&complete.slice(1).find((session)=>session.standard.standard_id===latest.standard.standard_id);
    if (prior) comparison=`<section class="panel"><div class="panel-head"><h2>最近两轮对比：${escape(latest.standard.title)}</h2></div><p class="hint">同一标准版本下的测量变化。数值变化不自动代表动作进步，请结合老师的反馈看。</p><div class="table-wrap"><table><thead><tr><th>指标</th><th>上一轮</th><th>这一轮</th></tr></thead><tbody>${Object.keys(latest.metrics.metrics).map((name)=>`<tr><td>${escape(latest.metrics.metrics[name].label)}</td><td class="num">${prior.metrics.metrics[name].value??'—'}</td><td class="num">${latest.metrics.metrics[name].value??'—'}</td></tr>`).join('')}</tbody></table></div></section>`;
  }
  const title = review ? '训练复核' : state.user?.role === 'teacher' ? '训练记录' : '成长记录';
  const desc = review ? `${sessions.length ? `${sessions.length} 段练习等你复核，按提交时间排列。` : ''}` : '记录动作、证据和老师的判断，不用一个总分概括成长。';
  shell(`${heading(title, desc)}<section class="panel">${sessionRows(sessions, review ? '没有等待复核的练习' : '还没有练习记录', review ? '学生提交后会出现在这里。' : '选一个动作，录下第一轮练习。')}</section>${comparison}`);
}

function healthPage() {
  const health=state.health;
  if(state.user?.role==='teacher') {shell(`${heading('健康信息按职责查看','你当前是舞蹈教师账号。学生的健康明细只有本人和本班风险复核教师能看到。')}<section class="panel"><p>请使用风险复核教师账号查看健康记录。</p><a href="/wujing" class="button-link">返回舞镜智练</a></section>`);return;}
  const checkins=health?.checkins||[], loads=health?.loads||[], medic=state.user?.role==='medic';
  const loadView=state.tab==='loads';
  const title = loadView ? (medic ? '本班训练负荷' : '记录训练负荷') : medic ? '本班训练状态' : '今天身体怎么样';
  const desc = medic ? '学生自报的记录，按日期倒序。记录只反映自报信息，不是诊断。' : '训练前花半分钟记一下。疲劳、睡眠和身体感受也是训练的一部分；出现疼痛、肿胀或不适时，请停止相关训练并寻求专业帮助。';
  shell(`${heading(title, desc)}<p class="notice warning">${escape(health?.risk.message||'风险筛查规则尚未发布，目前只记录状态与负荷，不做安全评级。')}</p><div class="${medic ? '' : 'health-grid'}">${!medic?`<section class="panel"><h2>${loadView?'添加一次训练':'训练前状态打卡'}</h2><form id="${loadView?'load-form':'health-form'}"><label class="field">日期<input type="date" name="date" value="${day()}" max="${day()}" required></label>${loadView?'<div class="two-fields"><label class="field">训练时长（分钟）<input type="number" name="minutes" min="1" max="300" required inputmode="numeric"></label><label class="field">主观强度 RPE（0–10）<input type="number" name="rpe" min="0" max="10" required inputmode="numeric"></label></div><p class="hint">训练负荷 = 分钟数 × RPE，单凭它不能判断是否安全。</p>':'<div class="three-fields"><label class="field">疲劳（1–5）<input type="number" name="fatigue" min="1" max="5" required inputmode="numeric"></label><label class="field">昨晚睡眠（小时）<input type="number" name="sleep_hours" min="0" max="24" step="0.5" required inputmode="decimal"></label><label class="field">疼痛（0–10）<input type="number" name="pain" min="0" max="10" required inputmode="numeric"></label></div><label class="field">不适部位<span class="field-hint">可不填，多个部位用逗号分隔</span><input name="areas" maxlength="200" placeholder="例如左膝、右踝"></label>'}<label class="check"><input type="checkbox" name="consent" required><span>同意保存这条记录，只给本人和本班风险复核教师查看，可以随时撤回删除。</span></label><button class="primary" type="submit">${loadView?'保存训练负荷':'保存今日状态'}</button></form></section>`:''}<section class="panel"><div class="panel-head"><h2>${medic?'记录':'最近记录'}</h2></div>${loadView?loads.length?`<div class="table-wrap"><table><thead><tr><th>日期</th>${medic?'<th>学员代号</th>':''}<th class="num">时长</th><th class="num">RPE</th><th class="num">负荷</th></tr></thead><tbody>${loads.map((item)=>`<tr><td>${item.date}</td>${medic?`<td>${escape(item.student_code)}</td>`:''}<td class="num">${item.minutes} 分</td><td class="num">${item.rpe}</td><td class="num">${item.load}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><p>还没有训练负荷记录</p></div>':checkins.length?`<div class="rows">${checkins.slice(0,12).map((item)=>`<div class="checkin-row"><b>${item.date}${medic?`　${escape(item.student_code)}`:''}</b><span class="readings"><span>疲劳 <b>${item.fatigue}</b>/5</span><span>睡眠 <b>${item.sleep_hours}</b> 小时</span><span class="${item.pain >= 4 ? 'high' : ''}">疼痛 <b>${item.pain}</b>/10</span></span>${item.areas.length?`<small>自报部位：${item.areas.map(escape).join('、')}</small>`:''}</div>`).join('')}</div>`:'<div class="empty"><p>还没有状态打卡记录</p><small>记录只反映自报信息，不是系统诊断。</small></div>'}${!medic&&state.user?'<button class="link-button danger" data-command="withdraw-health">撤回并删除全部健康与负荷记录</button>':''}</section></div>`);
}

function render() {
  if (state.tab==='login') return login();
  if (!state.user) {state.tab='login';return login();}
  if (state.user.must_change_password) return passwordPage();
  if (isRisk && state.tab!=='login') return healthPage();
  if(state.tab==='practice')return practice();
  if(state.tab==='standards')return standards();
  if(state.tab==='report')return reportPage();
  if(['history','review'].includes(state.tab))return history();
  home();
}

async function refresh() {
  state.user=await api('GET','/me');
  if(state.user.must_change_password)return;
  state.catalog=await api('GET','/catalog');
  if(state.user.role!=='medic')state.sessions=(await api('GET','/sessions')).sessions;
  if(isRisk&&state.user.role!=='teacher')state.health=await api('GET','/health');
}

function passwordPage() {
  shell('<section class="panel"><h1>设置自己的登录密码</h1><p>首次登录或管理员重置密码后，请先修改临时密码。新密码需 8—128 位，同时包含字母和数字。</p><form id="dance-password-form"><label class="field">临时密码<input name="old_password" type="password" autocomplete="current-password" required></label><label class="field">新密码<input name="new_password" type="password" autocomplete="new-password" minlength="8" required></label><label class="field">确认新密码<input name="confirm_password" type="password" autocomplete="new-password" required></label><button type="submit">保存密码并进入平台</button></form></section>');
}

function wireReferenceVideo() {
  const video = document.querySelector('#reference-preview-video'), canvas = document.querySelector('#reference-pose-overlay');
  if (!video || !canvas) return;
  const update = () => {
    const pose = state.referencePose;
    if (!pose?.frames?.length) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); return; }
    const frame = pose.frames.reduce((closest, entry) => Math.abs(entry.time - video.currentTime) < Math.abs(closest.time - video.currentTime) ? entry : closest, pose.frames[0]);
    drawSkeleton(canvas, frame.landmarks, pose.width, pose.height);
  };
  video.addEventListener('timeupdate', update);
  video.addEventListener('seeked', update);
  video.addEventListener('loadedmetadata', update);
  update();
}

function wireVideo() {
  const video=document.querySelector('#practice-video'),canvas=document.querySelector('#pose-overlay');
  if(!video||!canvas||!state.pose)return;
  const update=()=>{const frame=state.pose.frames.reduce((closest,entry)=>Math.abs(entry.time-video.currentTime)<Math.abs(closest.time-video.currentTime)?entry:closest,state.pose.frames[0]);drawSkeleton(canvas,frame.landmarks,state.pose.width,state.pose.height);};
  video.addEventListener('timeupdate',update);video.addEventListener('loadedmetadata',update);update();
}

root.addEventListener('change',(event)=>{
  if(['practice-action','standard-action'].includes(event.target.id)){
    if(event.target.id==='standard-action'){if(state.referenceVideoUrl)URL.revokeObjectURL(state.referenceVideoUrl);state.referenceVideoUrl=null;state.referenceFile=null;state.referencePose=null;state.referenceMetrics=null;state.referenceKeyframes=[];}
    state.action=event.target.value;render();
  }
  if(event.target.id==='standard-video'){
    if(state.referenceVideoUrl)URL.revokeObjectURL(state.referenceVideoUrl);state.referenceVideoUrl=null;
    state.referenceFile=event.target.files?.[0]||null;state.referencePose=null;state.referenceMetrics=null;state.referenceKeyframes=[];render();
  }
      if(event.target.dataset?.preview==='view'&&state.referencePose?.view!==event.target.value){state.referencePose=null;state.referenceMetrics=null;state.referenceKeyframes=[];}
  if(event.target.id==='video-file'){
    const file=event.target.files[0];if(!file)return;
    if(file.size>100*1024*1024){toast('请使用不超过 100MB 的视频');return;}
    if(state.videoUrl)URL.revokeObjectURL(state.videoUrl);
    state.file=file;state.videoUrl=URL.createObjectURL(file);state.pose=null;state.trainingId=null;render();
  }
});

root.addEventListener('input',(event)=>{
  const key=event.target.dataset?.preview;if(!key)return;
  const out=document.querySelector(`[data-out="${key}"]`);if(!out)return;
  const value=event.target.value;
  if(key==='checkpoints'){const items=value.split('\n').map((line)=>line.trim()).filter(Boolean).slice(0,6);out.innerHTML=items.length?items.map((item)=>`<li>${escape(item)}</li>`).join(''):'<li class="placeholder">检查点会逐条显示在这里</li>';}
  else if(key==='view')out.textContent=viewName(value);
  else if(key==='instructions')out.innerHTML=value.trim()?escape(value):'<span class="placeholder">教学要求会显示在这里</span>';
  else out.textContent=value;
});
root.addEventListener('change',(event)=>{if(event.target.dataset?.preview==='view')event.target.dispatchEvent(new Event('input',{bubbles:true}));});

root.addEventListener('click',async(event)=>{
  const button=event.target.closest('button');if(!button||button.disabled)return;
  try{
    if(button.dataset.tab){clearTimeout(state.poll);state.tab=button.dataset.tab;if(state.user&&['history','review','home'].includes(state.tab))await refresh();render();}
    if(button.dataset.pick){state.action=button.dataset.pick;home();document.querySelector('.feature')?.scrollIntoView({block:'nearest'});return;}
    if(button.dataset.action){state.action=button.dataset.action;state.tab=state.user?.role==='teacher'?'standards':'practice';render();}
    if(button.dataset.session){state.report=await api('GET',`/sessions/${button.dataset.session}`);state.tab='report';if(state.report.status==='NEEDS_RECAPTURE'&&state.report.video_url&&state.report.metrics?.version!==METRIC_VERSION)await reanalyzeSavedVideo(state.report);else render();}
    if(button.dataset.command==='logout'){clearTimeout(state.poll);state.controller?.abort();await api('POST','/auth/logout');state.user=null;state.sessions=[];state.catalog=null;state.health=null;state.report=null;state.pose=null;state.file=null;state.trainingId=null;if(state.videoUrl)URL.revokeObjectURL(state.videoUrl);state.videoUrl=null;state.tab='login';render();}
    if(button.dataset.command==='cancel')state.controller?.abort();
    if(button.dataset.command==='extract-reference'){
      const file=state.referenceFile,view=document.querySelector('#standard-form [name="view"]')?.value||action().view;
      if(!file)throw new Error('请先选择教师示范视频');
      state.referenceBusy=true;render();
      try{
        const extracted=await extractPose(file,{view,captureKeyframes:true,keyframeLimit:3,onProgress:({percent,message})=>{const label=document.querySelector('#reference-progress-label'),progress=document.querySelector('#reference-progress');if(label)label.textContent=message;if(progress)progress.value=percent;}});
        const metrics=computeMetrics(extracted.pose);
        if(!metrics.reliable)throw new Error('示范视频姿态质量不足，请调整机位后重试');
        state.referencePose=extracted.pose;state.referenceMetrics=metrics;state.referenceKeyframes=extracted.keyframes;toast('教师示范角度与对照帧已提取');
      }finally{state.referenceBusy=false;render();}
    }
    if(button.dataset.command==='resume-analysis'){state.report=await api('POST',`/sessions/${state.report.training_id}/analyze`,{keyframes:[]});render();}
    if(button.dataset.command==='withdraw'&&confirm('撤回本次教学授权，并删除原视频、姿态及反馈？')){await api('POST',`/sessions/${state.report.training_id}/withdraw`);state.report=await api('GET',`/sessions/${state.report.training_id}`);if(state.trainingId===state.report.training_id){state.pose=null;state.trainingId=null;if(state.videoUrl)URL.revokeObjectURL(state.videoUrl);state.videoUrl=null;state.file=null;}render();toast('本次分析数据已删除');}
    if(button.dataset.command==='withdraw-health'&&confirm('撤回健康授权并删除全部健康和负荷记录？')){await api('POST','/health/withdraw');await refresh();render();toast('健康与负荷记录已删除');}
  }catch(error){toast(error.message);}
});

root.addEventListener('submit',async(event)=>{
  event.preventDefault();
  const form=event.target,data=new FormData(form),submit=form.querySelector('button[type="submit"],button.primary');
  if(submit)submit.disabled=true;
  const lines=(name)=>String(data.get(name)||'').split('\n').map((line)=>line.trim()).filter(Boolean);
  try{
    if(form.id==='dance-password-form'){
      if(data.get('new_password')!==data.get('confirm_password'))throw new Error('两次输入的新密码不一致');
      await api('POST','/auth/password',{old_password:data.get('old_password'),new_password:data.get('new_password')});
      await refresh();state.tab=isRisk?'health':'home';render();toast('密码已更新');
    }else if(form.id==='login-form'){
      await api('POST','/auth/login',{login:data.get('login'),password:data.get('password')});await refresh();state.tab=isRisk?'health':'home';render();
    }else if(form.id==='standard-form'){
      if(state.referenceFile&&!state.referencePose)throw new Error('请先提取新选择的示范视频参考数据');
      await api('POST','/standards',{action_key:data.get('action_key'),title:data.get('title'),view:data.get('view'),instructions:data.get('instructions'),checkpoints:lines('checkpoints'),confirm:data.get('confirm')==='on',reference_pose:state.referencePose||undefined,reference_keyframes:state.referenceKeyframes});state.referenceFile=null;state.referencePose=null;state.referenceMetrics=null;state.referenceKeyframes=[];await refresh();render();toast('动作标准已发布');
    }else if(form.id==='review-form'){
      state.report=await api('POST',`/sessions/${state.report.training_id}/reviews`,{decision:data.get('decision'),strengths:lines('strengths'),priorities:lines('priorities'),next_drill:data.get('next_drill'),expected_version:state.report.feedback[0]?.version||0});render();toast('反馈已发布，学生现在可以查看');
    }else if(form.id==='health-form'){
      if(!state.user){state.tab='login';render();return;}
      state.health=await api('POST','/checkins',{date:data.get('date'),fatigue:Number(data.get('fatigue')),sleep_hours:Number(data.get('sleep_hours')),pain:Number(data.get('pain')),areas:String(data.get('areas')||'').split(/[,，、]/).map((item)=>item.trim()).filter(Boolean),consent_health:data.get('consent')==='on'});render();toast('状态已保存');
    }else if(form.id==='load-form'){
      state.health=await api('POST','/loads',{date:data.get('date'),minutes:Number(data.get('minutes')),rpe:Number(data.get('rpe')),consent_health:data.get('consent')==='on',idempotency_key:crypto.randomUUID()});render();toast('训练负荷已保存');
    }else if(form.id==='practice-form'){
      if(!state.file||!action().standard)throw new Error('请选择视频，并等待老师发布标准');
      const cloud=data.get('cloud')==='on',saveVideo=data.get('video')==='on';
      state.busy=true;state.controller=new AbortController();
      const standard=action().standard;
      state.report=null;state.trainingId=null;render();
      const extracted=await extractPose(state.file,{view:standard.view,captureKeyframes:cloud,keyframeLimit:6,signal:state.controller.signal,onProgress:({percent,message})=>{const label=document.querySelector('#progress-message'),progress=document.querySelector('#pose-progress');if(label)label.textContent=message;if(progress)progress.value=percent;}});
      state.pose=extracted.pose;
      if(state.controller.signal.aborted)throw new Error('已取消本机处理');
      const created=await api('POST','/sessions',{standard_id:standard.standard_id,idempotency_key:crypto.randomUUID(),consent_teaching:data.get('teaching')==='on',consent_cloud:cloud,consent_video:saveVideo});
      state.trainingId=created.training_id;
      state.report=await api('POST',`/sessions/${state.trainingId}/pose`,extracted.pose);
      if(saveVideo&&!state.controller.signal.aborted){
        try{state.report=await uploadVideo(`/sessions/${state.trainingId}/video`,state.file);}
        catch(error){toast(`原视频未保存：${error.message}；姿态指标仍可提交复核。`);}
      }
      if(state.report.status==='METRICS_READY'&&!state.controller.signal.aborted)state.report=await api('POST',`/sessions/${state.trainingId}/analyze`,{keyframes:extracted.keyframes});
      state.busy=false;state.tab='report';render();
    }
  }catch(error){
    if(form.id==='login-form'){const message=document.querySelector('#login-error');if(message)message.textContent=error.message;}
    else toast(error.message);
    if(state.busy){state.busy=false;if(state.report)state.tab='report';render();}
  }finally{if(submit?.isConnected)submit.disabled=false;}
});

await refresh().catch(()=>{state.user=null;});
render();
