// 演课场渲染组件（纯函数：输入真实运行数据，输出 HTML）。
// 课堂实况（重点事件）· 课堂实时数据（6 项指标 + 小组活跃度）· 教师 + 8 个学习小组 · 当前关注 · 发言队列 · 思政要点。
// 学生与小组状态全部由事件、举手队列、小组讨论阶段推导；没有来源的数字一律不显示。
import { esc, hl, fmtTime } from './ui.js';
import { humanBadge } from './portraits.js';
import { studentAvatar, teacherAvatar } from './avatar3d.js';
import { isIdeo } from './stage.js';

export const gName = (g) => `第${String(g || '').replace(/^G/, '')}组`;
const clip = (t, n) => { t = String(t || ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
export const teacherAva = () => `<span class="cl-ava t">${teacherAvatar('subject', { crop: true })}</span>`;
export const stuAva = (s, cls = '') => `<span class="cl-ava ${cls}">${s ? studentAvatar(s.seat ?? 0, s.gender || s.traits?.gender, { crop: true }) : ''}</span>`;
const humanAva = () => `<span class="cl-ava h">${humanBadge()}</span>`;

// ---------- 事件分类 ----------
const T_TAG = { lecture: '讲授', recap: '回顾', question: '教师提问', follow_up: '追问', respond: '回应', redirect: '教师引导', defer: '暂存问题', organize: '教师引导', start_group: '小组讨论', start_debate: '组间辩论', summarize_groups: '小结', summary: '小结', conclude: '总结', transition: '过渡' };
const S_TAG = { question: '提问', clarify: '提问', challenge: '质疑', reflect: '反思', reflection: '反思', report: '小组汇报', answer_peer: '回应', supplement: '补充', response: '回应', answer_teacher: '回答' };
export function eventTags(e) {
  const tags = [];
  if (e.actor_type === 'human') tags.push(['h', e.human_role === 'student' ? '真人学生' : '真人教师']);
  else if (e.actor_id === 'T') tags.push(['t', T_TAG[e.kind] || '教师']);
  else if (e.actor_type === 'system') tags.push(['s', e.kind === 'silence' ? '沉默思考' : '课堂']);
  else tags.push([e.kind === 'challenge' ? 'q' : e.kind === 'report' ? 'g' : 's', S_TAG[e.kind] || '发言']);
  if (isIdeo(e)) tags.push(['i', '思政触发']);
  if (/《[^》]{1,40}》/.test(e.text || '')) tags.push(['e', '证据调用']);
  return tags;
}
const tagHtml = (tags) => tags.map(([c, l]) => `<span class="ct ct-${c}">${esc(l)}</span>`).join('');
const whoOf = (e, names, prof) => (e.actor_type === 'human' ? `你（${e.human_role === 'student' ? '学生角色' : '教师角色'}）` : e.actor_id === 'T' ? (names.T || '任课教师') : e.actor_type === 'system' ? '课堂' : `${names[e.actor_id] || e.actor_id}${prof[e.actor_id]?.group_id ? ` · ${gName(prof[e.actor_id].group_id)}` : ''}`);
const avaOf = (e, prof) => (e.actor_type === 'human' ? humanAva() : e.actor_id === 'T' ? teacherAva() : e.actor_type === 'system' ? '<span class="cl-ava s">…</span>' : stuAva(prof[e.actor_id]));

// ---------- 学生与小组状态 ----------
export const STATE_LABEL = { speaking: '发言中', hand: '举手', questioning: '提问', challenging: '质疑', discussing: '小组讨论', thinking: '思考中', reflecting: '反思', silent: '未发言', listening: '听讲' };
/** @returns Map<id, {id,name,group,avatar,spoke,lastText,lastKind,status,rep,repliedByTeacher}> */
export function studentStates({ profiles, events, pending = [], thinking = [], groupsActive = [], phase, speakingId }) {
  const studs = profiles.filter((p) => p.kind === 'student_agent');
  const recent = events.slice(-8), started = events.filter((e) => e.actor_id === 'T').length >= 2;
  const replied = new Set(events.filter((e) => e.actor_id === 'T' && e.reply_to).map((e) => e.reply_to));
  const out = new Map();
  for (const s of studs) {
    const mine = events.filter((e) => e.actor_id === s.agent_id), last = mine.at(-1);
    const recentMine = recent.filter((e) => e.actor_id === s.agent_id).at(-1);
    let status = 'listening';
    if (speakingId === s.agent_id) status = 'speaking';
    else if (pending.includes(s.agent_id)) status = 'hand';
    else if (recentMine && ['challenge'].includes(recentMine.kind)) status = 'challenging';
    else if (recentMine && ['question', 'clarify'].includes(recentMine.kind)) status = 'questioning';
    else if (['group', 'debate'].includes(phase) && groupsActive.includes(s.group_id)) status = 'discussing';
    else if (thinking.includes(s.agent_id)) status = 'thinking';
    else if (recentMine && ['reflect', 'reflection'].includes(recentMine.kind)) status = 'reflecting';
    else if (!mine.length && started) status = 'silent';
    out.set(s.agent_id, { id: s.agent_id, name: s.name, group: s.group_id, avatar: s.avatar, seat: s.seat, gender: s.traits?.gender, code: s.traits?.profile_code || null, traits: s.traits, spoke: mine.length, lastText: last?.text || '', lastKind: last?.kind || '', status, repliedByTeacher: mine.some((e) => replied.has(e.event_id)), rep: mine.some((e) => e.kind === 'report') });
  }
  return out;
}
export function groupStates(stu, { events, groupsActive = [], phase, lastEv }) {
  const groups = new Map();
  for (const s of stu.values()) { if (!groups.has(s.group)) groups.set(s.group, []); groups.get(s.group).push(s); }
  const evByGroup = {}; for (const e of events) { const g = stu.get(e.actor_id)?.group; if (g) evByGroup[g] = (evByGroup[g] || 0) + 1; }
  return [...groups.entries()].map(([g, members]) => {
    const speaking = members.find((m) => m.status === 'speaking'), hands = members.filter((m) => m.status === 'hand').length;
    const spoke = members.filter((m) => m.spoke).length;
    const reporting = speaking && lastEv?.kind === 'report';
    const discussing = ['group', 'debate'].includes(phase) && groupsActive.includes(g);
    const status = reporting ? ['report', '正在汇报'] : speaking ? ['speaking', '发言中'] : discussing ? ['discussing', '讨论中'] : hands ? ['hand', `${hands} 人举手`] : !spoke && events.length > 6 ? ['silent', '暂未发言'] : spoke ? ['done', `${spoke} 人发过言`] : ['idle', '听讲'];
    const rep = speaking || members.find((m) => m.status === 'hand') || [...members].sort((a, b) => b.spoke - a.spoke)[0];
    return { id: g, name: gName(g), members, rep, others: members.filter((m) => m !== rep), status, hands, spoke, events: evByGroup[g] || 0, thinking: members.filter((m) => m.status === 'thinking').length };
  }).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

// ---------- 课堂实况 ----------
export function liveHtml({ events, names, profiles, terms, streaming, showAll }) {
  const prof = Object.fromEntries(profiles.map((p) => [p.agent_id, p]));
  const talk = events.filter((e) => e.actor_type !== 'system');
  const isTeacher = (e) => e.actor_id === 'T' || (e.actor_type === 'human' && e.human_role !== 'student');
  const lastStu = [...talk].reverse().find((e) => !isTeacher(e));
  const lastT = [...talk].reverse().find(isTeacher);
  const speaker = streaming ? `<div class="cl-now live">${streaming.actor_id === 'T' ? teacherAva() : stuAva(prof[streaming.actor_id], 'pulse')}<div><div class="cl-nh"><b>${esc(streaming.actor_id === 'T' ? '任课教师' : whoOf({ actor_id: streaming.actor_id, actor_type: 'agent' }, names, prof))}</b><span class="ct ct-live">正在发言</span></div><p id="stream-text"></p></div></div>`
    : lastStu ? `<div class="cl-now">${avaOf(lastStu, prof)}<div><div class="cl-nh"><b>${esc(whoOf(lastStu, names, prof))}</b>${tagHtml(eventTags(lastStu))}</div><p>${hl(lastStu.text, terms)}</p></div></div>` : '';
  const guide = lastT ? `<div class="cl-guide">${lastT.actor_type === 'human' ? humanAva() : teacherAva()}<div><div class="cl-nh"><b>${lastT.actor_type === 'human' ? '你（教师角色）' : '任课教师'}</b>${tagHtml(eventTags(lastT))}</div><p>${hl(clip(lastT.text, 160), terms)}</p></div></div>` : '';
  const shown = new Set([lastStu?.event_id, lastT?.event_id]);
  const rest = (showAll ? events : events.filter((e) => !shown.has(e.event_id) && e.kind !== 'silence').slice(-4)).slice().reverse();
  const list = rest.map((e) => `<li class="cl-ev${showAll ? '' : ' fresh'}"><span class="cl-evw">${esc(whoOf(e, names, prof))}</span>${tagHtml(eventTags(e))}<span class="cl-evt">${hl(showAll ? e.text : clip(e.text, 90), terms)}</span></li>`).join('');
  return `${speaker || (!streaming && !lastStu && !lastT ? '<div class="cl-empty">尚未开始上课。点击右上角“开始上课”，任课教师将按教案推进，40 位学生智能体在 8 个小组中自主参与。</div>' : '')}${guide}
    ${rest.length ? `<ol class="cl-evs${showAll ? ' all' : ''}" id="feed">${list}</ol>` : '<ol class="cl-evs" id="feed"></ol>'}`;
}

// ---------- 课堂实时数据 ----------
export function metricsHtml({ stu, groups, events, pending, phase, clockText, run }) {
  const studs = [...stu.values()], n = studs.length;
  const spokeN = studs.filter((s) => s.spoke).length;
  const stuEv = events.filter((e) => stu.has(e.actor_id));
  const qc = stuEv.filter((e) => ['question', 'clarify', 'challenge'].includes(e.kind)).length;
  const disc = groups.filter((g) => g.status[0] === 'discussing' || g.status[0] === 'report').length;
  const inGroupPhase = ['group', 'debate', 'report'].includes(phase);
  const M = [
    ['参与学生', n ? `${spokeN}/${n}` : '—', n ? `已发言 ${Math.round((spokeN / n) * 100)}%` : ''],
    ['讨论中小组', inGroupPhase ? `${disc}/${groups.length}` : '—', inGroupPhase ? '小组讨论环节' : '全班授课中'],
    ['学生发言', stuEv.length, '次'],
    ['举手等待', pending.length, pending.length ? '人排队' : '无人排队'],
    ['提问 · 质疑', qc, '次'],
    ['课堂用时', clockText || '—', '模拟课时'],
  ];
  const max = Math.max(1, ...groups.map((g) => g.events));
  return `<div class="cl-metrics">${M.map(([k, v, s]) => `<div class="cl-m"><b>${esc(String(v))}</b><span>${esc(k)}</span>${s ? `<small>${esc(s)}</small>` : ''}</div>`).join('')}</div>
    <div class="cl-act"><div class="cl-act-h"><b>小组活跃度</b><span>按本节课各组发言次数</span></div>${groups.length ? groups.map((g) => `<button type="button" class="cl-bar" data-group="${g.id}"><span>${g.name}</span><i><em style="width:${(g.events / max) * 100}%"></em></i><span>${g.events} 次</span></button>`).join('') : '<p class="cl-empty small">开课后显示</p>'}</div>
    ${run ? `<p class="cl-note">计数来自本节课的模拟事件，不代表正确率或学习成效。seed：<span class="mono">${esc(run.seed || '')}</span></p>` : ''}`;
}

// ---------- 教师 + 8 个小组 ----------
const dot = (s) => `<i class="sd sd-${s.status}" title="${esc(`${s.name}：${STATE_LABEL[s.status]}`)}"></i>`;
export function groupCardHtml(g, { expanded } = {}) {
  const r = g.rep;
  return `<button type="button" class="cl-group gs-${g.status[0]}" data-group="${g.id}" aria-label="${esc(`${g.name}，${g.members.length} 人，${g.status[1]}。查看小组详情`)}">
    <span class="cl-gh"><b>${g.name}</b><small>${g.members.length}人</small><span class="cl-gst">${esc(g.status[1])}</span></span>
    ${expanded ? `<span class="cl-gm">${g.members.map((m) => `<span class="cl-mem st-${m.status}">${stuAva(m)}<small>${esc(m.name.replace('学生', ''))}</small><em>${STATE_LABEL[m.status]}</em></span>`).join('')}</span>`
      : `<span class="cl-grep">${stuAva(r, `st-${r?.status}`)}${r?.status === 'hand' ? '<span class="cl-hand" aria-hidden="true">✋</span>' : ''}<span class="cl-grn"><b>${esc(r?.name || '')}</b><small>${esc(STATE_LABEL[r?.status] || '')}</small></span>
        <span class="cl-dots" aria-label="其余成员状态">${g.others.map(dot).join('')}</span></span>`}
    <span class="cl-gf">发言 ${g.events} 次${g.hands ? ` · ${g.hands} 人举手` : ''}${g.thinking ? ` · ${g.thinking} 人思考` : ''}</span></button>`;
}
export function teacherHtml(lastT, streaming, tName) {
  const s = streaming?.actor_id === 'T' ? '讲话中' : !lastT ? '准备上课' : { lecture: '讲授中', recap: '回顾中', question: '提问中', follow_up: '追问中', respond: '回应中', redirect: '引导中', defer: '记录问题', start_group: '巡视小组', start_debate: '组织辩论', summarize_groups: '小结中', conclude: '总结中' }[lastT.kind] || '观察中';
  return `<div class="cl-teacher${streaming?.actor_id === 'T' ? ' speaking' : ''}">${teacherAva()}<div><b>${esc(tName || '任课教师（AI）')}</b><small>${esc(s)}</small></div></div>`;
}

// ---------- 当前关注 ----------
export function focusList(stu, events) {
  const studs = [...stu.values()], out = [];
  const add = (s, why, cls) => { if (s && !out.some((x) => x.s.id === s.id) && out.length < 6) out.push({ s, why, cls }); };
  add(studs.find((s) => s.status === 'speaking'), '当前发言', 'speaking');
  studs.filter((s) => s.status === 'hand').slice(0, 2).forEach((s) => add(s, '举手等待', 'hand'));
  const lastCh = [...events].reverse().find((e) => e.kind === 'challenge' && stu.has(e.actor_id)); add(lastCh && stu.get(lastCh.actor_id), '提出质疑', 'challenging');
  const replied = studs.filter((s) => s.repliedByTeacher).sort((a, b) => b.spoke - a.spoke)[0]; add(replied, '观点引发教师回应', 'good');
  studs.filter((s) => s.status === 'silent').sort((a, b) => (a.traits?.expressiveness ?? 0) - (b.traits?.expressiveness ?? 0)).slice(0, 1).forEach((s) => add(s, '尚未发言', 'silent'));
  return out;
}
export function focusHtml(list) {
  return list.length ? list.map(({ s, why, cls }) => `<button type="button" class="cl-focus f-${cls}" data-stu="${s.id}">${stuAva(s)}<span><b>${esc(s.name)}</b><small>${esc(why)} · ${gName(s.group)}</small></span></button>`).join('') : '<span class="cl-empty small">开课后，这里会标出正在发言、举手、提出质疑、尚未发言等需要关注的学生。</span>';
}

// ---------- 发言队列 / 思政要点 / 小组详情 ----------
export function queueHtml({ stu, pending, speakingId }) {
  const s = speakingId && stu.get(speakingId);
  const row = (x, lab) => `<li>${stuAva(x)}<span><b>${esc(x.name)}</b><small>${lab} · ${gName(x.group)}</small></span><button type="button" class="small ghost" data-call="${x.id}">点名</button></li>`;
  return `<div class="cl-queue"><div><h4>当前发言</h4>${s ? `<ul>${row(s, '发言中')}</ul>` : '<p class="cl-empty small">暂无学生发言</p>'}</div>
    <div><h4>举手等待（按系统排队顺序）</h4>${pending.length ? `<ol>${pending.map((id, i) => stu.get(id) && row(stu.get(id), i ? '等待' : '下一位')).join('')}</ol>` : '<p class="cl-empty small">暂无举手学生</p>'}
    <p class="cl-note">可点名任一学生插队发言；排队顺序由调度器决定，暂不支持手动调整或取消。</p></div></div>`;
}
export function ideologyHtml(events, { names, profiles, terms }) {
  const prof = Object.fromEntries(profiles.map((p) => [p.agent_id, p]));
  const list = events.filter(isIdeo);
  if (!list.length) return '<p class="cl-empty">本节课尚未出现课程思政相关表述。思政要点应在专业讨论中自然产生，出现后会在这里列出并注明来源。</p>';
  const byTerm = new Map();
  for (const e of list) for (const t of (terms.filter((x) => x && (e.text || '').includes(x)).slice(0, 3))) { if (!byTerm.has(t)) byTerm.set(t, []); byTerm.get(t).push(e); }
  return `<p class="cl-note" style="margin-top:0">按课程思政元素词表匹配课堂发言，仅提示关注点；每一条都可追溯到原发言。</p>
    ${[...byTerm.entries()].map(([t, es]) => `<div class="cl-ideo"><b>${esc(t)}</b><span class="faint small">${es.length} 处</span>${es.slice(-3).reverse().map((e) => `<blockquote><cite>${esc(whoOf(e, names, prof))} · ${esc(fmtTime(e.time).split(' ').pop() || '')}</cite>${hl(clip(e.text, 120), terms)}</blockquote>`).join('')}</div>`).join('')}`;
}
export function groupDetailHtml(g, { events, terms }) {
  return `<table class="data cl-gd"><thead><tr><th>学生</th><th>当前状态</th><th>发言</th><th>最近观点</th><th>需关注</th><th></th></tr></thead><tbody>
    ${g.members.map((m) => `<tr><td><span class="row" style="gap:8px;flex-wrap:nowrap">${stuAva(m)}<b>${esc(m.name)}</b></span></td><td><span class="cl-st st-${m.status}">${STATE_LABEL[m.status]}</span></td><td>${m.spoke} 次</td>
      <td class="small">${m.lastText ? hl(clip(m.lastText, 70), terms) : '<span class="faint">—</span>'}</td><td>${m.status === 'silent' ? '<span class="badge warn">尚未发言</span>' : m.status === 'challenging' ? '<span class="badge">提出质疑</span>' : ''}</td>
      <td><button type="button" class="small" data-call="${m.id}">点名</button></td></tr>`).join('')}</tbody></table>
    <p class="cl-note">小组发言共 ${g.events} 次；状态由最近的课堂事件、举手队列和小组讨论环节推导。${events.length ? '' : ''}</p>`;
}
