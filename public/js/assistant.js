// 数字客服“思思”：屏幕右下角的水晶球数字人。点她展开对话；回答用浏览器自带的中文语音合成朗读（本机合成，不上传）。
// 登录后与平台共享大模型（API Key 只在服务器）；登录前或没有模型时，用平台说明文档构成的本地知识库回答。
import { post, get } from './api.js';
import { esc, $ } from './ui.js';
import { sisiAvatar } from './avatar3d.js';

const K_HIST = 'yz-sisi-history', K_VOICE = 'yz-sisi-voice', K_SEEN = 'yz-sisi-seen';
const SUGGEST = {
  '/login': ['怎么注册账号？', '忘记密码怎么办？', '思思是谁？'],
  '/': ['怎么从头演示一门课？', '模拟演示和大模型运行有什么区别？', '积分怎么获得？'],
  '/seminar': ['怎么新建任务？', '研课八步是哪八步？', '画面太复杂怎么办？'],
  '/classroom': ['怎么开始上课？', '怎么选择班级画像？', '下课后怎么修订课件？'],
  '/library': ['怎么把课件送到演课场上课？', '怎么导入表格？', '历史版本在哪里看？'],
  '/agents': ['怎么训练教师智能体？', '怎么导入班级画像？', '怎么设置自定义教师？'],
  '/research': ['怎么导入被试名册？', '怎么计算量表信度？', '怎么导出研究数据包？'],
  '/rating': ['盲评模式是什么？', '怎么导入自定义量规？', '怎么看评分一致性？'],
  '/account': ['怎么更换头像？', '怎么修改密码？', '退出时怎么清空缓存？'],
};
const WELCOME = '你好，我是思思，研思智境的数字客服老师。平台的功能和操作流程都可以问我，比如“怎么把课件送到演课场上课”。点 🔊 可以打开或关闭语音朗读。';
const load = (k, d) => { try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const pref = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const plain = (t) => String(t).replace(/[#*`>|_]/g, '').replace(/\n+/g, '。').replace(/。{2,}/g, '。');

export function mountAssistant({ isAuthed }) {
  if (document.getElementById('sisi')) return;
  const box = document.createElement('div'); box.id = 'sisi'; box.className = 'sisi';
  box.innerHTML = `<button type="button" class="sisi-orb" id="sisi-orb" aria-expanded="false" aria-controls="sisi-panel" title="数字客服思思：点我提问">${sisiAvatar()}<span class="sisi-wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="sisi-name">思思</span></button>
    <div class="sisi-tip" id="sisi-tip" hidden>我是思思～平台怎么用，都可以问我</div>
    <section class="sisi-panel" id="sisi-panel" role="dialog" aria-label="数字客服思思" hidden>
      <header><span class="sisi-hava">${sisiAvatar()}</span><div class="sisi-ht"><b>思思 · 数字客服</b><small id="sisi-mode">平台使用问答</small></div>
        <button type="button" class="sisi-ic" id="sisi-voice" aria-pressed="true" title="语音朗读：开">🔊</button><button type="button" class="sisi-ic" id="sisi-clear" title="清空对话" aria-label="清空对话">🗑</button><button type="button" class="sisi-ic" id="sisi-close" aria-label="关闭">✕</button></header>
      <div class="sisi-msgs" id="sisi-msgs" aria-live="polite"></div>
      <div class="sisi-sug" id="sisi-sug"></div>
      <form class="sisi-form" id="sisi-form" autocomplete="off"><textarea id="sisi-q" rows="1" maxlength="500" placeholder="问思思，例如：怎么把课件送到演课场？（Enter 发送）" aria-label="向思思提问"></textarea><button type="submit" class="primary" id="sisi-send">发送</button></form>
    </section>`;
  document.body.appendChild(box);
  const panel = $('#sisi-panel', box), msgs = $('#sisi-msgs', box), orb = $('#sisi-orb', box);
  let hist = load(K_HIST, []), busy = false, voiceOn = pref(K_VOICE, '1') !== '0';

  // ---------- 语音朗读（Web Speech API） ----------
  const synth = window.speechSynthesis || null;
  const pickVoice = () => { const vs = synth?.getVoices() || []; return vs.find((v) => /zh[-_]CN/i.test(v.lang) && /Xiaoxiao|Xiaoyi|Huihui|Yaoyao|Tingting|Female|女/i.test(v.name)) || vs.find((v) => /zh[-_](CN|Hans)/i.test(v.lang)) || vs.find((v) => /^zh/i.test(v.lang)) || null; };
  const stop = () => { try { synth?.cancel(); } catch { /* ignore */ } box.classList.remove('speaking'); };
  const speak = (text) => {
    if (!synth) return false;
    stop();
    const parts = plain(text).split(/(?<=[。！？；])/).map((s) => s.trim()).filter(Boolean);
    const v = pickVoice(); let left = parts.length;
    parts.forEach((p) => { const u = new SpeechSynthesisUtterance(p); u.lang = 'zh-CN'; if (v) u.voice = v; u.rate = 1.02; u.pitch = 1.15; u.onstart = () => box.classList.add('speaking'); u.onend = u.onerror = () => { if (--left <= 0) box.classList.remove('speaking'); }; synth.speak(u); });
    return true;
  };
  const drawVoice = () => { const b = $('#sisi-voice', box); b.textContent = voiceOn ? '🔊' : '🔇'; b.setAttribute('aria-pressed', String(voiceOn)); b.title = synth ? `语音朗读：${voiceOn ? '开' : '关'}` : '当前浏览器不支持语音朗读'; };

  // ---------- 渲染 ----------
  const bubble = (m, i) => m.role === 'user'
    ? `<div class="sisi-m u"><p>${esc(m.content)}</p></div>`
    : `<div class="sisi-m a"><span class="sisi-mava">${sisiAvatar()}</span><div><p>${esc(m.content).replace(/\n/g, '<br>')}</p>
        ${m.sources?.length ? `<small class="sisi-src">来源：${m.sources.map((s) => `《${esc(s.doc)}》${esc(s.section.split(' · ').pop())}`).join('；')}</small>` : ''}
        ${m.note ? `<small class="sisi-note">${esc(m.note)}</small>` : ''}
        ${i != null ? `<button type="button" class="sisi-play" data-play="${i}" title="朗读这条回答">▶ 朗读</button>` : ''}</div></div>`;
  const draw = () => {
    msgs.innerHTML = bubble({ role: 'assistant', content: WELCOME }, null) + hist.map((m, i) => bubble(m, m.role === 'assistant' ? i : null)).join('') + (busy ? `<div class="sisi-m a"><span class="sisi-mava">${sisiAvatar()}</span><div><p class="sisi-typing"><i></i><i></i><i></i></p></div></div>` : '');
    msgs.scrollTop = msgs.scrollHeight;
    msgs.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => { if (!speak(hist[+b.dataset.play].content)) b.textContent = '当前浏览器不支持朗读'; }));
    const sug = SUGGEST[location.pathname] || SUGGEST['/'];
    $('#sisi-sug', box).innerHTML = sug.map((s) => `<button type="button" class="sisi-chip">${esc(s)}</button>`).join('');
    $('#sisi-sug', box).querySelectorAll('.sisi-chip').forEach((c) => c.addEventListener('click', () => ask(c.textContent)));
  };
  const refreshMode = async () => {
    const el = $('#sisi-mode', box);
    if (!isAuthed()) { el.textContent = '登录前：本地知识库回答'; return; }
    try { const s = await get('/api/assistant/status'); el.textContent = s.model_enabled && s.model_available ? `大模型：${s.model_name || '已配置'} · 不扣积分` : '本地知识库回答（未启用大模型）'; } catch { el.textContent = '平台使用问答'; }
  };
  async function ask(q) {
    q = String(q || '').trim(); if (!q || busy) return;
    hist.push({ role: 'user', content: q }); busy = true; draw();
    try {
      const r = isAuthed()
        ? await post('/api/assistant/ask', { question: q, page: location.pathname, history: hist.slice(-7, -1).map(({ role, content }) => ({ role, content })) })
        : await post('/api/assistant/public-ask', { question: q, page: location.pathname });
      hist.push({ role: 'assistant', content: r.answer, sources: r.sources || [], note: r.note || '', mode: r.mode });
      if (voiceOn) speak(r.answer);
    } catch (e) { hist.push({ role: 'assistant', content: `抱歉，刚才没能回答：${e.message}`, sources: [] }); }
    busy = false; hist = hist.slice(-30); save(K_HIST, hist); draw();
  }
  const open = (on) => {
    panel.hidden = !on; orb.setAttribute('aria-expanded', String(on)); box.classList.toggle('open', on);
    $('#sisi-tip', box).hidden = true; setPref(K_SEEN, '1');
    if (on) { draw(); refreshMode(); setTimeout(() => $('#sisi-q', box).focus(), 50); } else stop();
  };
  orb.addEventListener('click', () => open(panel.hidden));
  $('#sisi-close', box).addEventListener('click', () => open(false));
  $('#sisi-voice', box).addEventListener('click', () => { voiceOn = !voiceOn; setPref(K_VOICE, voiceOn ? '1' : '0'); if (!voiceOn) stop(); drawVoice(); });
  $('#sisi-clear', box).addEventListener('click', () => { hist = []; save(K_HIST, hist); stop(); draw(); });
  $('#sisi-form', box).addEventListener('submit', (e) => { e.preventDefault(); const t = $('#sisi-q', box); const q = t.value; t.value = ''; ask(q); });
  $('#sisi-q', box).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#sisi-form', box).requestSubmit(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden && !document.querySelector('.modal-back')) open(false); });
  window.addEventListener('yz:sisi-open', () => open(true));
  drawVoice();
  if (pref(K_SEEN, '0') !== '1') { const tip = $('#sisi-tip', box); tip.hidden = false; setTimeout(() => { tip.hidden = true; }, 8000); }
  synth?.getVoices(); // 预加载语音列表
  return { open, ask, stop };
}
