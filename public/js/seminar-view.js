// 研课场工作台的渲染组件（纯函数：输入真实运行数据，输出 HTML）。
// DiscussionPanel（消息、筛选）· ResearchProgressPanel（任务进度）· OutcomePanel（研讨成果）· AgentRoundtable（数字教研圆桌 + 协同核心）。
import { esc, hl, STATUS_NAME } from './ui.js';
import { humanBadge } from './portraits.js';
import { teacherAvatar } from './avatar3d.js';
import { isIdeo } from './stage.js';

export const KIND_LABEL = { kp_explain: '讲解', kp_difficulty: '难点与误区', kp_ideology: '思政融入', kp_item: '检测题', kp_check: '核查', kp_decide: '定稿', explain: '讲解', difficulty: '难点与误区', ideology_link: '思政融入', item: '检测题', source_check: '证据核查', decision: '定稿', review: '材料研读', assign: '分派', poll: '轮询', draft: '起草', challenge: '质询', response: '回应', revision: '修订', question: '提问', report: '汇报', integrate: '整合', supplement: '补充', observation: '观察记录', reflect: '反思修订', socratic: '追问', viewpoint: '补充视角', discuss: '讨论交流', vote: '集体评审', finalize: '形成终稿' };
const SUMMARY_KINDS = new Set(['decision', 'integrate', 'poll', 'assign', 'review', 'kp_decide', 'finalize']);
// 证据缺口：只认明确的“待核查/缺来源”表述（“不引用未经核实的数据”这类说明不算缺口）
const EVID_GAP = /待核查|需核查|需要核查|无法核实|缺少(来源|出处|依据)|请补充[^。；]{0,12}(来源|出处|依据|标准)|未找到[^。；]{0,8}出处/;
export const isEvidenceGap = (e) => EVID_GAP.test(e?.text || '');
export const isEvidence = (e) => e.kind === 'source_check' || e.kind === 'kp_check' || isEvidenceGap(e);
export const isSummary = (e) => e.actor_type === 'system' || SUMMARY_KINDS.has(e.kind);
export const FILTERS = [['all', '全部观点'], ['talk', '教师发言'], ['ideo', '思政建议'], ['evid', '证据提醒'], ['sum', '系统提炼']];
export function filterEvents(events, f) {
  if (f === 'ideo') return events.filter((e) => isIdeo(e) || e.kind === 'ideology_link');
  if (f === 'evid') return events.filter(isEvidence);
  if (f === 'sum') return events.filter(isSummary);
  if (f === 'talk') return events.filter((e) => !isSummary(e));
  return events;
}

export function avatarHtml(role, seatIdx, cls = '') {
  if (role === 'human') return `<span class="sw-ava ${cls}">${humanBadge()}</span>`;
  return `<span class="sw-ava ${cls}">${teacherAvatar(role, { crop: true })}</span>`;
}
const hhmm = (iso) => { try { return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; } };
const matchedTerms = (text, terms) => terms.filter((t) => t && t.length >= 2 && text.includes(t)).slice(0, 2);

