// 播放器条（课堂试验场 / 数字教研室共用）：回退 · 开始/继续 · 暂停 · 快进 · 结束 + 可拖动的进度条。
// 进度条三层：已生成（buffer）· 当前播放位置（head）· 阶段刻度（marks）。
// 拖到已生成部分 = 回看（只读回放，不改变课堂）；拖到已生成部分之后 = 快进（连续推进到该位置）。
import { esc } from './ui.js';

const I = {
  back: '<path d="M11 18 3 12l8-6z"/><path d="M21 18l-8-6 8-6z"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>',
  fwd: '<path d="M13 18l8-6-8-6z"/><path d="M3 18l8-6-8-6z"/>',
  end: '<rect x="5.5" y="5.5" width="13" height="13" rx="2"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">${I[n]}</svg>`;

export function playerHtml({ speeds } = {}) {
  return `<div class="pl" role="group" aria-label="播放控制">
    <div class="pl-btns">
      <button type="button" class="pl-btn" id="pl-back" title="回退到上一阶段（回看，不改变课堂）">${svg('back')}<span>回退</span></button>
      <button type="button" class="pl-btn pl-main" id="pl-play">${svg('play')}<span id="pl-play-t">开始</span></button>
      <button type="button" class="pl-btn" id="pl-pause">${svg('pause')}<span>暂停</span></button>
      <button type="button" class="pl-btn" id="pl-fwd" title="快进到下一阶段">${svg('fwd')}<span>快进</span></button>
      <button type="button" class="pl-btn pl-stop" id="finish">${svg('end')}<span id="pl-end-t">结束</span></button>
    </div>
    <div class="pl-mid">
      <div class="pl-track" id="pl-track" role="slider" tabindex="0" aria-label="进度（可拖动回看或快进）" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="pl-rail"><i class="pl-buf" id="pl-buf"></i><i class="pl-fill" id="pl-fill"></i></div>
        <div class="pl-marks" id="pl-marks"></div>
        <i class="pl-knob" id="pl-knob"></i><span class="pl-hover" id="pl-hover" hidden></span>
      </div>
      <div class="pl-info"><span class="pl-time" id="pl-time"></span><span class="pl-stage" id="pl-stage"></span><span class="pl-state" id="pl-state"></span></div>
    </div>
    ${speeds ? `<div class="pl-speed" role="group" aria-label="倍速">${speeds.map((x) => `<button type="button" data-speed="${x}" title="${x === 1 ? '真实课堂节奏' : `${x} 倍速`}">${x}×</button>`).join('')}</div>` : ''}
  </div>`;
}

/**
 * s = { playLabel, canPlay, canPause, canEnd, endLabel, canBack, canFwd, total, live, head, marks:[{at,label,minor}],
 *       timeText, stageText, state: 'live'|'review'|'ff'|'idle'|'ended'|'job', speed, fmt(v) }
 */
export function drawPlayer(root, s) {
  const $ = (id) => root.querySelector(`#${id}`);
  if (!$('pl-track')) return;
  const pct = (v) => (s.total ? Math.max(0, Math.min(100, (v / s.total) * 100)) : 0);
  $('pl-play-t').textContent = s.playLabel; $('pl-play').disabled = !s.canPlay;
  $('pl-pause').disabled = !s.canPause; $('finish').disabled = !s.canEnd; $('pl-end-t').textContent = s.endLabel || '结束';
  $('pl-back').disabled = !s.canBack; $('pl-fwd').disabled = !s.canFwd;
  $('pl-buf').style.width = `${pct(s.live)}%`; $('pl-fill').style.width = `${pct(s.head)}%`; $('pl-knob').style.left = `${pct(s.head)}%`;
  const track = $('pl-track'); track.setAttribute('aria-valuenow', String(Math.round(pct(s.head)))); track.setAttribute('aria-valuetext', s.timeText || '');
  track.classList.toggle('off', !s.total);
  const key = JSON.stringify(s.marks || []);
  if (track.dataset.marks !== key) { track.dataset.marks = key; $('pl-marks').innerHTML = (s.marks || []).map((m) => `<i class="${m.minor ? 'mn' : ''}" style="left:${pct(m.at)}%" title="${esc(m.label || '')}"></i>`).join(''); }
  $('pl-time').textContent = s.timeText || ''; $('pl-stage').textContent = s.stageText || '';
  const st = { live: ['on', '● 实时'], review: ['rv', '⟲ 回看中 · 点“回到实时”继续'], ff: ['ff', '⏩ 快进中…'], idle: ['', '未开始'], ended: ['', '已结束'], job: ['on', '● 任务自动执行中'], paused: ['', '已暂停'] }[s.state] || ['', ''];
  $('pl-state').className = `pl-state ${st[0]}`; $('pl-state').textContent = st[1];
  root.querySelectorAll('[data-speed]').forEach((b) => b.classList.toggle('on', Number(b.dataset.speed) === s.speed));
  root.querySelector('.pl').classList.toggle('reviewing', s.state === 'review');
}

/** h = { play, pause, end, back, fwd, seek(value), speed(v), format(value)=>string, total()=>number } */
export function bindPlayer(root, h) {
  const q = (id) => root.querySelector(`#${id}`);
  q('pl-play').addEventListener('click', () => h.play());
  q('pl-pause').addEventListener('click', () => h.pause());
  q('finish').addEventListener('click', () => h.end());
  q('pl-back').addEventListener('click', () => h.back());
  q('pl-fwd').addEventListener('click', () => h.fwd());
  root.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => h.speed?.(Number(b.dataset.speed))));
  const track = q('pl-track'), hover = q('pl-hover');
  const valueAt = (x) => { const r = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)) * (h.total() || 0); };
  let dragging = false, last = 0;
  const show = (x) => { const v = valueAt(x), r = track.getBoundingClientRect(); hover.hidden = false; hover.style.left = `${x - r.left}px`; hover.textContent = h.format(v); return v; };
  // 阻止文本选择 / 原生拖放：否则第二次拖动会被浏览器取消（pointercancel）
  track.addEventListener('pointerdown', (e) => { if (!h.total()) return; e.preventDefault(); window.getSelection?.().removeAllRanges(); dragging = true; last = e.clientX; track.setPointerCapture(e.pointerId); show(e.clientX); q('pl-knob').style.left = `${(valueAt(e.clientX) / h.total()) * 100}%`; });
  track.addEventListener('pointermove', (e) => { if (!h.total()) return; if (dragging) last = e.clientX; show(e.clientX); if (dragging) q('pl-knob').style.left = `${(valueAt(e.clientX) / h.total()) * 100}%`; });
  track.addEventListener('pointerleave', () => { if (!dragging) hover.hidden = true; });
  track.addEventListener('pointerup', (e) => { if (!dragging) return; dragging = false; hover.hidden = true; h.seek(valueAt(e.clientX)); });
  track.addEventListener('pointercancel', () => { if (!dragging) return; dragging = false; hover.hidden = true; h.seek(valueAt(last)); });
  track.addEventListener('dragstart', (e) => e.preventDefault());
  track.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { e.preventDefault(); h.back(); } if (e.key === 'ArrowRight') { e.preventDefault(); h.fwd(); } });
}
