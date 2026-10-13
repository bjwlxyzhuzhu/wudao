// Small UI helpers: escaping, modal, toast, form reading.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, error = false) {
  const box = document.getElementById('toast');
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`; el.textContent = msg; el.setAttribute('role', error ? 'alert' : 'status');
  box.appendChild(el); setTimeout(() => el.remove(), error ? 6000 : 3200);
}
export const fail = (e) => toast(e?.message || String(e), true);

/** Modal returning a promise. buttons: [{label, value, cls}] */
export function modal({ title, body, buttons = [{ label: '关闭', value: null }], wide = false, onMount }) {
  return new Promise((resolve) => {
    const back = document.createElement('div'); back.className = 'modal-back';
    back.innerHTML = `<div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mt"><h3 id="mt">${esc(title)}</h3><div class="mbody">${body}</div><div class="actions">${buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ''}">${esc(b.label)}</button>`).join('')}</div></div>`;
    const prev = document.activeElement;
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });
    back.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', async () => {
      const def = buttons[+b.dataset.i];
      if (def.handler) { try { const r = await def.handler(back); if (r === false) return; close(r ?? def.value); } catch (e) { fail(e); } return; }
      close(def.value);
    }));
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    onMount?.(back);
    (back.querySelector('.actions button.primary, .actions button.gold') || back.querySelector('.actions button'))?.focus();
  });
}
export const confirmBox = (title, body, okLabel = '确认', cls = 'primary') => modal({ title, body, buttons: [{ label: '取消', value: false }, { label: okLabel, value: true, cls }] });