/** One discussion message. ctx: { names, roleOf(actorId), seatOf(actorId), byId(Map), terms } */
export function msgHtml(e, ctx) {
  const human = e.actor_type === 'human', sys = e.actor_type === 'system';
  const name = human ? `你（${e.human_role === 'student' ? '学生角色' : '教师'}）` : ctx.names[e.actor_id] || e.actor_id;
  const role = human ? 'human' : ctx.roleOf(e.actor_id);
  const prev = e.reply_to ? ctx.byId.get(e.reply_to) : null;
  const prevName = prev ? (prev.actor_type === 'human' ? '你' : ctx.names[prev.actor_id] || prev.actor_id) : null;
  const rel = prev ? `<span class="sw-rel">↩ 回应 ${esc(prevName)}</span>` : e.target_actor ? `<span class="sw-rel">${e.kind === 'challenge' ? '质询' : '@'} ${esc(ctx.names[e.target_actor] || e.target_actor)}</span>` : '';
  const tags = [];
  if (isIdeo(e) || e.kind === 'ideology_link') { tags.push('<span class="tg ideo">课程思政</span>'); for (const t of matchedTerms(e.text, ctx.terms)) tags.push(`<span class="tg ideo2">${esc(t)}</span>`); }
  if (isEvidenceGap(e)) tags.push('<span class="tg evid">证据待补充</span>');
  else if (e.kind === 'source_check' || e.kind === 'kp_check') tags.push('<span class="tg ok">来源已核查</span>');
  if (e.kind === 'challenge') tags.push('<span class="tg q">质询</span>');
  if (SUMMARY_KINDS.has(e.kind)) tags.push('<span class="tg sum">系统提炼</span>');
  return `<article class="sw-msg${human ? ' human' : ''}${sys ? ' sys' : ''}${ctx.highlight === e.event_id ? ' now' : ''}" data-seq="${e.sequence}" data-actor="${esc(e.actor_id)}">
    ${sys ? '<span class="sw-ava sys" aria-hidden="true">研</span>' : avatarHtml(role, ctx.seatOf(e.actor_id))}
    <div class="sw-mb"><div class="sw-mh"><b>${esc(name)}</b><time>${hhmm(e.time)}</time><span class="sw-kind">${esc(KIND_LABEL[e.kind] || e.kind)}</span>${rel}</div>
      <div class="sw-mt">${hl(e.text, ctx.terms)}</div>${tags.length ? `<div class="sw-tags">${tags.join('')}</div>` : ''}</div></article>`;
}

// ---------- 智能体状态（完全由真实事件与编排推导） ----------
/**
 * @returns [{ id, seat, role, name, duty, status, label, latest, spoke, mentioned }]
 * status: speaking | thinking | host | alert | done | waiting | idle
 */
export function agentStates({ seats, roles, events, plan, cursor, run, streamingActor, challenges = [] }) {
  const active = run && ['running', 'paused', 'awaiting_human', 'ready'].includes(run.status);
  const running = run && ['running', 'awaiting_human'].includes(run.status);
  const last = events.at(-1);
  const next = running && plan?.steps?.[cursor ?? 0];
  const lastHuman = [...events].reverse().find((e) => e.actor_type === 'human');
  const answered = lastHuman && events.some((e) => e.reply_to === lastHuman.event_id);
  return seats.map((role, i) => {
    const id = `M${i}`, mine = events.filter((e) => e.actor_id === id);
    const latest = mine.at(-1);
    const r = roles[role] || { name: role, duty: '' };
    const a = { id, seat: i, role, name: r.name, person: r.person || '', title: r.title || r.name, custom: !!r.custom, duty: r.duty || '', spoke: mine.length, latest: latest?.text || '', mentioned: !!(lastHuman && lastHuman.target_actor === id && !answered), status: 'idle', label: active ? '在线' : '待命' };
    const gaps = mine.filter(isEvidenceGap).length, checks = mine.filter((e) => e.kind === 'source_check' || e.kind === 'kp_check').length;
    const openCh = challenges.filter((c) => c.target_actor === id && !c.response_event_id).length;
    if (role === 'leader') Object.assign(a, active ? { status: 'host', label: last?.kind === 'integrate' ? '汇总完成' : '主持中' } : mine.some((e) => e.kind === 'integrate') ? { status: 'done', label: '已汇总' } : {});
    else if (role === 'evidence' && gaps) Object.assign(a, { status: 'alert', label: `发现 ${gaps} 处证据缺口` });
    else if (role === 'evidence' && checks) Object.assign(a, { status: 'done', label: `已核查 ${checks} 处` });
    else if (role === 'ideology' && mine.length) Object.assign(a, { status: 'done', label: '思政建议已提交' });
    else if (role === 'assessor' && mine.length) Object.assign(a, { status: 'done', label: '评价建议已提交' });
    else if (mine.length) Object.assign(a, { status: 'done', label: '建议已提交' });
    else if (active) Object.assign(a, { status: 'waiting', label: '等待发言' });
    if (openCh) Object.assign(a, { status: 'alert', label: `待回应质询 ${openCh}` });
    if (a.mentioned) Object.assign(a, { status: 'alert', label: '被 @，待回应' });
    if (next && next.seat === i) Object.assign(a, { status: 'thinking', label: '思考中' });
    if (streamingActor === id || (running && last?.actor_id === id && !streamingActor)) Object.assign(a, { status: 'speaking', label: '正在发言' });
    return a;
  });
}

