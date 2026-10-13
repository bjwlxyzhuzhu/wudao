// 数字客服“思思”：以平台自己的说明文档为知识库做检索增强问答。
// 与平台共享模型配置（API Key 只在服务器端解密使用）；没有模型或超出次数时，直接用本地知识库作答。
// “训练”= 采集文档 → 清洗 → 按章节切分 → 建立检索索引 → 用验证问题检查命中率；不修改模型参数。
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, id, now, getSetting, setSetting, check, audit, json } from './db.js';
import { resolveProvider, chat } from './models.js';
import { brandText } from './brand.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NAME = '思思';
/** 知识来源：[路径, 名称, 权重] */
export const SOURCES = [
  ['docs/客服知识库.md', '客服知识库', 1.35],
  ['docs/教师使用指南.md', '教师使用指南', 1.1],
  ['public/manual/index.html', '演示操作手册', 1.1],
  ['docs/科研数据采集与分析设计.md', '科研数据采集与分析设计', 1],
  ['docs/人物形象替换说明.md', '人物形象说明', 0.9],
  ['README.md', '平台说明', 0.75],
  ['docs/简约性评审与改进记录.md', '简约性评审与改进记录', 0.7],
  ['docs/五位专家审核意见与整改记录.md', '专家审核与整改记录', 0.65],
];
/** 检索验证：问题 + 期望命中的关键词（前 3 个片段中出现即算命中） */
const VALIDATION = [
  ['怎么注册账号？', '注册'], ['退出时怎么清空缓存？', '清空缓存'], ['怎么把课件送到演课场上课？', '送到演课场上课'],
  ['课堂反馈怎么带回研课场修订？', '返回研课场继续改进'], ['模拟演示和大模型运行有什么区别？', '不扣积分'], ['积分怎么获得？', '管理员'],
  ['怎么训练教师智能体？', '导入数据训练'], ['怎么导入班级画像？', '画像'], ['盲评模式是什么？', '盲评'],
  ['怎么计算量表信度？', 'Cronbach'], ['上课太慢怎么办？', '倍速'], ['研课场画面太复杂怎么办？', '简洁视图'],
  ['怎么更换头像？', '头像'], ['研课八步是哪八步？', '对抗质询'],
];

