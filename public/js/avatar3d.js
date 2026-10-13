// 3D 渲染风格仿真人物（纯 SVG，本地生成，无外部素材），统一呈现在 3D 水晶圆球中：影棚光、球面明暗、发丝高光、边缘光、服装褶皱阴影。
// 每位智能体的外观由固定参数决定（不随刷新变化）；外观与能力、性格无关。教师可在“智能体中心”上传图片替换。
const SKIN = ['#f3cfb1', '#eab893', '#f7dbc4', '#d9a37f', '#e3ae8a'];
const HAIR = ['#1f1a19', '#2a1f1b', '#3b2a22', '#4a3326', '#16130f'];
const CLOTH = ['#2f4a6d', '#8e2f3f', '#35524a', '#5b4a78', '#c0703f', '#2c3e50', '#7a5230', '#3d6c8e', '#a33a4f', '#4d5b69', '#6b7f4a', '#b35e6f'];
const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
function mix(a, b, t) { const p = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)); const A = p(a), B = p(b); return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; }
const light = (c, t) => mix(c, '#ffffff', t), dark = (c, t) => mix(c, '#000000', t);

/** 学生外观：由座位号与性别确定 */
export function studentLook(i, gender) {
  const r = (k, n) => hash(`stu${i}:${k}`) % n; // 每个外观属性独立取值
  const f = gender === 'f';
  return { gender: f ? 'f' : 'm', age: 19 + r('age', 3), look: {
    hair: f ? ['long', 'bob', 'pony', 'long', 'bun'][r('hair', 5)] : ['short', 'crop', 'wave', 'side'][r('hair', 4)], hairColor: HAIR[r('hc', HAIR.length)],
    glasses: r('gl', 10) < 3 ? (r('gt', 2) ? 'round' : 'rect') : null, cloth: ['hoodie', 'shirt', 'sweater', 'tee'][r('cl', 4)], color: CLOTH[r('co', CLOTH.length)], shirt: '#f4f1ec', skin: r('sk', SKIN.length),
  } };
}