// 圆桌布局：组长居左主位，最后一位居右，其余分布在上下两道弧上（避开中央协同核心）
export function tablePositions(n) {
  const pts = new Array(n); pts[0] = { x: 7.5, y: 50 };
  if (n === 1) return pts;
  pts[n - 1] = { x: 92.5, y: 50 };
  const mid = [...Array(n - 2).keys()].map((k) => k + 1), top = mid.slice(0, Math.ceil(mid.length / 2)), bot = mid.slice(Math.ceil(mid.length / 2)).reverse();
  const xs = (k) => { // k 个位置分布在 [18,38] ∪ [62,82]，避开中央协同核心
    if (k === 1) return [28]; const out = []; for (let i = 0; i < k; i++) { const t = i / (k - 1), v = 18 + t * 40; out.push(v > 38.001 ? v + 24 : v); } return out;
  };
  xs(top.length).forEach((x, i) => { pts[top[i]] = { x, y: 21 + Math.abs(x - 50) * 0.09 }; });
  xs(bot.length).forEach((x, i) => { pts[bot[i]] = { x, y: 79 - Math.abs(x - 50) * 0.09 }; });
  return pts;
}

export function coreHtml(core) {
  return `<div class="sw-core" id="sw-core" style="left:50%;top:50%"><div class="sw-core-ring" aria-hidden="true"></div>
    <div class="sw-core-in"><b>多智能体协同</b>${core.lines.map(([k, v]) => `<div class="sw-cl"><span>${esc(k)}</span>${esc(v)}</div>`).join('')}</div></div>`;
}
export function roundtableHtml(agents, core) {
  const pts = tablePositions(agents.length);
  const lines = agents.map((a, i) => { const p = pts[i]; const mx = (p.x + 50) / 2, my = (p.y + 50) / 2 + (p.y < 50 ? -6 : 6); return `<path class="sw-link ${a.status}" data-link="${a.id}" d="M${p.x} ${p.y} Q${mx} ${my} 50 50" vector-effect="non-scaling-stroke"/>`; }).join('');
  return `<div class="sw-floor" aria-hidden="true"></div><div class="sw-beam" aria-hidden="true"></div><svg class="sw-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>
    ${coreHtml(core)}
    ${agents.map((a, i) => `<button type="button" class="sw-agent ag3 st-${a.status}${a.seat === 0 ? ' head' : ''}${a.mentioned ? ' mentioned' : ''}${a.custom ? ' custom' : ''}" data-agent="${a.id}" style="left:${pts[i].x}%;top:${pts[i].y}%;--d:${i * 70}ms" aria-label="${esc(`${a.person} ${a.title}：${a.label}。职责：${a.duty}。点击 @ 这位教师`)}">
      <span class="ag3-halo" aria-hidden="true"></span>
      <span class="sw-ring">${avatarHtml(a.role, a.seat)}${a.status === 'speaking' ? '<span class="sw-wave" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}${a.status === 'thinking' ? '<span class="ag3-typing" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}</span>
      <span class="sw-an"><b>${esc(a.person || a.title)}${a.seat === 0 ? '<em>主持</em>' : ''}</b><small>${esc(a.person ? a.title : a.duty.split(/[、，]/)[0])}</small>
      <span class="sw-st">${a.status === 'thinking' ? '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>' : '<span class="dot" aria-hidden="true"></span>'}${esc(a.label)}</span></span>
      <span class="ag3-base" aria-hidden="true"></span>
      <span class="sw-tip" role="tooltip"><b>${esc(a.person ? `${a.person} · ${a.title}` : a.title)}</b><span>${esc(a.duty)}</span>${a.latest ? `<q>${esc(a.latest.slice(0, 90))}${a.latest.length > 90 ? '…' : ''}</q>` : '<span class="faint">尚未发言</span>'}<span class="faint">点击 @ 这位教师</span></span>
    </button>`).join('')}`;
}

