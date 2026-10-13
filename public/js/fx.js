// 交互动画（研课场 / 演课场共用）：发言“信息包”沿弧线从发言者飞向对象，并在到达处泛起涟漪。
// 只在有新发言时触发一次；开启“减少动态效果”时不播放。
const reduce = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const center = (el, box) => { const r = el.getBoundingClientRect(); return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 }; };

/** kind：talk | question | challenge | ideology | evidence | human | teacher | report */
export function flyPacket(container, fromEl, toEl, { kind = 'talk', label = '' } = {}) {
  if (!container || !fromEl || !toEl || fromEl === toEl || reduce()) return;
  const box = container.getBoundingClientRect(), a = center(fromEl, box), b = center(toEl, box);
  const lift = Math.min(90, Math.hypot(b.x - a.x, b.y - a.y) * 0.28);
  const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift };
  const pk = document.createElement('span'); pk.className = `pkt pkt-${kind}`; pk.innerHTML = `<i></i>${label ? `<b>${label}</b>` : ''}`;
  container.appendChild(pk);
  const frames = []; for (let i = 0; i <= 16; i++) { const t = i / 16, u = 1 - t; const x = u * u * a.x + 2 * u * t * c.x + t * t * b.x, y = u * u * a.y + 2 * u * t * c.y + t * t * b.y; frames.push({ transform: `translate(${x}px, ${y}px) scale(${0.7 + Math.sin(Math.PI * t) * 0.45})`, opacity: t < 0.08 ? t / 0.08 : t > 0.9 ? (1 - t) * 10 : 1 }); }
  const anim = pk.animate(frames, { duration: 950, easing: 'cubic-bezier(.3,.1,.3,1)' });
  anim.onfinish = () => { pk.remove(); ripple(container, toEl, kind); };
  // 拖尾
  for (let k = 1; k <= 3; k++) { const tr = document.createElement('span'); tr.className = `pkt-trail pkt-${kind}`; container.appendChild(tr); const an = tr.animate(frames, { duration: 950, delay: k * 55, easing: 'cubic-bezier(.3,.1,.3,1)' }); tr.style.opacity = '0'; an.onfinish = () => tr.remove(); }
}
export function ripple(container, el, kind = 'talk') {
  if (!container || !el || reduce()) return;
  const box = container.getBoundingClientRect(), p = center(el, box);
  const r = document.createElement('span'); r.className = `pkt-ripple pkt-${kind}`; r.style.left = `${p.x}px`; r.style.top = `${p.y}px`;
  container.appendChild(r); r.animate([{ transform: 'translate(-50%,-50%) scale(.3)', opacity: 0.9 }, { transform: 'translate(-50%,-50%) scale(1.6)', opacity: 0 }], { duration: 700, easing: 'ease-out' }).onfinish = () => r.remove();
}
export function kindOf(e) {
  if (e.actor_type === 'human') return 'human';
  if (['challenge', 'question', 'clarify'].includes(e.kind)) return e.kind === 'challenge' ? 'challenge' : 'question';
  if (['source_check'].includes(e.kind) || /待核查/.test(e.text || '')) return 'evidence';
  if (e.kind === 'ideology_link' || (e.ideology_terms && e.ideology_terms !== '[]')) return 'ideology';
  if (e.kind === 'report') return 'report';
  return e.actor_id === 'T' ? 'teacher' : 'talk';
}