let uid = 0;
// ---------- 3D 水晶圆球：所有人物（教师、学生、真人）都放在玻璃球中呈现 ----------
// 教师为暖金玫瑰色玻璃，学生为冰晶蓝玻璃，真人为青色玻璃；球体有影棚底光、边缘折射、顶部高光、底部聚光与双层轮廓光。
const TONES = {
  t: { bg: ['#fffaf3', '#f5dcc7', '#d6a488'], edge: '#6e2230', caustic: '#ffcf8a', rim: '#e8b86a' },
  s: { bg: ['#f6fbff', '#d5e8f8', '#8db4db'], edge: '#1c3d66', caustic: '#bfe8ff', rim: '#7fb8e8' },
  h: { bg: ['#ecfdfd', '#a9e6e6', '#3f9e9e'], edge: '#0f3a3a', caustic: '#c9fff6', rim: '#5cd6d6' },
  p: { bg: ['#fff7fb', '#fbd9e6', '#ea9fbb'], edge: '#7a2346', caustic: '#ffd6e6', rim: '#f39cbc' },
  v: { bg: ['#fbf8ff', '#e3d9f7', '#a996d8'], edge: '#3a2766', caustic: '#e9dcff', rim: '#b39cf0' },
  e: { bg: ['#f5fffa', '#d2f1e2', '#86c9a8'], edge: '#1d4d38', caustic: '#d8ffe9', rim: '#7fd1a8' },
  a: { bg: ['#fffbf2', '#fbe7c2', '#e7b867'], edge: '#6b4513', caustic: '#fff0c9', rim: '#f0c26a' },
};
export function crystalOrb(inner, { tone = 't', id = `orb${++uid}`, cls = '' } = {}) {
  const T = TONES[tone] || TONES.t;
  return `<svg class="av3d av-orb ${cls}" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
    <clipPath id="${id}oc"><circle cx="60" cy="60" r="58"/></clipPath>
    <radialGradient id="${id}ob" cx="50%" cy="34%" r="72%"><stop offset="0" stop-color="${T.bg[0]}"/><stop offset=".58" stop-color="${T.bg[1]}"/><stop offset="1" stop-color="${T.bg[2]}"/></radialGradient>
    <radialGradient id="${id}oe" cx="50%" cy="47%" r="54%"><stop offset=".72" stop-color="${T.edge}" stop-opacity="0"/><stop offset=".93" stop-color="${T.edge}" stop-opacity=".26"/><stop offset="1" stop-color="${T.edge}" stop-opacity=".6"/></radialGradient>
    <radialGradient id="${id}ou" cx="50%" cy="100%" r="44%"><stop offset="0" stop-color="${T.caustic}" stop-opacity=".78"/><stop offset="1" stop-color="${T.caustic}" stop-opacity="0"/></radialGradient>
    <radialGradient id="${id}os" cx="32%" cy="18%" r="36%"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".5" stop-color="#fff" stop-opacity=".2"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id}or" x1=".15" y1="0" x2=".85" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".45" stop-color="${T.rim}" stop-opacity=".35"/><stop offset="1" stop-color="${T.rim}" stop-opacity=".95"/></linearGradient>
  </defs><g clip-path="url(#${id}oc)"><rect width="120" height="120" fill="url(#${id}ob)"/><ellipse cx="60" cy="22" rx="48" ry="20" fill="#fff" opacity=".35"/>
    ${inner}
    <rect width="120" height="120" fill="url(#${id}ou)"/><circle cx="60" cy="60" r="58" fill="url(#${id}oe)"/>
    <path d="M17 50 A45 45 0 0 1 62 13 A42 42 0 0 0 24 56Z" fill="url(#${id}os)"/>
    <ellipse cx="38" cy="25" rx="12" ry="5.5" transform="rotate(-34 38 25)" fill="#fff" opacity=".5"/>
    <ellipse cx="88" cy="93" rx="11" ry="3.6" transform="rotate(-42 88 93)" fill="#fff" opacity=".28"/></g>
    <circle cx="60" cy="60" r="57.8" fill="none" stroke="url(#${id}or)" stroke-width="2.4"/><circle cx="60" cy="60" r="55.5" fill="none" stroke="#fff" stroke-opacity=".4" stroke-width=".7"/>
    <circle cx="33" cy="23" r="2.1" fill="#fff" opacity=".95"/></svg>`;
}