// ---------- 研课八步进程条：每一步的状态、步数、用时，以及按实际节奏预估的完成时间 ----------
const clock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export function stageTimeline({ plan, cursor, events, run, phasesName }) {
  const steps = plan?.steps || []; if (!steps.length) return null;
  const order = [...new Set(steps.map((x) => x.phase))];
  const cur = run?.status === 'completed' ? steps.length : Math.min(cursor ?? 0, steps.length);
  const byStage = {}; for (const e of events) if (e.stage) (byStage[e.stage] = byStage[e.stage] || []).push(e);
  const list = order.map((ph) => {
    const idx = steps.map((x, i) => [x, i]).filter(([x]) => x.phase === ph).map(([, i]) => i);
    const done = idx.filter((i) => i < cur).length, evs = byStage[ph] || [];
    const t0 = evs[0] ? Date.parse(evs[0].time) : null, t1 = evs.at(-1) ? Date.parse(evs.at(-1).time) : null;
    return { key: ph, name: phasesName[ph] || ph, total: idx.length, done, state: done >= idx.length ? 'done' : done > 0 || idx[0] === cur ? 'running' : 'pending', start: t0, end: done >= idx.length ? t1 : null, dur: t0 ? (done >= idx.length ? t1 : Date.now()) - t0 : 0, events: evs.length };
  });
  // 预估：按已完成步骤的平均用时（扣除暂停时间）推算剩余时间
  const active = run?.started_at ? ((run.ended_at ? Date.parse(run.ended_at) : run.paused_at ? Date.parse(run.paused_at) : Date.now()) - Date.parse(run.started_at) - (run.paused_ms || 0)) : 0;
  const per = cur > 0 ? active / cur : null, remain = per != null ? per * (steps.length - cur) : null;
  return { list, cur, total: steps.length, active, per, remain, finishAt: remain != null && run?.status === 'running' ? Date.now() + remain : null };
}
export function stagesHtml(tl) {
  if (!tl) return '<div class="stg-empty">新建任务后，这里按“任务分配 → 讨论交流 → 写作初稿 → 对抗质询 → 打磨修改 → 整合汇总 → 集体评审 → 形成终稿”顺序显示研讨进程与预计完成时间。</div>';
  const eta = tl.cur >= tl.total ? `全部完成 · 用时 ${clock(tl.active)}` : tl.remain != null ? `已用 ${clock(tl.active)} · 预计还需 ${clock(tl.remain)}${tl.finishAt ? ` · 约 ${new Date(tl.finishAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 完成` : ''}` : '开始后按实际节奏预估完成时间';
  return `<ol class="stg">${tl.list.map((x, i) => `<li class="stg-${x.state}" title="${esc(`${x.name}：${x.done}/${x.total} 步${x.dur ? `，用时 ${clock(x.dur)}` : ''}`)}"><span class="stg-n">${x.state === 'done' ? '✓' : i + 1}</span><span class="stg-t"><b>${esc(x.name)}</b><small>${x.done}/${x.total}${x.dur ? ` · ${clock(x.dur)}` : ''}</small></span><i class="stg-bar"><em style="width:${x.total ? (x.done / x.total) * 100 : 0}%"></em></i></li>`).join('')}</ol>
    <div class="stg-eta" id="stg-eta">${eta}</div>`;
}
export function stageLogHtml(tl) {
  if (!tl) return '<div class="sw-empty"><p>开始研讨后记录每个阶段的起止时间、步数与发言数。</p></div>';
  const t = (ms) => (ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '—');
  return `<table class="data sw-log"><thead><tr><th>阶段</th><th>开始</th><th>结束</th><th>用时</th><th>步数</th><th>发言</th></tr></thead><tbody>${tl.list.map((x) => `<tr class="stg-${x.state}"><td><b>${esc(x.name)}</b></td><td>${t(x.start)}</td><td>${t(x.end)}</td><td>${x.dur ? clock(x.dur) : '—'}</td><td>${x.done}/${x.total}</td><td>${x.events}</td></tr>`).join('')}</tbody></table>
    <p class="small faint">共 ${tl.total} 步，已完成 ${tl.cur} 步；有效用时 ${clock(tl.active)}（已扣除暂停）${tl.per ? `，平均每步 ${(tl.per / 1000).toFixed(1)} 秒` : ''}。预计完成时间按已完成步骤的平均用时推算。</p>`;
}

/** 协同核心三行状态：正在研讨 / 当前焦点 / 当前问题（都来自真实编排与事件） */
export function coreStatus({ run, plan, cursor, events, working, names, challenges = [], job }) {
  if (!run) return { lines: [['', job ? '任务准备中' : '共研优质课堂'], ['', job ? '等待进入研讨环节' : '新建任务后开始研讨']] };
  const steps = plan?.steps || [], st = steps[Math.min(cursor ?? 0, Math.max(0, steps.length - 1))];
  const kp = st?.kp && (working?.knowledge || []).find((k) => k.id === st.kp);
  const sec = st?.section && (working?.sections || []).find((s) => s.key === st.section);
  const topic = run.status === 'completed' ? '研讨已完成' : kp ? `知识点「${kp.term}」` : sec ? sec.title : '研讨准备';
  const last = events.at(-1);
  const focus = last ? `${last.actor_type === 'human' ? '你' : names[last.actor_id] || last.actor_id} · ${KIND_LABEL[last.kind] || last.kind}` : '尚未发言';
  const open = challenges.find((c) => !c.response_event_id);
  const gap = [...events].reverse().find(isEvidenceGap);
  const issue = open ? `${names[open.challenger] || open.challenger}质询待回应` : gap ? `证据待补充（${names[gap.actor_id] || '教师'}）` : '暂无待解决问题';
  return { lines: [['正在研讨', topic], ['当前焦点', focus], ['当前问题', issue]] };
}

// ---------- 任务进度 ----------
const JOB_ICON = { done: '✓', running: '●', pending: '', error: '!' };
export function phaseList(plan, cursor, runStatus, phasesName) {
  const steps = plan?.steps || [];
  const order = [...new Set(steps.map((s) => s.phase))];
  const cur = cursor ?? 0, done = runStatus === 'completed';
  return order.map((p) => {
    const first = steps.findIndex((s) => s.phase === p), lastIdx = steps.map((s) => s.phase).lastIndexOf(p);
    const state = done || cur > lastIdx ? 'done' : cur >= first ? 'running' : 'pending';
    return { key: p, name: phasesName[p] || p, state, n: steps.filter((s) => s.phase === p).length };
  });
}
export function progressHtml({ job, run, plan, cursor, working, names, seats, roles, phasesName, current }) {
  const course = job?.analysis?.course?.name || working?.course?.name || '';
  const nKp = job?.analysis?.stats?.knowledge_points ?? working?.knowledge?.length ?? 0;
  const exec = (job?.config?.exec_mode || run?.exec_mode) === 'model' ? '<span class="badge gold">大模型生成</span>' : (job || run) ? '<span class="badge">本地生成 · 不计费</span>' : '';
  const phases = run ? phaseList(plan, cursor, run.status, phasesName) : [];
  const steps = plan?.steps || [], st = run && run.status !== 'completed' ? steps[Math.min(cursor ?? 0, steps.length - 1)] : null;
  const kp = st?.kp && (working?.knowledge || []).find((k) => k.id === st.kp);
  const sec = st?.section && (working?.sections || []).find((s) => s.key === st.section);
  const nowLine = st ? `${esc(roles[seats[st.seat]]?.name || '')} · ${esc(KIND_LABEL[st.kind] || st.kind)}${kp ? `「${esc(kp.term)}」` : sec ? `「${esc(sec.title)}」` : ''}` : '';
  const phaseBlock = phases.length ? `<ol class="sw-sub">${phases.map((p) => `<li class="${p.state}">${esc(p.name)}${p.state === 'running' && nowLine ? `<span class="sw-now">当前：${nowLine} · 第 ${Math.min((cursor ?? 0) + 1, steps.length)}/${steps.length} 步</span>` : ''}</li>`).join('')}</ol>` : '';
  let list, done, total, head;
  if (job) {
    total = job.steps.length; done = job.steps.filter((s) => s.status === 'done').length;
    const stTxt = { running: ['cyan', '执行中'], paused: ['warn', '已暂停'], completed: ['green', '已完成'], failed: ['red', '出错'], cancelled: ['', '已取消'] }[job.status] || ['', job.status];
    head = `<span class="badge ${stTxt[0]}">${stTxt[1]}</span>`;
    list = `<ol class="sw-steps">${job.steps.map((s, i) => `<li class="${s.status}${s.status === 'running' ? ' open' : ''}"><span class="sw-si" aria-hidden="true">${JOB_ICON[s.status] ?? ''}</span><div><span class="sw-sn">${i + 1}</span><b>${esc(s.label)}</b><span class="sw-ss">${{ done: '已完成', running: '进行中', pending: '待开始', error: '出错' }[s.status] || s.status}</span>
      ${s.status === 'running' && run && job.current_run_id === run.run_id ? phaseBlock : ''}
      ${s.message && s.status !== 'pending' ? `<div class="sw-sm">${esc(s.message)}</div>` : ''}
      ${s.artifacts?.length ? `<div class="sw-arts">${s.artifacts.map((x) => `<a href="/library?id=${x.artifact_id}" data-link="/library?id=${x.artifact_id}">${esc(x.title)} · v${x.version}</a>`).join('')}</div>` : ''}
      ${s.key === 'classroom' && s.status === 'running' ? '<a class="small" href="/classroom" data-link="/classroom">去演课场观看 ›</a>' : ''}</div></li>`).join('')}</ol>
      <div class="sw-jobbtns">${job.status === 'running' ? '<button class="small" data-job="pause">暂停任务</button>' : ''}${['paused', 'failed'].includes(job.status) ? '<button class="small gold" data-job="resume">继续任务</button>' : ''}${['running', 'paused', 'failed'].includes(job.status) ? '<button class="small ghost" data-job="cancel">取消任务</button>' : ''}</div>
      ${job.error ? `<div class="notice small">${esc(job.error)}</div>` : ''}${job.status === 'completed' ? '<p class="small sw-ok">全部完成，成果已保存到产物库，请逐一审阅。</p>' : ''}`;
  } else if (run) {
    total = phases.length; done = phases.filter((p) => p.state === 'done').length;
    head = `<span class="badge ${run.status === 'running' ? 'cyan' : run.status === 'completed' ? 'green' : 'warn'}">${esc(STATUS_NAME[run.status] || run.status)}</span>`;
    list = `<ol class="sw-steps">${phases.map((p, i) => `<li class="${p.state === 'running' ? 'running open' : p.state}"><span class="sw-si" aria-hidden="true">${JOB_ICON[p.state === 'running' ? 'running' : p.state] ?? ''}</span><div><span class="sw-sn">${i + 1}</span><b>${esc(p.name)}</b><span class="sw-ss">${{ done: '已完成', running: '进行中', pending: '待开始' }[p.state]}</span>${p.state === 'running' && nowLine ? `<div class="sw-sm">当前：${nowLine}</div>` : ''}</div></li>`).join('')}</ol>`;
  } else {
    return `<div class="sw-empty"><h3>还没有研讨任务</h3><p>导入讲义、大纲或课件后，教研组会自动完成：解析课程内容 → 逐个知识点研讨（讲解、难点、思政融入、检测题、证据核查）→ 生成教案等成果 → 模拟上课 → 依据课堂反馈修订。</p>${current ? `<p class="small">当前产物：${esc(current.title)} · v${current.version}</p>` : ''}<button class="primary" data-act="new">导入课程内容，新建任务</button></div>`;
  }
  const accept = run?.status === 'completed' && run.output_artifact_id ? `<div class="sw-accept"><span>研讨已整合为草稿，请审阅后确认。</span><button class="small" data-link="/library?id=${run.output_artifact_id}">审阅 / 编辑草稿</button><button class="small gold" id="accept">确认为当前产物</button></div>` : '';
  return `${accept}<div class="sw-sum">${course ? `<div><span class="faint">课程</span> <b>${esc(course)}</b>${nKp ? ` · ${nKp} 个知识点` : ''}</div>` : ''}<div class="row" style="gap:6px">${head}${exec}</div></div>
    <div class="sw-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="已完成 ${done}/${total} 步"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
    <div class="sw-cnt"><b>${done}/${total}</b> 步完成</div>${list}`;
}

// ---------- 研讨成果（教学目标 · 思政要点 · 段落） ----------
const uniq = (arr) => [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
export function outcomeHtml(body, terms, { roles, artifactId } = {}) {
  if (!body?.sections?.length) return '<div class="sw-empty"><p>研讨开始后，这里会实时显示各段落的研讨成果。</p></div>';
  const goals = body.sections.find((s) => s.key === 'goals' && s.rows?.length);
  const ideo = body.sections.find((s) => s.key === 'ideology' && s.content);
  const G = [['知识', '知识目标', 'k'], ['能力', '能力目标', 'a'], ['价值', '育人目标', 'v']];
  const goalCards = goals ? `<div class="sw-goals">${G.map(([cat, title, c]) => { const items = uniq(goals.rows.filter((r) => r.category === cat).flatMap((r) => String(r.description || '').split(/[；;\n]/))); return items.length ? `<div class="sw-goal g-${c}"><b>${title}</b><ul>${items.slice(0, 4).map((t) => `<li>${hl(t, terms)}</li>`).join('')}</ul></div>` : ''; }).join('')}</div>` : '';
  const ideoTags = ideo ? terms.filter((t) => t.length >= 2 && ideo.content.includes(t)).slice(0, 6) : [];
  const ideoCard = ideo ? `<div class="sw-ideo"><b>思政要点 · 价值引领</b>${ideoTags.length ? `<div class="sw-tags">${ideoTags.map((t) => `<span class="tg ideo2">${esc(t)}</span>`).join('')}</div>` : ''}<p>${hl(uniq(ideo.content.split('\n')).slice(0, 2).join('；').slice(0, 180), terms)}${ideo.content.length > 180 ? '…' : ''}</p></div>` : '';
  const list = `<ul class="sw-secs">${body.sections.map((s) => `<li><b>${esc(s.title)}</b><span class="faint">${esc(s.author || roles?.[s.owner_role]?.name || '')}</span>${s.revision ? `<span class="badge cyan">v${s.revision}</span>` : '<span class="badge">待起草</span>'}</li>`).join('')}</ul>`;
  return `${goalCards}${ideoCard}${list}${artifactId ? `<a class="small" href="/library?id=${artifactId}" data-link="/library?id=${artifactId}">在产物库中打开完整内容 ›</a>` : ''}`;
}
