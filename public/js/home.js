// 首页（三屏叙事）：① 研思智境 + 研课场 ⇄ 演课场；② 课程思政 × 专业课程；③ “研—演—评—改”闭环与核心能力。
// 只展示真实功能与平台自带的思政元素参考库，不展示任何统计数字。双向流转逻辑与原首页一致。
import { get, post, key } from './api.js';
import { esc, $, $$, toast, fail, modal, confirmBox, TYPE_NAME, MODULE_NAME, tour } from './ui.js';

// lucide 风格线性图标（24×24，描边）
const ICON = {
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  cap: '<path d="M22 10 12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/><path d="M22 10v6"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  landmark: '<path d="M3 22h18M4 18h16M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l8 5H4z"/>',
  dna: '<path d="M2 15c6.667-6 13.333 0 20-6"/><path d="M9 22c1.8-2 2.5-4 2.8-6"/><path d="M15 2c-1.8 2-2.5 4-2.8 6"/><path d="M17 6l-2.5-2.5M14 8l-1-1M7 18l2.5 2.5M3.5 14.5l.5.5M20 9l.5.5M6.5 12.5l1 1M16.5 10.5l1 1M10 16l1.5 1.5"/>',
  scale: '<path d="M12 3v18M7 21h10M3 7h18"/><path d="M6 7l-3 7a3 3 0 0 0 6 0zM18 7l-3 7a3 3 0 0 0 6 0z"/>',
  flask: '<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/><path d="M7 15h10"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  heart: '<path d="M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6C19 16.5 12 21 12 21z"/>',
  board: '<path d="M2 3h20M4 3v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V3M12 15v6M8 21h8"/>',
  layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l4 2"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  play: '<circle cx="12" cy="12" r="10"/><path d="M10 8l6 4-6 4z"/>',
  check: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

const ARROW = (dir) => `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="ag${dir}" x1="0" x2="1"><stop offset="0" stop-color="#EBC46B"/><stop offset="1" stop-color="#D6A34A"/></linearGradient></defs>
  <g transform="${dir === 'left' ? 'translate(64,0) scale(-1,1)' : ''}"><path class="flow" d="M8 32H48" stroke="#56A8FF" stroke-width="2" fill="none" opacity=".7"/><path d="M10 32H50M36 16L52 32L36 48" stroke="url(#ag${dir})" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;

// 专业领域 → 平台“思政元素参考库”中的相关维度（server/templates.js IDEOLOGY_LIBRARY 的 key）
const DISCIPLINES = [
  { key: 'eng', name: '新工科', icon: 'cpu', line: '工程伦理 · 科技报国 · 工匠精神', lib: ['mission', 'ethics', 'craft'] },
  { key: 'arts', name: '新文科', icon: 'landmark', line: '文化自信 · 人文关怀 · 文化传承', lib: ['culture', 'integrity', 'law'] },
  { key: 'med', name: '医学人文', icon: 'dna', line: '生命至上 · 医者仁心 · 医学伦理', lib: ['ethics', 'culture', 'integrity'] },
  { key: 'biz', name: '商科伦理', icon: 'scale', line: '诚信经营 · 商业向善 · 社会责任', lib: ['integrity', 'law', 'ethics'] },
  { key: 'sci', name: '科研方法', icon: 'flask', line: '科学精神 · 求真务实 · 研究伦理', lib: ['science', 'integrity', 'craft'] },
  { key: 'soc', name: '社会责任', icon: 'globe', line: '公共利益 · 绿色发展 · 家国担当', lib: ['green', 'ethics', 'mission'] },
];
const LOOP = [
  { ch: '研', name: '研课场', icon: 'search', link: '/seminar', keys: ['多智能体协同', '课程共创', '交叉质询'] },
  { ch: '演', name: '演课场', icon: 'play', link: '/classroom', keys: ['学生智能体', '情境互动', '课堂预演'] },
  { ch: '评', name: '数据评价', icon: 'check', link: '/rating', keys: ['过程数据', '互动分析', '证据评价'] },
  { ch: '改', name: '反思改进', icon: 'pencil', link: '/library', keys: ['问题诊断', '版本修订', '再次验证'] },
];
const CAPS = [
  { icon: 'users', name: '多智能体协同', tip: '教研组长、专业教师、思政教师等智能体分工起草、交叉质询，再整合成稿。' },
  { icon: 'heart', name: '课程思政融合', tip: '逐个知识点研讨思政融入点，自检口号化表述，大屏重点突出思政内容。' },
  { icon: 'board', name: '课堂智能模拟', tip: '按课时推进教学环节，学生智能体自主提问、质疑、讨论，可倍速，可真人插话。' },
  { icon: 'layers', name: '教学框架支持', tip: '支持 BOPPPS、PDCA 等教学设计框架，教案各环节按课时编排。' },
  { icon: 'activity', name: '过程数据采集', tip: '每条发言、调度决策与模型调用都有记录，可假名化导出研究数据包。' },
  { icon: 'history', name: '可追溯反思改进', tip: '课堂反馈带回研讨修订，每次修订生成新版本并保留依据。' },
];

// 数字校园天际线（纯装饰，SVG 生成，无文字）
function skyline() {
  let x = 0, s = '', seed = 7;
  const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  while (x < 1600) {
    const w = 40 + Math.round(rnd() * 70), h = 60 + Math.round(rnd() * 150), gap = 6 + Math.round(rnd() * 14);
    const center = Math.abs(x + w / 2 - 800) < 190; // 留出中轴
    if (!center) {
      s += `<rect x="${x}" y="${260 - h}" width="${w}" height="${h}" rx="2"/>`;
      for (let wy = 260 - h + 10; wy < 250; wy += 14) for (let wx = x + 7; wx < x + w - 8; wx += 12) if (rnd() > 0.45) s += `<rect class="win" x="${wx}" y="${wy}" width="5" height="6"/>`;
    }
    x += w + gap;
  }
  return `<svg class="hx-city" viewBox="0 0 1600 260" preserveAspectRatio="xMidYMax slice" aria-hidden="true">${s}</svg>`;
}
const ORB = `<svg class="hx-orb" viewBox="0 0 64 64" aria-hidden="true"><defs><radialGradient id="orbg" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#cfe6ff"/><stop offset=".55" stop-color="#56A8FF"/><stop offset="1" stop-color="#163E73"/></radialGradient></defs>
  <circle cx="32" cy="32" r="22" fill="url(#orbg)"/><g fill="none" stroke="#ffffff" stroke-opacity=".55" stroke-width=".8"><ellipse class="m1" cx="32" cy="32" rx="22" ry="22"/><ellipse class="m2" cx="32" cy="32" rx="22" ry="22"/><ellipse class="m3" cx="32" cy="32" rx="22" ry="22"/><ellipse cx="32" cy="32" rx="22" ry="8"/><path d="M10 32h44"/></g>
  <circle cx="32" cy="32" r="29" fill="none" stroke="#EBC46B" stroke-opacity=".45" stroke-dasharray="2 5"/></svg>`;

export async function pageHome(root, { navigate, getCatalog }) {
  const h = await get('/api/home');
  const cur = (m) => h.current[m];
  const label = (m) => (cur(m) ? `当前：${cur(m).title} · v${cur(m).version}${cur(m).status === 'draft' ? '（草稿）' : ''}` : '当前暂无产物');
  const arrow = (from) => {
    const to = from === 'seminar' ? 'classroom' : 'seminar';
    const src = cur(from);
    const name = `将${MODULE_NAME[from]}当前产物导出并导入${MODULE_NAME[to]}`;
    const tip = src ? `导入${MODULE_NAME[to]}` : `${MODULE_NAME[from]}暂无当前产物`;
    return `<button class="arrow-btn hx-arrow${src ? ' flow' : ''}" data-from="${from}" aria-label="${esc(src ? name : `${name}（不可用：${MODULE_NAME[from]}暂无当前产物）`)}" ${src ? '' : 'disabled'}>${ARROW(from === 'seminar' ? 'right' : 'left')}<span class="tip" role="tooltip">${esc(tip)}</span></button>`;
  };
  const card = (m) => {
    const S = m === 'seminar';
    return `<a class="hx-card ${S ? 'seminar' : 'classroom'}" id="portal-${m}" href="/${m}" data-link="/${m}" aria-label="进入${S ? '研课场' : '演课场'}">
      <div class="hx-media"><div class="hx-img" style="background-image:url(/img/hero-${m}.webp)" role="img" aria-label="${S ? '教师与智能体围坐研讨，共享屏幕上呈现课程设计' : '教师在智慧课堂讲授，学生举手互动'}"></div><div class="hx-tint"></div><div class="hx-scan"></div></div>
      <div class="hx-body">
        <div class="hx-head"><span class="hx-ico">${icon(S ? 'book' : 'cap')}</span><div><h2>${S ? '研课场' : '演课场'}</h2><p class="hx-desc">${S ? '多智能体协同研课 · 教学设计 · 交叉质询 · 课程思政融合' : '多智能体课堂预演 · AI 学生互动 · 教学观察 · 即时反馈'}</p></div></div>
        <div class="hx-tags">${(S ? ['多智能体协同', '课程设计', '证据审查'] : ['AI 学生', '随机互动', '课堂反馈']).map((t) => `<span>${t}</span>`).join('')}</div>
        <div class="hx-foot"><span class="hx-cur">${esc(label(m))}</span><span class="hx-btn">进入${S ? '研课场' : '演课场'} ${icon('arrow')}</span></div>
      </div></a>`;
  };

  document.body.classList.add('is-home');
  root.innerHTML = `<div class="hx">
  <section class="hx-hero" aria-labelledby="hx-title">
    <div class="hx-sky" aria-hidden="true"><i class="hx-glow r"></i><i class="hx-glow b"></i><i class="hx-band a"></i><i class="hx-band b"></i>${skyline()}<div class="hx-floor"></div></div>
    <div class="hx-intro">
      <p class="hx-eyebrow">Research · Simulation · Evaluation · Improvement</p>
      <h1 id="hx-title">研思智境</h1>
      <p class="hx-sub">“研—演—评—改”多智能体数字教研实验工坊</p>
      <p class="hx-lead"><span class="hx-l1">面向教师专业发展的多智能体数字教研实验环境</span><span aria-hidden="true">｜</span><span class="hx-l2">先研后演，以评促改</span></p>
    </div>
    <div class="hx-stage">
      ${card('seminar')}
      <div class="arrows hx-bridge">${arrow('seminar')}<span class="hx-core">${ORB}</span>${arrow('classroom')}</div>
      ${card('classroom')}
    </div>
    <a class="hx-more" href="#hx-disc" aria-label="向下浏览：课程思政与专业课程">${icon('arrow')}</a>
  </section>

  <section class="hx-sec hx-disc reveal" id="hx-disc" aria-labelledby="hx-disc-t">
    <h2 class="hx-h" id="hx-disc-t">课程思政 <em>×</em> 专业课程</h2>
    <p class="hx-p">以专业课程为载体，让知识传授、能力培养与价值引领同向同行。</p>
    <ol class="hx-eq" aria-label="育人逻辑"><li>知识传授</li><li class="op" aria-hidden="true">+</li><li>能力培养</li><li class="op" aria-hidden="true">+</li><li>价值引领</li><li class="op" aria-hidden="true">=</li><li class="res">育人</li></ol>
    <div class="hx-grid6">${DISCIPLINES.map((d, i) => `<button type="button" class="hx-disc-card d-${d.key}" data-disc="${d.key}" style="--i:${i}">
      <span class="hx-art" aria-hidden="true">${icon(d.icon)}</span><span class="hx-dico">${icon(d.icon)}</span>
      <span class="hx-dtxt"><b>${d.name}</b><small>${d.line}</small></span><span class="hx-dmore">查看思政元素 ${icon('arrow')}</span></button>`).join('')}</div>
  </section>

  <section class="hx-sec hx-loop-sec reveal" aria-labelledby="hx-loop-t">
    <h2 class="hx-h" id="hx-loop-t">“研—演—评—改”数字教研闭环</h2>
    <p class="hx-p">从研课到演课，从评价到改进，形成可追溯、可迭代的数字教研闭环。</p>
    <ol class="hx-loop">${LOOP.map((n, i) => `<li style="--i:${i}"><a class="hx-node n${i}" href="${n.link}" data-link="${n.link}"><span class="hx-ring">${icon(n.icon)}<b>${n.ch}</b></span><span class="hx-nname">${n.name}</span><span class="hx-nkeys">${n.keys.map((k) => `<span>${k}</span>`).join('')}</span></a></li>`).join('')}</ol>
    <div class="hx-caps">${CAPS.map((c, i) => `<div class="hx-cap" tabindex="0" style="--i:${i}"><span class="hx-cico">${icon(c.icon)}</span><b>${c.name}</b><p>${c.tip}</p></div>`).join('')}</div>
  </section>
  <footer class="hx-foot-note">研思智境 ·“研—演—评—改”多智能体数字教研实验工坊 · 演课场中的学生为智能体，模拟结果不代表真实学生的学习表现 · 首页场景图为项目视觉效果图</footer>
  </div>`;

  // 滚动分段出现（不支持 IntersectionObserver 或减少动态时直接显示）
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let io = null;
  if (!reduce && 'IntersectionObserver' in window) {
    io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.18 });
    $$('.reveal', root).forEach((el) => io.observe(el));
  } else $$('.reveal', root).forEach((el) => el.classList.add('in'));

  // 卡片微小 3D 倾斜
  const tilt = (el) => {
    if (reduce) return;
    el.addEventListener('pointermove', (e) => { const r = el.getBoundingClientRect(); el.style.setProperty('--rx', `${((e.clientY - r.top) / r.height - 0.5) * -4}deg`); el.style.setProperty('--ry', `${((e.clientX - r.left) / r.width - 0.5) * 5}deg`); });
    el.addEventListener('pointerleave', () => { el.style.setProperty('--rx', '0deg'); el.style.setProperty('--ry', '0deg'); });
  };
  $$('.hx-card, .hx-disc-card', root).forEach(tilt);

  $('.hx-more', root).addEventListener('click', (e) => { e.preventDefault(); $('#hx-disc').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' }); });
  $$('[data-disc]', root).forEach((b) => b.addEventListener('click', () => openDiscipline(DISCIPLINES.find((d) => d.key === b.dataset.disc), getCatalog, navigate)));

  tour('home', [
    { sel: '#portal-seminar', place: 'right', title: '① 研课场', text: '导入讲义、大纲、课件等课程内容后，系统自动解析知识点，教研组逐个知识点研讨讲解要点、难点、思政融入与检测题，生成教案、试卷等成果；可随时暂停与继续。' },
    { sel: '.arrow-btn[data-from=seminar]', place: 'bottom', title: '② 导入课堂 →', text: '把研课场的“当前产物”（如教案）导出并导入演课场。点击后会先让你确认。' },
    { sel: '#portal-classroom', place: 'left', title: '③ 演课场', text: '按设定课时（如 50 分钟）开课：教师依次讲解，学生智能体自主、随机地提问、质疑和讨论；可倍速运行，也可以随时以教师或学生身份插话。' },
    { sel: '.arrow-btn[data-from=classroom]', place: 'bottom', title: '④ 反馈回研讨 ←', text: '把课堂生成的反馈带回研课场，作为反思修订的依据。' },
    { sel: '#credit-pill', place: 'bottom', title: '⑤ 积分与导出', text: '真实模型每次成功回复按费率扣积分，开始前会显示预算；本地生成、编辑、流转、导出都不扣积分。右侧可导出研究数据。' },
  ]);
  $$('.arrow-btn:disabled', root).forEach((b) => { b.title = b.querySelector('.tip').textContent; });
  $$('.arrow-btn[data-from]', root).forEach((b) => b.addEventListener('click', () => doTransfer(b.dataset.from, cur(b.dataset.from), () => pageHome(root, { navigate, getCatalog }))));

  return () => { document.body.classList.remove('is-home'); io?.disconnect(); };
}

async function openDiscipline(d, getCatalog, navigate) {
  const cat = await getCatalog();
  const groups = d.lib.map((k) => cat.ideology_library.find((g) => g.key === k)).filter(Boolean);
  const go = await modal({ title: `${d.name} · 课程思政融入参考`, wide: true,
    body: `<p class="small muted" style="margin-top:0">以下是平台“思政元素参考库”中与${esc(d.name)}课程关系较密切的维度，只提供思考框架与引导问题，不收录政策原文。实际融入点由教研组结合你导入的课程内容逐个知识点研讨确定。</p>
      <div class="grid3">${groups.map((g) => `<div class="hx-lib"><b>${esc(g.name)}</b><div class="row" style="gap:4px;margin:6px 0">${g.elements.map((e) => `<span class="badge">${esc(e)}</span>`).join('')}</div><ul>${g.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>`).join('')}</div>`,
    buttons: [{ label: '关闭', value: false }, { label: '去研课场，导入本课程内容', value: true, cls: 'primary' }] });
  if (go) navigate('/seminar');
}

export async function doTransfer(from, src, redraw) {
  const to = from === 'seminar' ? 'classroom' : 'seminar';
  const draft = src.status === 'draft';
  const ok = await confirmBox('确认流转', `<p style="font-size:calc(18px * var(--fs));margin:0 0 10px;color:var(--gold)">${MODULE_NAME[from]} → ${MODULE_NAME[to]}</p>
    <dl class="kv"><dt>源产物</dt><dd>${esc(src.title)}</dd><dt>版本</dt><dd>v${src.version}${draft ? '（未保存草稿）' : ''} · ${esc(TYPE_NAME[src.type] || src.type)}</dd><dt>摘要</dt><dd class="small">${esc(src.summary)}</dd></dl>`, draft ? '保存当前版本并导入' : '确认');
  if (!ok) return;
  try {
    const r = await post('/api/transfers', { from, idempotency_key: key('xfer'), save_draft: draft });
    toast(`已导入${MODULE_NAME[to]}：${r.target.title} · v${r.target.version}`);
    redraw();
  } catch (e) { fail(e); }
}
