// Shared run controller for 研课场 / 演课场: autoplay with SSE streaming, pause, cursor recovery,
// and the translucent bottom-right composer (no dimmed backdrop).
import { get, post, key, stepStream } from './api.js';
import { esc, $, toast, fail, fmtMs, STATUS_NAME, SOURCE_NAME, hl } from './ui.js';

// Model-side failures that retrying will not fix; the page offers switching to 模拟演示 instead of a bare toast.
export const MODEL_FAIL = ['bad_request', 'auth_failed', 'model_unsupported', 'provider_quota', 'no_model_config', 'missing_key', 'model_disabled'];

export function createController({ runId, hooks, refreshMe }) {
  const c = { run: null, view: null, events: [], seen: new Set(), playing: false, busy: false, stopped: false, lastSeq: 0 };
  c.load = async () => {
    const v = await get(`/api/runs/${runId}`);
    c.view = v; c.run = v.run; c.events = []; c.seen.clear();
    for (const e of v.events) c.add(e, false);
    hooks.onLoad?.(v); hooks.onState?.(c.run);
    return v;
  };
  c.add = (e, live = true) => {
    if (c.seen.has(e.event_id)) return false; // dedupe after reconnect
    c.seen.add(e.event_id); c.events.push(e); c.lastSeq = Math.max(c.lastSeq, e.sequence);
    hooks.onEvent?.(e, live); return true;
  };
  c.resync = async () => {
    const v = await get(`/api/runs/${runId}?after=${c.lastSeq}`);
    c.run = v.run; for (const e of v.events) c.add(e, true); hooks.onState?.(c.run); hooks.onResync?.(v);
  };
  c.step = async () => {
    if (c.busy) return 'busy';
    c.busy = true;
    try {
      const r = await stepStream(runId, {
        start: (d) => hooks.onStart?.(d),
        delta: (d) => hooks.onDelta?.(d),
        final: (d) => { c.add(d.event, true); hooks.onFinal?.(d); },
        end: (d) => hooks.onEnd?.(d),
        error: (d) => hooks.onError?.(d),
      }, key('step'));
      if (r.type === 'error') {
        if (MODEL_FAIL.includes(r.data.code) && hooks.onModelError) hooks.onModelError(r.data);
        else if (['budget_exhausted'].includes(r.data.code)) toast(r.data.message, true);
        else if (r.data.code !== 'step_in_progress') toast(`${r.data.message}${r.data.retryable ? '（未扣分，可重试）' : ''}`, true);
        await c.resync().catch(() => {});
        return 'error';
      }
      if (r.type === 'end') { await c.resync(); return 'end'; }
      if (r.type === 'none') { await c.resync(); return 'error'; } // stream dropped: recover by cursor
      if (c.run?.exec_mode === 'model') refreshMe();
      return 'ok';
    } catch (e) { await c.resync().catch(() => {}); fail(e); return 'error'; } finally { c.busy = false; }
  };
  c.play = async () => {
    if (c.playing) return;
    try {
      if (c.run.status === 'ready') { c.run = await post(`/api/runs/${runId}/start`); if (c.run.exec_mode === 'model') refreshMe(); }
      else if (c.run.status === 'paused') c.run = await post(`/api/runs/${runId}/resume`);
    } catch (e) { return fail(e); }
    const token = (c.loop = (c.loop || 0) + 1); // a newer play() supersedes any loop still sleeping
    c.playing = true; hooks.onState?.(c.run); hooks.onPlay?.(true);
    while (c.playing && !c.stopped && c.loop === token) {
      while (c.busy) await new Promise((res) => setTimeout(res, 100));
      const r = await c.step();
      if (c.loop !== token) return;
      if (r !== 'ok') { c.playing = false; break; }
      // interruptible wait; the delay is re-read every slice so a speed change applies immediately
      const t0 = Date.now();
      while (c.playing && !c.stopped && c.loop === token) {
        const need = hooks.delay ? hooks.delay() : c.run.exec_mode === 'model' ? 500 : 1500;
        if (Date.now() - t0 >= need) break;
        await new Promise((res) => setTimeout(res, 150));
      }
    }
    if (c.loop !== token) return;
    c.playing = false; hooks.onPlay?.(false); hooks.onState?.(c.run);
  };
  c.pause = async () => {
    c.playing = false; hooks.onPlay?.(false);
    try { if (['running', 'awaiting_human'].includes(c.run.status)) c.run = await post(`/api/runs/${runId}/pause`); hooks.onState?.(c.run); } catch (e) { fail(e); }
  };
  c.single = async () => {
    try {
      if (c.run.status === 'ready') c.run = await post(`/api/runs/${runId}/start`);
      else if (c.run.status === 'paused') c.run = await post(`/api/runs/${runId}/resume`);
      hooks.onState?.(c.run);
      const res = await c.step(); await c.resync(); return res;
    } catch (e) { fail(e); return 'error'; }
  };
  c.finish = async () => { c.playing = false; try { c.run = await post(`/api/runs/${runId}/finish`); hooks.onState?.(c.run); refreshMe(); } catch (e) { fail(e); } };
  // watch mode: the server executes the run (task pipeline); the page only follows it by cursor
  c.watch = () => {
    c.watching = true;
    clearInterval(c.watchTimer);
    c.watchTimer = setInterval(async () => {
      if (c.watchBusy || c.stopped) return;
      c.watchBusy = true;
      try { await c.resync(); if (['completed', 'cancelled', 'failed'].includes(c.run?.status)) clearInterval(c.watchTimer); } catch { /* transient */ } finally { c.watchBusy = false; }
    }, 700);
  };
  c.dispose = () => { c.stopped = true; c.playing = false; clearInterval(c.watchTimer); };
  return c;
}