/** p = { gender:'m'|'f', age, look:{hair,hairColor,grey,glasses,cloth,color,tie,shirt,earring,pin,skin} }，opts.bg 画影棚背景 */
export function avatar3d(p = {}, opts = {}) {
  const id = `av${++uid}`;
  const f = p.gender === 'f', L = p.look || {}, age = p.age || 30;
  const skin = SKIN[(L.skin ?? 0) % SKIN.length];
  const hair = L.grey ? mix(L.hairColor || HAIR[0], '#b9b7b4', L.grey) : (L.hairColor || HAIR[0]);
  const cloth = L.color || CLOTH[0], shirt = L.shirt || '#f7f4ef';
  const jaw = f ? 'C82 74 72 87 60 88 C48 87 38 74 37 58' : 'C84 76 74 88 60 89 C46 88 36 76 36 58';
  const face = `M60 23 C79 23 86 38 85 56 ${jaw} C35 38 42 23 60 23Z`;
  const defs = `<defs>
    <radialGradient id="${id}bg" cx="50%" cy="34%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset=".55" stop-color="#f3e7df"/><stop offset="1" stop-color="#d8c2b5"/></radialGradient>
    <radialGradient id="${id}sk" cx="40%" cy="36%" r="70%"><stop offset="0" stop-color="${light(skin, 0.28)}"/><stop offset=".5" stop-color="${skin}"/><stop offset="1" stop-color="${dark(skin, 0.22)}"/></radialGradient>
    <linearGradient id="${id}nk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${dark(skin, 0.3)}"/><stop offset=".6" stop-color="${dark(skin, 0.08)}"/></linearGradient>
    <linearGradient id="${id}hr" x1=".2" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="${light(hair, 0.28)}"/><stop offset=".45" stop-color="${hair}"/><stop offset="1" stop-color="${dark(hair, 0.35)}"/></linearGradient>
    <linearGradient id="${id}cl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${light(cloth, 0.22)}"/><stop offset=".45" stop-color="${cloth}"/><stop offset="1" stop-color="${dark(cloth, 0.4)}"/></linearGradient>
    <linearGradient id="${id}sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="${dark(shirt, 0.12)}"/></linearGradient>
    <radialGradient id="${id}ir" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#7a5236"/><stop offset=".6" stop-color="#3b2416"/><stop offset="1" stop-color="#140b06"/></radialGradient>
    <radialGradient id="${id}bl" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#e8826f" stop-opacity="${f ? 0.38 : 0.2}"/><stop offset="1" stop-color="#e8826f" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id}vol" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5a2a18" stop-opacity=".28"/><stop offset=".3" stop-color="#5a2a18" stop-opacity="0"/><stop offset=".72" stop-color="#5a2a18" stop-opacity="0"/><stop offset="1" stop-color="#5a2a18" stop-opacity=".2"/></linearGradient>
    <linearGradient id="${id}rim" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity=".35"/><stop offset=".25" stop-color="#fff" stop-opacity="0"/><stop offset=".8" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".22"/></linearGradient>
    <clipPath id="${id}fc"><path d="${face}"/></clipPath>
    <filter id="${id}sf" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.2"/></filter>
  </defs>`;
  const bg = opts.bg ? `<rect width="120" height="140" fill="url(#${id}bg)"/><ellipse cx="60" cy="150" rx="70" ry="30" fill="#000" opacity=".12" filter="url(#${id}sf)"/>` : '';
  // 后发
  const back = {
    long: `<path d="M34 50 C30 30 44 16 60 16 C78 16 90 30 86 52 L92 112 C80 120 40 120 28 112Z" fill="url(#${id}hr)"/>`,
    bob: `<path d="M33 52 C31 30 44 17 60 17 C77 17 89 30 87 52 L89 84 C80 92 40 92 31 84Z" fill="url(#${id}hr)"/>`,
    pony: `<path d="M80 40 C96 46 98 74 88 96 C84 80 82 62 78 50Z" fill="url(#${id}hr)"/>`,
    bun: `<circle cx="60" cy="16" r="11" fill="url(#${id}hr)"/><path d="M52 10 Q60 6 68 10" stroke="${light(hair, 0.35)}" stroke-width="1.4" fill="none" opacity=".6"/>`,
  }[L.hair] || '';
  // 服装
  const shoulders = `<path d="M6 140 C8 113 26 101 47 98 L73 98 C94 101 112 113 114 140Z" fill="url(#${id}cl)"/>`;
  const shine = `<path d="M6 140 C8 113 26 101 47 98 L73 98 C94 101 112 113 114 140Z" fill="url(#${id}rim)"/><path d="M14 122 C20 108 34 102 46 100" stroke="#fff" stroke-width="1.2" fill="none" opacity=".28"/>`;
  const fold = `${shine}<path d="M22 118 Q28 128 26 140 M98 118 Q92 128 94 140" stroke="${dark(cloth, 0.3)}" stroke-width="2" fill="none" opacity=".35"/>`;
  const vneck = `<path d="M48 98 L60 121 L72 98Z" fill="url(#${id}sh)"/>`;
  const lapels = `<path d="M47 98 L60 124 L52 140 L38 140 L42 110Z M73 98 L60 124 L68 140 L82 140 L78 110Z" fill="${dark(cloth, 0.18)}"/><path d="M47 98 L60 124 M73 98 L60 124" stroke="${light(cloth, 0.3)}" stroke-width=".8" opacity=".6"/>`;
  const tie = L.tie ? `<path d="M57.5 101 L62.5 101 L63.6 105 L61.4 127 L58.6 127 L56.4 105Z" fill="${L.tie}"/><path d="M58 101 L62 101 L61 104.5 L59 104.5Z" fill="${dark(L.tie, 0.25)}"/>` : '';
  const collar = `<path d="M49 97 L55 106 L60 99 L65 106 L71 97" fill="${shirt}" stroke="${dark(shirt, 0.18)}" stroke-width=".6"/>`;
  const clothes = {
    suit: `${shoulders}${vneck}${collar}${tie}${lapels}${fold}`,
    blazer: `${shoulders}<path d="M49 98 L60 116 L71 98Z" fill="url(#${id}sh)"/>${lapels}${fold}`,
    vest: `${shoulders}<path d="M44 99 L60 118 L76 99 L80 140 L40 140Z" fill="url(#${id}sh)"/><path d="M47 101 L60 124 L73 101 L74 140 L46 140Z" fill="${dark(cloth, 0.05)}"/>${collar}<circle cx="60" cy="130" r="1.2" fill="${dark(cloth, 0.5)}"/><circle cx="60" cy="137" r="1.2" fill="${dark(cloth, 0.5)}"/>`,
    jacket: `${shoulders}<path d="M52 98 L60 104 L68 98 L68 92 L52 92Z" fill="${dark(cloth, 0.15)}"/><path d="M60 104 L60 140" stroke="${dark(cloth, 0.45)}" stroke-width="1.4"/><path d="M53 100 L57 140 M67 100 L63 140" stroke="${light(cloth, 0.25)}" stroke-width=".8" opacity=".5"/>${fold}`,
    cardigan: `${shoulders}<path d="M47 98 L60 124 L73 98Z" fill="url(#${id}sh)"/><path d="M47 98 L60 124 L60 140 M73 98 L60 124" stroke="${dark(cloth, 0.35)}" stroke-width="1.6" fill="none"/>${fold}`,
    hoodie: `${shoulders}<path d="M40 100 Q60 116 80 100 Q76 94 60 96 Q44 94 40 100Z" fill="${dark(cloth, 0.2)}"/><path d="M55 107 L54 124 M65 107 L66 124" stroke="${light(cloth, 0.55)}" stroke-width="1.3"/>${fold}`,
    shirt: `${shoulders}${collar}<path d="M60 102 L60 140" stroke="${dark(cloth, 0.3)}" stroke-width="1"/><circle cx="60" cy="112" r="1" fill="${light(cloth, 0.6)}"/><circle cx="60" cy="124" r="1" fill="${light(cloth, 0.6)}"/>${fold}`,
    sweater: `${shoulders}<path d="M49 98 Q60 108 71 98" fill="none" stroke="${dark(cloth, 0.25)}" stroke-width="3"/><path d="M30 126 L90 126" stroke="${light(cloth, 0.2)}" stroke-width="1" opacity=".4"/>${fold}`,
    tee: `${shoulders}<path d="M50 98 Q60 106 70 98" fill="none" stroke="${dark(cloth, 0.3)}" stroke-width="2"/>${fold}`,
  }[L.cloth] || shoulders;
  const pin = L.pin ? `<circle cx="78" cy="112" r="2.4" fill="#d6a34a"/><circle cx="78" cy="112" r="1.2" fill="#b3263a"/>` : '';
  // 颈、耳、脸
  const neck = `<path d="M50 80 L70 80 L71 99 Q60 106 49 99Z" fill="url(#${id}nk)"/><ellipse cx="60" cy="92" rx="12" ry="4" fill="${dark(skin, 0.4)}" opacity=".25" filter="url(#${id}sf)"/>`;
  const ears = `<ellipse cx="36.5" cy="61" rx="4.2" ry="7" fill="${dark(skin, 0.06)}"/><ellipse cx="83.5" cy="61" rx="4.2" ry="7" fill="${dark(skin, 0.1)}"/><path d="M36 57 Q34 61 36.5 65 M84 57 Q86 61 83.5 65" stroke="${dark(skin, 0.28)}" stroke-width=".8" fill="none"/>`;
  const earring = L.earring ? `<circle cx="36" cy="69.5" r="1.6" fill="#e7c47a"/><circle cx="84" cy="69.5" r="1.6" fill="#e7c47a"/>` : '';
  const head = `<path d="${face}" fill="url(#${id}sk)"/><g clip-path="url(#${id}fc)"><rect x="30" y="20" width="60" height="72" fill="url(#${id}vol)"/><ellipse cx="60" cy="${L.hair === 'crop' ? 36 : 40}" rx="26" ry="7" fill="${dark(skin, 0.5)}" opacity=".22" filter="url(#${id}sf)"/><ellipse cx="60" cy="90" rx="22" ry="8" fill="${dark(skin, 0.45)}" opacity=".18" filter="url(#${id}sf)"/></g><path d="M81 40 C86 52 85 66 78 78" stroke="#fff" stroke-width="1.6" fill="none" opacity=".28"/><ellipse cx="46" cy="70" rx="7" ry="4.5" fill="url(#${id}bl)"/><ellipse cx="74" cy="70" rx="7" ry="4.5" fill="url(#${id}bl)"/>`;
  // 五官
  const browW = f ? 1.3 : 2.1, browC = dark(hair, 0.1);
  const brows = `<path d="M44.5 52.5 Q50 49 55.5 51.5" stroke="${browC}" stroke-width="${browW}" fill="none" stroke-linecap="round"/><path d="M64.5 51.5 Q70 49 75.5 52.5" stroke="${browC}" stroke-width="${browW}" fill="none" stroke-linecap="round"/>`;
  const eye = (cx) => `<ellipse cx="${cx}" cy="59.5" rx="4.6" ry="3.1" fill="#fbf8f5"/><circle cx="${cx + 0.3}" cy="59.6" r="2.7" fill="url(#${id}ir)"/><circle cx="${cx + 0.3}" cy="59.6" r="1.1" fill="#0b0604"/><circle cx="${cx + 1.2}" cy="58.6" r=".75" fill="#fff"/><path d="M${cx - 4.6} 59.2 Q${cx} 55.4 ${cx + 4.6} 59.2" stroke="${dark(skin, 0.6)}" stroke-width="${f ? 1.5 : 1.1}" fill="none" stroke-linecap="round"/><path d="M${cx - 3.8} 62.4 Q${cx} 63.8 ${cx + 3.8} 62.4" stroke="${dark(skin, 0.25)}" stroke-width=".6" fill="none" opacity=".6"/>`;
  // 女性角色加上睫毛与眼线，卡通形象更精致
  const lash = (cx, d) => `<path d="M${cx - 5} 59 Q${cx} 54.6 ${cx + 5} 59" stroke="${dark(hair, 0.2)}" stroke-width="1.3" fill="none" stroke-linecap="round"/><path d="M${cx + d * 4.6} 58.2 l${d * 1.8} -1.4" stroke="${dark(hair, 0.2)}" stroke-width="1.1" stroke-linecap="round"/>`;
  const eyes = eye(50) + eye(70) + (f && !opts.noLash ? lash(50, -1) + lash(70, 1) : '');
  const nose = `<path d="M60.5 60 Q58.2 67.5 56.6 70.2 Q60 72.4 63.6 70.2" stroke="${dark(skin, 0.32)}" stroke-width="1" fill="none" opacity=".55" stroke-linecap="round"/><ellipse cx="61.2" cy="66" rx="1.1" ry="3.2" fill="#fff" opacity=".22"/>`;
  const lip = f ? '#c65f68' : '#b56a61';
  const mouth = `<path d="M52.5 76.2 Q60 81.4 67.5 76.2 Q60 78.6 52.5 76.2Z" fill="${lip}"/><path d="M52.5 76.2 Q60 78.2 67.5 76.2" stroke="${dark(lip, 0.35)}" stroke-width=".8" fill="none"/><path d="M57 79.6 Q60 80.4 63 79.6" stroke="#fff" stroke-width=".7" opacity=".4" fill="none"/>`;
  const lines = age >= 46 ? `<path d="M48 43 Q60 40.5 72 43" stroke="${dark(skin, 0.25)}" stroke-width=".6" fill="none" opacity=".45"/><path d="M53.5 69.5 Q51.5 74 53 78 M66.5 69.5 Q68.5 74 67 78" stroke="${dark(skin, 0.3)}" stroke-width=".7" fill="none" opacity=".4"/>` : '';
  // 前发
  const hi = `stroke="${light(hair, 0.45)}" stroke-width="1.3" fill="none" opacity=".55" stroke-linecap="round"`;
  const front = {
    side: `<path d="M35 55 C32 32 45 19 61 19 C78 19 89 31 85.5 55 C83 44 79 36 71 32 C62 37 47 37 39 42Z" fill="url(#${id}hr)"/><path d="M48 25 Q58 21 70 23 M66 24 Q76 27 82 36" ${hi}/>`,
    short: `<path d="M35 54 C32 31 45 19 60 19 C76 19 88 31 85.5 54 C84 44 80 38 76 36 C68 40 52 40 44 36 C40 40 37 46 35 54Z" fill="url(#${id}hr)"/><path d="M47 26 Q60 21 73 26" ${hi}/>`,
    crop: `<path d="M36 50 C35 30 46 21 60 21 C74 21 85 30 84 50 C82 42 78 37 72 35 C64 37 55 37 48 35 C42 37 38 43 36 50Z" fill="url(#${id}hr)"/><path d="M50 26 Q60 23 70 26" ${hi}/>`,
    wave: `<path d="M34 56 C29 30 44 16 61 17 C79 18 91 31 86 56 C84 46 80 39 74 36 C70 41 64 38 60 42 C56 38 50 42 46 38 C41 42 37 48 34 56Z" fill="url(#${id}hr)"/><path d="M44 27 Q52 21 60 24 Q68 19 78 26" ${hi}/>`,
    long: `<path d="M35 60 C31 32 45 18 60 18 C77 18 90 32 85 60 C82 46 76 36 66 33 C60 40 52 44 42 46 C39 50 36 55 35 60Z" fill="url(#${id}hr)"/><path d="M47 26 Q56 21 66 22 M70 25 Q79 30 83 40" ${hi}/>`,
    bob: `<path d="M34 62 C30 33 44 18 60 18 C77 18 90 33 86 62 C84 50 80 40 74 35 C66 40 52 40 45 35 C39 41 36 50 34 62Z" fill="url(#${id}hr)"/><path d="M45 27 Q60 20 75 27" ${hi}/>`,
    pony: `<path d="M36 54 C33 31 46 19 61 19 C77 19 88 31 85 54 C83 42 78 35 70 33 C62 36 50 36 43 38 C40 42 37 48 36 54Z" fill="url(#${id}hr)"/><path d="M47 25 Q60 20 74 26" ${hi}/>`,
    bun: `<path d="M36 54 C33 31 46 20 61 20 C77 20 88 31 85 54 C83 43 79 36 72 34 C63 37 51 37 44 37 C40 42 37 48 36 54Z" fill="url(#${id}hr)"/><path d="M48 26 Q60 21 73 26" ${hi}/>`,
  }[L.hair] || '';
  // 眼镜
  const gl = L.glasses === 'round'
    ? `<g fill="#ffffff" fill-opacity=".12" stroke="#2a2a2e" stroke-width="1.3"><circle cx="50" cy="59.5" r="6.4"/><circle cx="70" cy="59.5" r="6.4"/></g><path d="M56.4 59 Q60 57.4 63.6 59 M43.6 58.5 L37.5 57 M76.4 58.5 L82.5 57" stroke="#2a2a2e" stroke-width="1.2" fill="none"/><path d="M45.5 56 L49 53.8 M65.5 56 L69 53.8" stroke="#fff" stroke-width="1" opacity=".6"/>`
    : L.glasses ? `<g fill="#ffffff" fill-opacity=".12" stroke="#26262b" stroke-width="1.3"><rect x="42.8" y="54.6" width="14.4" height="10" rx="3"/><rect x="62.8" y="54.6" width="14.4" height="10" rx="3"/></g><path d="M57.2 58.6 Q60 57.2 62.8 58.6 M42.8 57.5 L37.5 56.6 M77.2 57.5 L82.5 56.6" stroke="#26262b" stroke-width="1.2" fill="none"/><path d="M44.5 57 L48 55.2 M64.5 57 L68 55.2" stroke="#fff" stroke-width="1" opacity=".6"/>` : '';
  const hat = opts.label ? `<text x="60" y="136" text-anchor="middle" font-size="9" fill="#fff">${opts.label}</text>` : '';
  const person = `${back}${clothes}${pin}${neck}${ears}${earring}${head}${lines}${brows}${eyes}${nose}${mouth}${front}${gl}`;
  if (opts.orb !== false) return crystalOrb(`${defs}<g transform="translate(4.8 -0.5) scale(.92)">${person}</g>`, { tone: opts.tone || 't', id });
  return `<svg class="av3d" viewBox="${opts.crop ? '13 8 94 94' : '0 0 120 140'}" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${defs}${bg}${person}${hat}</svg>`;
}