export function formData(root) {
  const out = {};
  root.querySelectorAll('[name]').forEach((el) => {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'number') out[el.name] = el.value === '' ? '' : Number(el.value);
    else out[el.name] = el.value;
  });
  return out;
}
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
export const fmtMs = (ms) => { if (ms == null) return '—'; const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const TYPE_NAME = { talent_plan: '人才培养方案（课程思政融入）', course_design: '课程教学设计', teaching_schedule: '教学计划进度表', syllabus: '思政版教学大纲', semester_plan: '学期教学设计', lesson_plan: '单课教案', courseware: '课程思政课件', exercises: '模拟练习', exam: '模拟试卷', reflection_report: '教学反思报告', classroom_feedback: '课堂反馈', knowledge_map: '课程知识点与思政融入图谱', legacy_plan: '旧版方案（迁移）' };
export const MODULE_NAME = { seminar: '研课场', classroom: '演课场' };
export const STATUS_NAME = { ready: '待开始', running: '进行中', paused: '已暂停', awaiting_human: '真人输入中', completed: '已完成', cancelled: '已取消', failed: '失败' };
export const SOURCE_NAME = { demo: '本地生成', model: '真实模型', human_input: '真人', system: '系统编排', manual_observation: '人工观察' };

/** Escape text and emphasise 课程思政 terms (longest match first). */
export function hl(text, terms = []) {
  const s = String(text ?? '');
  if (!terms.length) return esc(s);
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  let out = '', i = 0;
  for (const m of s.matchAll(re)) { out += esc(s.slice(i, m.index)) + `<mark class="ideo">${esc(m[0])}</mark>`; i = m.index + m[0].length; }
  return out + esc(s.slice(i));
}

/**
 * First-visit floating annotations. steps: [{sel, title, text, place}] ; shown once per `key` (per browser),
 * replayable via force=true. The page stays visible (light scrim only around the target).
 */
export function tour(key, steps, { force = false } = {}) {
  try { if (!force && localStorage.getItem(`yz-tour-${key}`)) return; } catch { /* storage unavailable: show anyway */ }
  const list = steps.filter((st) => document.querySelector(st.sel));
  if (!list.length) return;
  let i = 0;
  const ring = document.createElement('div'); ring.className = 'tour-ring';
  const card = document.createElement('div'); card.className = 'tour-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
  document.body.append(ring, card);
  const done = () => { ring.remove(); card.remove(); window.removeEventListener('resize', place); document.removeEventListener('keydown', onKey); try { localStorage.setItem(`yz-tour-${key}`, '1'); } catch { /* ignore */ } };
  const onKey = (e) => { if (e.key === 'Escape') done(); if (e.key === 'ArrowRight' || e.key === 'Enter') next(); };
  const next = () => { i++; if (i >= list.length) done(); else place(); };
  function place() {
    const st = list[i], el = document.querySelector(st.sel);
    if (!el) return next();
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const r = el.getBoundingClientRect(), pad = 6;
    Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    card.innerHTML = `<div class="tour-step">${i + 1} / ${list.length}</div><h4>${esc(st.title)}</h4><p>${esc(st.text)}</p><div class="row"><button class="ghost small" data-t="skip">跳过</button><span class="grow"></span><button class="primary small" data-t="next">${i === list.length - 1 ? '知道了' : '下一步'}</button></div>`;
    card.querySelector('[data-t=skip]').onclick = done; card.querySelector('[data-t=next]').onclick = next;
    const cw = Math.min(320, innerWidth - 32), ch = card.offsetHeight || 150;
    let x = st.place === 'left' ? r.left - cw - 16 : st.place === 'right' ? r.right + 16 : r.left + r.width / 2 - cw / 2;
    let y = st.place === 'top' ? r.top - ch - 16 : st.place === 'left' || st.place === 'right' ? r.top + r.height / 2 - ch / 2 : r.bottom + 16;
    x = Math.max(16, Math.min(innerWidth - cw - 16, x)); y = Math.max(70, Math.min(innerHeight - ch - 16, y));
    Object.assign(card.style, { left: `${x}px`, top: `${y}px`, width: `${cw}px` });
    card.querySelector('[data-t=next]').focus();
  }
  window.addEventListener('resize', place); document.addEventListener('keydown', onKey);
  place();
}
export const resetTours = () => { try { Object.keys(localStorage).filter((k) => k.startsWith('yz-tour-')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ } };

// ---- 运行方式：模拟演示（本地生成）/ 大模型 API 运行。选择保存在本浏览器，新建课堂、新建任务都默认沿用。 ----
const EXEC_KEY = 'yz-exec-mode';
export function execPref(cat) {
  let v = 'demo'; try { v = localStorage.getItem(EXEC_KEY) || 'demo'; } catch { /* storage unavailable */ }
  return v === 'model' && cat.model_available ? 'model' : 'demo';
}
function setExecPref(v) { try { localStorage.setItem(EXEC_KEY, v); } catch { /* storage unavailable */ } }
const modelTitle = (cat) => `${cat.model_name || 'DeepSeek'} API 运行`;
/** Two large cards; the container carries data-value and fires a bubbling `change` event. */
export function modeCards(cat, id, value = execPref(cat)) {
  const off = !cat.model_available;
  return `<div class="mode-cards" id="${id}" data-value="${value}" role="radiogroup" aria-label="运行方式">
    <button type="button" class="mode-card demo ${value === 'demo' ? 'on' : ''}" data-mode="demo" role="radio" aria-checked="${value === 'demo'}"><span class="mc-ico" aria-hidden="true">🎬</span><span><b>模拟演示</b><small>本地生成：依据导入的课程内容组织发言，不调用大模型，不扣积分</small></span></button>
    <button type="button" class="mode-card model ${value === 'model' ? 'on' : ''}" data-mode="model" role="radio" aria-checked="${value === 'model'}" ${off ? 'disabled' : ''}><span class="mc-ico" aria-hidden="true">⚡</span><span><b>${esc(modelTitle(cat))}</b><small>${off ? `暂不可用：${esc(cat.model_status?.message || '')}` : `真实大模型实时生成（${esc(cat.model_id || '')}），按成功调用扣积分`}</small></span></button></div>`;
}
export const modeVal = (el) => el?.dataset.value || 'demo';
export function bindModeCards(el, onChange) {
  if (!el) return;
  el.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    const v = b.dataset.mode; el.dataset.value = v; setExecPref(v);
    el.querySelectorAll('[data-mode]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); });
    el.dispatchEvent(new Event('change', { bubbles: true }));
    onChange && onChange(v);
  }));
}
/** Compact segmented version for the page toolbar. */
export function modeSwitch(cat, id) {
  const v = execPref(cat), off = !cat.model_available;
  return `<div class="mode-switch" id="${id}" data-value="${v}" role="radiogroup" aria-label="运行方式"><span class="ms-lbl">运行方式</span>
    <button type="button" class="mode-card demo ${v === 'demo' ? 'on' : ''}" data-mode="demo" role="radio" aria-checked="${v === 'demo'}" title="本地生成，不调用大模型，不扣积分">🎬 模拟演示</button>
    <button type="button" class="mode-card model ${v === 'model' ? 'on' : ''}" data-mode="model" role="radio" aria-checked="${v === 'model'}" ${off ? 'disabled' : ''} title="${off ? `暂不可用：${esc(cat.model_status?.message || '')}` : '真实大模型实时生成，按成功调用扣积分'}">⚡ ${esc(modelTitle(cat))}</button></div>`;
}