// ---------- 文本处理 ----------
const QSTOP = new Set(['怎么', '么办', '如何', '什么', '为什', '么是', '可以', '请问', '一下', '我想', '能不', '不能', '是不', '不是', '哪里', '在哪', '哪个', '有没', '没有', '一个', '这个', '那个', '需要', '要怎', '怎样', '吗？', '的是', '是什', '么时', '时候', '我的', '我们', '你们', '平台', '系统']);
const SYN = [[/登陆/g, '登录'], [/注销/g, '退出'], [/账户/g, '账号'], [/客服|数字人/g, '思思'], [/打分/g, '评分'], [/试验场|模拟课堂|上课场/g, '演课场'], [/教研室|备课/g, '研课场'], [/清除/g, '清空'], [/缓存/g, '缓存 清空缓存'], [/速度|太慢|快点/g, '倍速'], [/信度/g, '信度 Cronbach'], [/头像|形象/g, '头像 形象']];
const clean = (s) => String(s).replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\s*[-*+]\s+/gm, '· ').replace(/^\s*>\s?/gm, '').replace(/\|/g, ' ｜ ').replace(/[ \t]+/g, ' ').trim();
const norm = (s) => String(s).toLowerCase().normalize('NFKC').replace(/[\s，。、；：！？,.;:!?“”"'（）()【】\[\]《》<>…—\-·｜|/\\]+/g, ' ');
function grams(s) { const out = new Map(); for (const w of norm(s).split(' ')) { if (!w) continue; if (w.length === 1) out.set(w, (out.get(w) || 0) + 1); for (let i = 0; i + 1 < w.length; i++) { const g = w.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); } } return out; }
const unent = (s) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** 按标题切分为片段：{ doc, section, text } */
function splitDoc(path, name) {
  const raw = readFileSync(join(ROOT, path), 'utf8');
  let md = raw;
  if (path.endsWith('.html')) {
    md = raw.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<header[\s\S]*?<\/header>|<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n').replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
      .replace(/<(li|p|tr|div)[^>]*>/gi, '\n').replace(/<\/td>\s*<td[^>]*>/gi, '：').replace(/<[^>]+>/g, '');
    md = unent(md);
  }
  const out = []; const path2 = []; let buf = [];
  const flush = () => {
    // 去掉只有步骤编号的行与空行（来自手册 HTML 的编号圆点）
    const text = clean(buf.filter((l) => !/^\s*\d{1,2}\s*$/.test(l)).join('\n')).split('\n').map((l) => l.trim()).filter(Boolean).join('\n'); buf = [];
    if (text.replace(/[·\s]/g, '').length < 12) return;
    const section = path2.filter(Boolean).join(' · ') || name;
    // 过长片段按句子再切，每段 ≤ 520 字
    const sents = text.split(/(?<=[。！？；\n])/); let cur = '';
    for (const s of sents) { if ((cur + s).length > 520 && cur) { out.push({ doc: name, section, text: cur.trim() }); cur = ''; } cur += s; }
    if (cur.trim()) out.push({ doc: name, section, text: cur.trim() });
  };
  for (const line of md.split(/\r?\n/)) {
    const h = /^(#{1,4})\s+(.+)/.exec(line);
    if (h) { flush(); const lv = h[1].length; if (lv === 1) { path2.length = 0; continue; } path2.length = Math.max(0, lv - 2); path2[lv - 2] = clean(h[2]).replace(/\s*<small>.*$/, ''); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

// ---------- 索引 ----------
let INDEX = null;
function buildIndex() {
  const chunks = [], per = [];
  for (const [path, name, w] of SOURCES) {
    if (!existsSync(join(ROOT, path))) { per.push({ doc: name, path, chunks: 0, chars: 0, missing: true }); continue; }
    const cs = splitDoc(path, name).map((c) => ({ ...c, weight: w }));
    per.push({ doc: name, path, chunks: cs.length, chars: cs.reduce((a, c) => a + c.text.length, 0) });
    chunks.push(...cs);
  }
  const df = new Map();
  for (const c of chunks) { c.g = grams(`${c.section} ${c.text}`); c.tg = grams(c.section); c.len = [...c.g.values()].reduce((a, b) => a + b, 0); for (const k of c.g.keys()) df.set(k, (df.get(k) || 0) + 1); }
  const avg = chunks.reduce((a, c) => a + c.len, 0) / Math.max(1, chunks.length);
  return { chunks, df, avg, N: chunks.length, per };
}
const ensure = () => (INDEX ||= buildIndex());

/** BM25（字二元组）+ 章节标题加权 + 来源权重 */
export function retrieve(question, k = 5) {
  const ix = ensure();
  let q = String(question || ''); for (const [re, rep] of SYN) q = q.replace(re, (m) => `${m} ${rep}`);
  const qg = [...grams(q).keys()].filter((g) => g.length === 2 && !QSTOP.has(g));
  if (!qg.length) return [];
  const K1 = 1.2, B = 0.7;
  const scored = ix.chunks.map((c) => {
    let s = 0;
    for (const g of qg) {
      const tf = c.g.get(g); if (!tf) continue;
      const idf = Math.log(1 + (ix.N - (ix.df.get(g) || 0) + 0.5) / ((ix.df.get(g) || 0) + 0.5));
      s += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * c.len) / ix.avg))) * (c.tg.has(g) ? 1.6 : 1);
    }
    return { c, s: s * c.weight };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  const seen = new Set(), out = [];
  for (const x of scored) { const key = `${x.c.doc}|${x.c.section}|${x.c.text.slice(0, 40)}`; if (seen.has(key)) continue; seen.add(key); out.push({ doc: x.c.doc, section: x.c.section, text: x.c.text, score: Math.round(x.s * 100) / 100 }); if (out.length >= k) break; }
  return out;
}

// ---------- 训练（重建知识索引并验证） ----------
export function train(db, user) {
  const stages = [], t0 = Date.now();
  const stage = (key, label, fn) => { const s = Date.now(); const detail = fn(); stages.push({ key, label, detail, ms: Date.now() - s }); };
  let ix;
  stage('collect', '采集平台文档', () => `${SOURCES.length} 份说明文档：${SOURCES.map((s) => `《${s[1]}》`).join('、')}`);
  stage('clean', '清洗与切分', () => { INDEX = null; ix = ensure(); return `去除格式标记，按章节切分为 ${ix.N} 个知识片段`; });
  stage('index', '建立检索索引', () => `字二元组 BM25 索引：${ix.df.size} 个索引项，章节标题加权，客服知识库优先`);
  let hit = 0; const items = [];
  stage('verify', '检索验证', () => {
    for (const [q, expect] of VALIDATION) { const top = retrieve(q, 3); const ok = top.some((t) => `${t.section} ${t.text}`.includes(expect)); if (ok) hit++; items.push({ question: q, expect, top: top[0] ? `${top[0].doc} · ${top[0].section}` : '（无）', ok }); }
    return `${VALIDATION.length} 个验证问题，前 3 条命中 ${hit} 个（${Math.round((hit / VALIDATION.length) * 100)}%）`;
  });
  const result = { name: NAME, trained_at: now(), ms: Date.now() - t0, stages, stats: { docs: ix.per.filter((p) => !p.missing).length, chunks: ix.N, terms: ix.df.size, chars: ix.per.reduce((a, p) => a + p.chars, 0) }, sources: ix.per, validation: { total: VALIDATION.length, hit, items },
    method: '检索增强（知识库检索 + 平台共享模型组织语言），不是模型微调' };
  if (db) { setSetting(db, 'assistant_trained', JSON.stringify({ trained_at: result.trained_at, stats: result.stats, validation: { total: result.validation.total, hit } }), user?.user_id || null); if (user) audit(db, { actor: user, action: 'assistant_trained', detail: result.stats }); }
  return result;
}
export function status(db) {
  const ix = ensure(); const p = resolveProvider(db); const last = json(getSetting(db, 'assistant_trained'), null);
  return { name: NAME, trained_at: last?.trained_at || null, stats: last?.stats || { docs: ix.per.filter((x) => !x.missing).length, chunks: ix.N, terms: ix.df.size }, validation: last?.validation || null,
    model_enabled: getSetting(db, 'assistant_model') !== '0', model_available: !p.error, model_name: p.config?.name || null, hourly_limit: Number(getSetting(db, 'assistant_hourly_limit') || 30), sources: ix.per,
    method: '检索增强（知识库检索 + 平台共享模型组织语言），不是模型微调' };
}

// ---------- 问答 ----------
const PAGE = { '/': '首页', '/seminar': '研课场', '/classroom': '演课场', '/library': '产物库', '/agents': '智能体中心', '/research': '评价与科研', '/rating': '人工评分', '/export': '平台过程数据导出', '/account': '账号、积分与备份', '/login': '登录页' };
const recent = new Map(); // key → [timestamps]
function allow(key, limit) { const t = Date.now(), arr = (recent.get(key) || []).filter((x) => t - x < 3600e3); if (arr.length >= limit) { recent.set(key, arr); return false; } arr.push(t); recent.set(key, arr); return true; }
const SYSTEM_RAW = `你是“思思”，研思智境平台（“研—演—评—改”多智能体数字教研实验工坊）的数字客服老师，温和、耐心、专业。
规则：
1. 只依据【资料】回答平台的功能、操作步骤和业务流程；资料里没有的，直接说“平台资料里没有这方面的说明”，建议查看顶栏📖操作手册或联系管理员。不要猜测，不要编造按钮、功能、数字或政策。
2. 先给结论，再用 1. 2. 3. 列出操作步骤；按钮和菜单名用“”标出；一般不超过 200 字，口语化，便于朗读。
3. 不输出表格、代码、网址格式或 Markdown 标题，不要说“根据资料”。
4. 涉及密码、开通账号、积分分配、模型与 API Key 配置时，提醒联系管理员；不要索取密码或个人信息。
5. 与本平台使用无关的问题，礼貌说明你只负责解答研思智境的使用问题。`;
const SYSTEM = brandText(SYSTEM_RAW);

function localAnswer(q, hits, note) {
  if (!hits.length || hits[0].score < 1.5) return { answer: `这个问题我在平台资料里没有找到明确说明。可以换个说法再问我，或者点顶栏的📖“操作手册”查看图文步骤；账号、积分、模型配置方面的问题请联系管理员。`, mode: 'local', sources: [], note };
  const cut = (t, n) => { if (t.length <= n) return t; const i = t.slice(0, n).search(/[。；！？][^。；！？]*$/); return `${t.slice(0, i > n * 0.5 ? i + 1 : n)}……`; };
  const a = hits[0], b = hits.find((h, i) => i > 0 && h.section !== a.section && h.score > a.score * 0.7);
  const answer = `关于“${a.section.split(' · ').pop()}”：\n${cut(a.text, 300)}${b ? `\n\n另外（${b.section.split(' · ').pop()}）：${cut(b.text, 140)}` : ''}`;
  return { answer, mode: 'local', sources: [a, b].filter(Boolean).map(({ doc, section }) => ({ doc, section })), note };
}

export async function ask(db, user, input, opts = {}) {
  const r = await askRaw(db, user, input, opts);
  return { ...r, answer: brandText(r.answer) };
}
async function askRaw(db, user, input, { publicMode = false, ip = '' } = {}) {
  const q = String(input.question || '').trim().slice(0, 500);
  check(q, 400, 'empty', '请输入问题');
  const pageName = PAGE[input.page] || '';
  const hits = retrieve(`${q}${/这里|这个页面|本页|当前|这页/.test(q) && pageName ? ` ${pageName}` : ''}`, 5);
  if (publicMode) { check(allow(`ip:${ip}`, 60), 429, 'rate_limited', '提问太频繁，请稍后再试'); return localAnswer(q, hits, '登录前使用本地知识库回答'); }
  const limit = Number(getSetting(db, 'assistant_hourly_limit') || 30);
  const p = resolveProvider(db);
  if (getSetting(db, 'assistant_model') === '0') return localAnswer(q, hits, '管理员已设置为仅用本地知识库回答');
  if (p.error) return localAnswer(q, hits, '平台尚未配置大模型，使用本地知识库回答');
  if (!allow(`u:${user.user_id}`, limit)) return localAnswer(q, hits, `本小时的大模型问答次数（${limit} 次）已用完，改用本地知识库回答`);
  const history = (Array.isArray(input.history) ? input.history : []).slice(-6).filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string').map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
  const context = hits.length ? hits.map((h, i) => `[${i + 1}]《${h.doc}》${h.section}\n${h.text}`).join('\n\n') : '（没有检索到相关资料）';
  const call_id = id('call'), t0 = Date.now(), cfg = p.config;
  run(db, 'INSERT INTO model_calls(call_id,run_id,user_id,provider_id,model_id,key_version,purpose,actor_id,status,request_at,credits) VALUES(?,?,?,?,?,?,?,?,?,?,0)', call_id, null, user.user_id, cfg.provider_id, cfg.model_id, cfg.key_version, 'assistant', 'sisi', 'pending', now());
  try {
    const out = await chat(cfg, { system: SYSTEM, max_tokens: 700, messages: [...history, { role: 'user', content: `【资料】\n${context}\n\n【用户当前页面】${pageName || '未知'}\n【问题】${q}` }] });
    const text = out.text.trim();
    run(db, "UPDATE model_calls SET status='succeeded', completed_at=?, latency_ms=?, input_tokens=?, output_tokens=?, request_id=?, first_token_at=? WHERE call_id=?", now(), Date.now() - t0, out.input_tokens, out.output_tokens, out.request_id, out.first_token_at, call_id);
    if (!text) return localAnswer(q, hits, '大模型没有返回内容，改用本地知识库回答');
    return { answer: text, mode: 'model', model_name: cfg.name, sources: hits.slice(0, 3).map(({ doc, section }) => ({ doc, section })) };
  } catch (e) {
    run(db, "UPDATE model_calls SET status='failed', error_code=?, error_message=?, completed_at=?, latency_ms=? WHERE call_id=?", e.code || 'provider_error', String(e.message).slice(0, 300), now(), Date.now() - t0, call_id);
    return localAnswer(q, hits, `大模型暂时不可用（${e.message}），改用本地知识库回答`);
  }
}