/** Floating "参与…" button + translucent composer. Background stays visible (no overlay, no blur of the page). */
export function mountComposer({ label, roles, kinds, targets, onOpen, onClose, onSubmit }) {
  const btn = document.createElement('button');
  btn.className = 'participate primary'; btn.textContent = label; btn.setAttribute('aria-expanded', 'false');
  const box = document.createElement('div');
  box.className = 'composer'; box.hidden = true; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', label);
  box.innerHTML = `<h4>${esc(label)} · 真人发言</h4>
    <div class="row" style="gap:6px;margin-bottom:6px">${roles ? `<select id="cp-role" style="width:auto" aria-label="发言身份">${roles.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>` : ''}
    <select id="cp-kind" style="width:auto" aria-label="发言类型">${kinds.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    <select id="cp-target" style="width:auto;max-width:160px" aria-label="发言对象"></select></div>
    <textarea id="cp-text" placeholder="输入发言，Ctrl+Enter 发送"></textarea>
    <div class="row" style="margin-top:8px"><span class="small faint" id="cp-hint">输入期间自动演示暂停，发送后继续</span><span class="grow"></span><button class="ghost small" id="cp-close">收起</button><button class="primary small" id="cp-send">发送</button></div>`;
  document.body.append(btn, box);
  let openedAt = null, draft = '';
  const fillTargets = () => { $('#cp-target', box).innerHTML = `<option value="">对全体</option>${targets().map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('')}`; };
  const open = async () => { fillTargets(); box.hidden = false; btn.setAttribute('aria-expanded', 'true'); openedAt = new Date().toISOString(); $('#cp-text', box).value = draft; $('#cp-text', box).focus(); await onOpen?.(); };
  const close = async () => { draft = $('#cp-text', box).value; box.hidden = true; btn.setAttribute('aria-expanded', 'false'); await onClose?.(); };
  const send = async () => {
    const text = $('#cp-text', box).value.trim(); if (!text) return;
    const btnSend = $('#cp-send', box); btnSend.disabled = true;
    try {
      await onSubmit({ text, human_role: $('#cp-role', box)?.value, kind: $('#cp-kind', box).value, target_actor: $('#cp-target', box).value || null, composer_opened_at: openedAt, idempotency_key: key('human') });
      draft = ''; $('#cp-text', box).value = '';
      await close(); // hand control back: the run resumes (and autoplay continues if it was on) so agents respond
    } catch (e) { fail(e); } finally { btnSend.disabled = false; }
  };
  btn.addEventListener('click', () => (box.hidden ? open() : close()));
  $('#cp-close', box).addEventListener('click', close);
  $('#cp-send', box).addEventListener('click', send);
  $('#cp-text', box).addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); if (e.key === 'Escape') close(); });
  return { btn, box, isOpen: () => !box.hidden, setEnabled: (on) => { btn.disabled = !on; btn.title = on ? '' : '请先开始一次运行'; }, remove: () => { if (!box.hidden) { box.hidden = true; onClose?.(); } btn.remove(); box.remove(); } };
}

