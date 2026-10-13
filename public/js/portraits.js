import { crystalOrb } from './avatar3d.js';
// Local vector character library (fictional identities, no remote assets).
// Appearance is chosen by index only and carries no information about ability or personality.
const SKIN = ['#f3c7a5', '#e6ad89', '#ffd9b8', '#d9a17e', '#f6cfb0'];
const HAIR = ['#302634', '#503431', '#242938', '#817269', '#1d1a1f', '#6b4a3a'];
const COAT = ['#b93d52', '#44787a', '#394e76', '#bf8550', '#726086', '#546e5b', '#8a3b4f', '#3f6a8a'];

export function portrait(index = 0, { teacher = false } = {}) {
  const i = Math.abs(Number(index) || 0);
  const skin = SKIN[i % SKIN.length], hair = HAIR[(i >> 1) % HAIR.length], coat = teacher ? ['#7d1628', '#2f3d5c', '#4a3b2a'][i % 3] : COAT[(i >> 2) % COAT.length];
  const style = i % 4; // 0 short, 1 long, 2 bun, 3 side part
  const glasses = (i >> 3) % 3 === 1;
  const smile = (i >> 1) % 2 ? 72 : 69;
  const back = style === 1 ? `<path d="M22 38Q20 5 51 8Q81 7 81 44L85 87H17Z" fill="${hair}"/>` : '';
  const bun = style === 2 ? `<circle cx="50" cy="8" r="10" fill="${hair}"/>` : '';
  const top = style === 3 ? `<path d="M24 42Q18 8 50 7Q82 6 77 42L70 26Q52 30 32 22Q28 32 24 42" fill="${hair}"/>` : `<path d="M24 40Q15 8 47 7Q81 4 77 41L66 30Q48 35 41 22Q37 35 24 40" fill="${hair}"/>`;
  const tie = teacher ? `<path d="M47 84L50 81L53 84L51 100H49Z" fill="#eec486"/>` : '';
  const g = glasses ? `<rect x="29" y="44" width="17" height="13" rx="5" fill="#fff" fill-opacity=".15" stroke="${hair}" stroke-width="2"/><rect x="54" y="44" width="17" height="13" rx="5" fill="#fff" fill-opacity=".15" stroke="${hair}" stroke-width="2"/><path d="M46 49H54" stroke="${hair}" stroke-width="2"/>` : '';
  return `<svg viewBox="0 0 100 110" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">${back}${bun}<path d="M12 110V94Q16 76 40 77H60Q84 76 89 96V110" fill="${coat}"/><path d="M41 72V83L50 92L60 83V71" fill="${skin}"/><path d="M39 79L50 91L43 99L31 82M61 79L50 91L57 99L69 82" fill="#fff4e5"/>${tie}<ellipse cx="25" cy="49" rx="6" ry="9" fill="${skin}"/><ellipse cx="75" cy="49" rx="6" ry="9" fill="${skin}"/><rect x="25" y="18" width="50" height="60" rx="24" fill="${skin}"/>${top}${g}<path d="M32 39Q38 36 44 39M56 39Q62 36 68 39" stroke="${hair}" stroke-width="2.5" fill="none" stroke-linecap="round"/><ellipse cx="38" cy="49" rx="2.5" ry="3.5" fill="#302534"/><ellipse cx="62" cy="49" rx="2.5" ry="3.5" fill="#302534"/><path d="M49 50L47 58H52" stroke="#c28e71" stroke-width="1.8" fill="none" stroke-linecap="round"/><ellipse cx="33" cy="60" rx="6" ry="3" fill="#e99792" opacity=".45"/><ellipse cx="67" cy="60" rx="6" ry="3" fill="#e99792" opacity=".45"/><path d="M42 65Q50 ${smile} 58 65" stroke="#a45c5c" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;
}

export function humanBadge() {
  // 真人（教师用户）同样放在水晶球中，以青色玻璃与“真人”字样区分于智能体
  return crystalOrb('<circle cx="60" cy="50" r="21" fill="#1f7f7f" opacity=".85"/><path d="M18 124Q22 80 60 80Q98 80 102 124Z" fill="#1f7f7f" opacity=".85"/><text x="60" y="57" text-anchor="middle" font-size="17" fill="#fff" font-weight="700">真人</text>', { tone: 'h' });
}