// ---------- 统一取像：优先使用上传的形象图片，否则使用固定参数的 3D 渲染形象 ----------
const REG = { roles: {}, students: {} };
export function setAgentRegistry({ roles, studentAvatars } = {}) { if (roles) REG.roles = roles; if (studentAvatars) REG.students = studentAvatars; }
export const roleInfo = (key) => REG.roles[key] || null;
/** 上传的图片也放进水晶球（CSS 玻璃高光层） */
export const orbImg = (src, alt = '') => `<span class="av-orbimg"><img class="av-img" src="${src}" alt="${alt}" loading="lazy"></span>`;
const img = orbImg;
/** 教师智能体头像（key：leader/designer/…/custom1） */
export function teacherAvatar(key, opts = {}) {
  const r = REG.roles[key];
  if (r?.avatar) return img(r.avatar);
  if (r?.look) return avatar3d(r, { tone: 't', ...opts });
  return avatar3d({ gender: 'm', age: 40, look: { hair: 'short', cloth: 'suit', color: '#2f3d5c', tie: '#8e1426', glasses: 'rect' } }, { tone: 't', ...opts });
}
/** 学生智能体头像：seat 为座位号（0 起），gender 来自固定姓名 */
export function studentAvatar(seat, gender, opts = {}) {
  if (REG.students[seat]) return img(REG.students[seat]);
  return avatar3d(studentLook(seat, gender), { tone: 's', ...opts });
}
/** 把图片文件压缩为 256px 方形 dataURL（上传形象用） */
export function fileToAvatar(file, size = 256) {
  return new Promise((ok, bad) => {
    const fr = new FileReader();
    fr.onload = () => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); const s = Math.min(im.width, im.height); g.drawImage(im, (im.width - s) / 2, Math.max(0, (im.height - s) / 2 - s * 0.08), s, s, 0, 0, size, size); ok(c.toDataURL('image/jpeg', 0.86)); }; im.onerror = () => bad(new Error('无法读取图片')); im.src = fr.result; };
    fr.onerror = () => bad(new Error('无法读取文件')); fr.readAsDataURL(file);
  });
}