export const KIND_LABEL = { explain: '讲解', difficulty: '难点与误区', ideology_link: '思政融入', item: '检测题', source_check: '核查', decision: '定稿', review: '材料研读', assign: '分派', poll: '轮询', draft: '起草', challenge: '质疑', response: '回应', revision: '修订', question: '提问', report: '汇报', integrate: '整合', lecture: '讲授', clarify: '请求澄清', supplement: '补充', reflection: '反思', silence: '沉默', defer: '暂存', redirect: '引导', organize: '组织', summary: '小结', observation: '观察' };
export const isIdeo = (e) => !!e.ideology_terms && e.ideology_terms !== '[]' && e.ideology_terms !== 'null';
export function feedItem(e, names, terms = []) {
  const who = e.actor_type === 'human' ? `真人（${e.human_role === 'student' ? '学生角色' : '教师角色'}）` : names[e.actor_id] || e.actor_id;
  const cls = `${e.actor_type === 'human' ? 'human' : e.actor_type === 'system' || e.source === 'system' ? 'sys' : ''}${isIdeo(e) ? ' ideo' : ''}`;
  return `<div class="item ${cls}"><div class="meta"><b>${esc(who)}</b><span>#${e.sequence}</span><span>${esc(KIND_LABEL[e.kind] || e.kind)}</span><span>${SOURCE_NAME[e.source] || e.source}</span>${e.reply_to ? '<span>↩ 回应</span>' : ''}${e.group_id ? `<span>${esc(e.group_id)}</span>` : ''}${isIdeo(e) ? '<span class="ideo-flag">思政</span>' : ''}</div>${hl(e.text, terms)}</div>`;
}
export function subtitleHtml(e, names, terms = []) {
  const human = e.actor_type === 'human', sys = e.source === 'system' || e.actor_type === 'system';
  const who = human ? `真人（${e.human_role === 'student' ? '学生角色' : '教师角色'}）` : names[e.actor_id] || e.actor_id;
  const tag = human ? '真人输入' : e.source === 'model' ? 'AI·模型' : e.source === 'demo' ? `本地生成${KIND_LABEL[e.kind] ? `·${KIND_LABEL[e.kind]}` : ''}` : '系统';
  return `<span class="who ${human ? 'human' : sys ? 'sys' : 'ai'}">${esc(who)} · ${tag}</span>${isIdeo(e) ? '<span class="ideo-flag">课程思政</span> ' : ''}${hl(e.text, terms)}`;
}
const STOP_NAME = { plan_completed: '编排完成', teacher_finish: '教师结束', stages_completed: '教学阶段完成', turn_limit: '达到轮次上限', time_limit: '到点下课', budget_exhausted: '预算用尽', server_restart: '服务重启后暂停', stale_released: '长时间无操作', account_disabled: '账号停用', cancelled: '已取消', completed: '已完成', job_cancelled: '任务已取消', legacy_migration: '旧版数据迁移', restored: '由备份恢复', teacher_pause: '教师暂停', class_time_over: '到点下课', job_paused: '任务暂停' };
export const stopName = (r) => STOP_NAME[r] || r;
export function statusBadge(run) {
  if (!run) return '';
  return `<span class="badge ${run.status === 'running' ? 'cyan' : run.status === 'completed' ? 'green' : 'warn'}">${STATUS_NAME[run.status] || run.status}${run.stop_reason && run.status !== 'running' ? ` · ${esc(stopName(run.stop_reason))}` : ''}</span>
    <span class="badge ${run.exec_mode === 'model' ? 'gold' : ''}">${run.exec_mode === 'model' ? `真实模型 · 已用 ${run.model_calls}/${run.budget_calls} 次` : '本地生成 · 不计费'}</span>`;
}
export const activeMs = (run) => (run?.started_at ? ((run.ended_at ? Date.parse(run.ended_at) : run.paused_at ? Date.parse(run.paused_at) : Date.now()) - Date.parse(run.started_at) - (run.paused_ms || 0)) : 0);
export { fmtMs };