// ---------- 数字客服“思思”：年轻女教师，粉晶水晶球 ----------
export const SISI = { gender: 'f', age: 26, look: { hair: 'long', hairColor: '#2b1d19', cloth: 'blazer', color: '#c4577a', shirt: '#fff6f8', earring: true, pin: true, skin: 2 } };
export const sisiAvatar = (opts = {}) => avatar3d(SISI, { tone: 'p', ...opts });

// ---------- 教师用户可选的 12 个 3D 水晶球头像 ----------
export const USER_AVATARS = [
  ['u01', '粉晶 · 长发', 'p', { gender: 'f', age: 27, look: { hair: 'long', hairColor: '#2a1f1b', cloth: 'blazer', color: '#c4577a', earring: true, skin: 2 } }],
  ['u02', '暖金 · 眼镜', 't', { gender: 'm', age: 38, look: { hair: 'side', hairColor: '#1f1a19', cloth: 'suit', color: '#2f4a6d', tie: '#8e1426', glasses: 'rect', skin: 0 } }],
  ['u03', '冰蓝 · 短发', 's', { gender: 'f', age: 30, look: { hair: 'bob', hairColor: '#3b2a22', cloth: 'cardigan', color: '#3d6c8e', skin: 0 } }],
  ['u04', '冰蓝 · 学长', 's', { gender: 'm', age: 26, look: { hair: 'crop', hairColor: '#16130f', cloth: 'hoodie', color: '#35524a', skin: 1 } }],
  ['u05', '暖金 · 盘发', 't', { gender: 'f', age: 42, look: { hair: 'bun', hairColor: '#2a1f1b', cloth: 'blazer', color: '#8e2f3f', earring: true, pin: true, skin: 2 } }],
  ['u06', '琥珀 · 马甲', 'a', { gender: 'm', age: 33, look: { hair: 'short', hairColor: '#2a1f1b', cloth: 'vest', color: '#7a5230', glasses: 'round', skin: 1 } }],
  ['u07', '紫晶 · 马尾', 'v', { gender: 'f', age: 25, look: { hair: 'pony', hairColor: '#4a3326', cloth: 'sweater', color: '#5b4a78', skin: 0 } }],
  ['u08', '翠晶 · 卷发', 'e', { gender: 'm', age: 29, look: { hair: 'wave', hairColor: '#2a1f1b', cloth: 'shirt', color: '#6b7f4a', skin: 3 } }],
  ['u09', '冰蓝 · 眼镜', 's', { gender: 'f', age: 35, look: { hair: 'long', hairColor: '#16130f', cloth: 'blazer', color: '#2c3e50', glasses: 'round', earring: true, skin: 1 } }],
  ['u10', '暖金 · 教授', 't', { gender: 'm', age: 56, look: { hair: 'side', hairColor: '#3b2a22', grey: 0.6, cloth: 'suit', color: '#394e76', tie: '#6b4513', glasses: 'rect', skin: 0 } }],
  ['u11', '紫晶 · 银发', 'v', { gender: 'f', age: 54, look: { hair: 'bob', hairColor: '#3b2a22', grey: 0.55, cloth: 'cardigan', color: '#726086', glasses: 'rect', skin: 2 } }],
  ['u12', '琥珀 · 青年', 'a', { gender: 'm', age: 24, look: { hair: 'short', hairColor: '#16130f', cloth: 'tee', color: '#c0703f', skin: 4 } }],
];
export const USER_AVATAR_KEYS = USER_AVATARS.map((x) => x[0]);
/** 用户头像：未选择时按用户编号固定分配一个（不随刷新变化） */
export function userAvatar(key, seed = '') {
  const k = USER_AVATAR_KEYS.includes(key) ? key : USER_AVATAR_KEYS[hash(seed || 'u') % USER_AVATAR_KEYS.length];
  const [, , tone, p] = USER_AVATARS.find((x) => x[0] === k);
  return avatar3d(p, { tone });
}
export const avatarPicker = (current, name = 'avatar_key') => `<div class="ava-pick" role="radiogroup" aria-label="选择头像">${USER_AVATARS.map(([k, label, tone, p]) => `<label class="ava-opt" title="${label}"><input type="radio" name="${name}" value="${k}" ${k === current ? 'checked' : ''}><span class="ava-ball">${avatar3d(p, { tone })}</span><small>${label}</small></label>`).join('')}</div>`;
