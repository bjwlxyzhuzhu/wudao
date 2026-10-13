// 智能体中心：固定教师团队（8 位）+ 自定义教师（2 位）、固定学生姓名、教师“数据训练”（知识与风格注入）、学生群体画像导入。
// 说明：这里的“训练”不修改任何大模型参数，而是把教师自己的真实教学资料去标识化、切分、提取风格特征，
// 研讨时按需检索并注入该教师的发言（本地生成直接引用；大模型模式写入提示词）。所有统计均来自真实导入数据。
import { createHash } from 'node:crypto';
import { one, all, run, id, now, tx, check, fail, audit, json } from './db.js';
import { extractText, piiScan, redact, BASE_IDEOLOGY_TERMS } from './materials.js';
import { SEMINAR_ROLES } from './templates.js';

// ---------- 固定教师团队（虚构姓名，形象参数只决定外观） ----------
export const TEACHER_ROSTER = {
  leader: { person: '陈立诚', gender: 'm', age: 52, look: { hair: 'side', hairColor: '#3a3a3f', grey: 0.45, glasses: 'rect', cloth: 'suit', color: '#27324d', tie: '#8e1426', skin: 1 } },
  designer: { person: '林知远', gender: 'm', age: 35, look: { hair: 'wave', hairColor: '#241c1a', glasses: 'round', cloth: 'vest', color: '#4a4f5c', shirt: '#eef2f6', skin: 0 } },
  subject: { person: '苏婉清', gender: 'f', age: 40, look: { hair: 'long', hairColor: '#2a1d1a', cloth: 'blazer', color: '#2f3a52', shirt: '#ffffff', earring: true, skin: 2 } },
  ideology: { person: '许嘉宁', gender: 'f', age: 38, look: { hair: 'bob', hairColor: '#1e1717', cloth: 'blazer', color: '#9e1b32', shirt: '#fff6ee', pin: true, skin: 0 } },
  assessor: { person: '周衡远', gender: 'm', age: 56, look: { hair: 'short', hairColor: '#4a4a4c', grey: 0.7, glasses: 'rect', cloth: 'suit', color: '#1f3b57', tie: '#6b4f2a', skin: 3 } },
  evidence: { person: '郑守真', gender: 'm', age: 49, look: { hair: 'side', hairColor: '#2b2626', grey: 0.2, glasses: 'rect', cloth: 'suit', color: '#474b52', tie: '#2f4a6b', skin: 1 } },
  industry: { person: '高振宇', gender: 'm', age: 44, look: { hair: 'crop', hairColor: '#1d1a19', cloth: 'jacket', color: '#35506a', shirt: '#dfe7ef', skin: 3 } },
  junior: { person: '李一诺', gender: 'f', age: 29, look: { hair: 'pony', hairColor: '#3a2620', cloth: 'cardigan', color: '#c7856b', shirt: '#fffaf2', skin: 2 } },
};
export const FIXED_TEACHERS = Object.keys(TEACHER_ROSTER);
export const CUSTOM_SLOTS = ['custom1', 'custom2'];
export const CUSTOM_PRESETS = [
  { title: '专业课教师', duty: '讲授本专业核心课程，关注知识体系与实践能力', prompt: '你是一名有十余年教龄的专业课教师，熟悉本专业核心课程与实验实训。发言时先说清专业概念与适用条件，再结合典型工程或实践案例，给出可执行的教学建议。' },
  { title: '专业博导', duty: '学科前沿、研究方法与学术规范', prompt: '你是本学科的博士生导师，长期从事科研与研究生培养。发言时关注知识点背后的科学问题、研究前沿与学术规范，指出教学内容与学科发展的联系，但避免超出本科学生的接受程度。' },
  { title: '企业工程师', duty: '一线生产工艺、质量标准与岗位要求', prompt: '你是企业一线工程师，熟悉生产现场、质量标准与岗位能力要求。发言时用真实岗位中的做法检验教学设计是否贴近实际，指出学生上岗后最容易出错的环节。' },
  { title: '教学督导', duty: '课堂规范、教学目标达成与评价', prompt: '你是学校教学督导，听课经验丰富。发言时关注教学目标是否清楚、环节是否紧凑、评价是否与目标一致，给出具体、可操作的改进意见。' },
];
export const CUSTOM_LOOKS = [
  { gender: 'm', age: 46, look: { hair: 'short', hairColor: '#2a2522', grey: 0.25, glasses: 'rect', cloth: 'suit', color: '#3c2f4f', tie: '#b98a47', skin: 1 } },
  { gender: 'f', age: 50, look: { hair: 'bun', hairColor: '#2a2020', grey: 0.3, glasses: 'round', cloth: 'blazer', color: '#23434a', shirt: '#f6f1ea', skin: 0 } },
];

// ---------- 固定学生姓名（虚构；40 人以上按姓 × 名组合确定性生成） ----------
export const STUDENT_NAMES = [
  ['赵子涵', 'f'], ['钱浩宇', 'm'], ['孙雨桐', 'f'], ['李俊杰', 'm'], ['周欣怡', 'f'], ['吴宇航', 'm'], ['郑可馨', 'f'], ['王梓睿', 'm'],
  ['冯诗琪', 'f'], ['陈博文', 'm'], ['褚佳怡', 'f'], ['卫思源', 'm'], ['蒋雨萱', 'f'], ['沈子墨', 'm'], ['韩梦瑶', 'f'], ['杨晨阳', 'm'],
  ['朱安琪', 'f'], ['秦一鸣', 'm'], ['许若溪', 'f'], ['何嘉诚', 'm'], ['吕静怡', 'f'], ['施天佑', 'm'], ['张语桐', 'f'], ['孔明轩', 'm'],
  ['曹心悦', 'f'], ['严志远', 'm'], ['华思彤', 'f'], ['金奕辰', 'm'], ['魏晓雯', 'f'], ['陶宇轩', 'm'], ['姜乐瑶', 'f'], ['戚振华', 'm'],
  ['谢婉婷', 'f'], ['邹子轩', 'm'], ['喻可欣', 'f'], ['柏昊天', 'm'], ['水清妍', 'f'], ['窦铭泽', 'm'], ['章雅静', 'f'], ['云浩然', 'm'],
];
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳';
const GIVEN = [['子航', 'm'], ['思雨', 'f'], ['浩然', 'm'], ['欣妍', 'f'], ['晨曦', 'f'], ['明哲', 'm'], ['诗涵', 'f'], ['嘉懿', 'm'], ['雨泽', 'm'], ['梦洁', 'f'], ['一凡', 'm'], ['语嫣', 'f'], ['俊熙', 'm'], ['佳琪', 'f'], ['泽宇', 'm'], ['静雯', 'f']];
export function studentIdentity(i) {
  if (i < STUDENT_NAMES.length) return { name: STUDENT_NAMES[i][0], gender: STUDENT_NAMES[i][1] };
  const k = i - STUDENT_NAMES.length, s = SURNAMES[k % SURNAMES.length], g = GIVEN[Math.floor(k / SURNAMES.length) % GIVEN.length];
  return { name: `${s}${g[0]}${k >= SURNAMES.length * GIVEN.length ? Math.floor(k / (SURNAMES.length * GIVEN.length)) + 1 : ''}`, gender: g[1] };
}

// ---------- 采集原则（教师资料 / 学生群体数据共用，界面逐条展示并要求确认） ----------
export const COLLECTION_PRINCIPLES = [
  ['知情同意', '资料属于你本人，或已获得作者书面授权；涉及他人的课堂实录须征得当事人同意。'],
  ['最小必要', '只导入与该教师智能体职责相关的资料，如教案、讲稿、说课稿、评课记录、教研发言。'],
  ['去标识化', '不包含学生姓名、学号、手机号、身份证号、成绩单等个人信息；系统会再次自动检测并隐去。'],
  ['版权合规', '教材、论文等受版权保护的内容只导入你有权使用的部分，并保留出处。'],
  ['真实可追溯', '资料应来自真实教学活动，文件名注明来源与时间（如“2025秋·公差配合·说课稿”）。'],
  ['代表性', '尽量覆盖不同课型、学段与学生层次，避免只用个别“精品课”导致风格失真。'],
  ['质量', '文字完整、无乱码；扫描件需先做文字识别；单次建议 3—20 份、每份 1 万字以内。'],
  ['可撤回', '导入的资料可以随时删除，删除后不再参与该智能体的发言。'],
];
export const STUDENT_DATA_PRINCIPLES = [
  ['匿名代号', '用代号（如 S01、A-07）代替姓名；姓名、学号列会被系统丢弃，不进入平台。'],
  ['群体特征', '只需要能描述学习特点的字段：前测或先修水平、兴趣方向、发言活跃度、质疑倾向、合作倾向、常见误解。'],
  ['合法来源', '数据来自本人任教班级的教学记录或问卷，并已按学校规定告知学生用途。'],
  ['仅用于模拟', '画像只用于生成学生智能体的行为参数，不用于评价任何真实学生。'],
  ['可撤回', '画像可以随时删除，删除后不再用于新开的课堂。'],
];

// ---------- 数据表 ----------
export function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS teacher_agents(owner_id TEXT NOT NULL, agent_key TEXT NOT NULL, title TEXT, person TEXT, duty TEXT, prompt TEXT,
      avatar TEXT, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, agent_key));
    CREATE TABLE IF NOT EXISTS agent_docs(doc_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, agent_key TEXT NOT NULL, filename TEXT NOT NULL, kind TEXT,
      sha256 TEXT NOT NULL, n_chars INTEGER NOT NULL, pii_flags TEXT, train_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_chunks(chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, owner_id TEXT NOT NULL, agent_key TEXT NOT NULL, idx INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ix_chunks_agent ON agent_chunks(owner_id, agent_key);
    CREATE TABLE IF NOT EXISTS agent_trainings(train_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, agent_key TEXT NOT NULL, status TEXT NOT NULL,
      stages TEXT NOT NULL, stats TEXT, profile TEXT, created_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE IF NOT EXISTS class_profiles(profile_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, group_size INTEGER NOT NULL,
      rows TEXT NOT NULL, stats TEXT, stages TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS student_avatars(owner_id TEXT NOT NULL, seat INTEGER NOT NULL, avatar TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, seat));`);
}

const titleOf = (key) => SEMINAR_ROLES[key]?.name || key;
/** 本用户可用的全部教师角色（固定 8 位 + 已启用的自定义），含姓名、职责、提示词与训练画像。 */
export function rolesFor(db, user) {
  const rows = Object.fromEntries(all(db, 'SELECT * FROM teacher_agents WHERE owner_id=?', user.user_id).map((r) => [r.agent_key, r]));
  const trained = Object.fromEntries(all(db, "SELECT agent_key, profile FROM agent_trainings WHERE owner_id=? AND status='done' ORDER BY created_at", user.user_id).map((t) => [t.agent_key, json(t.profile)]));
  const docs = Object.fromEntries(all(db, 'SELECT agent_key, COUNT(*) n FROM agent_docs WHERE owner_id=? GROUP BY agent_key', user.user_id).map((d) => [d.agent_key, d.n]));
  const out = {};
  for (const [k, r] of Object.entries(SEMINAR_ROLES)) {
    const ros = TEACHER_ROSTER[k];
    out[k] = { key: k, name: r.name, title: r.name, duty: r.duty, person: ros?.person || '', fixed: !!ros, custom: false, gender: ros?.gender, age: ros?.age, look: ros?.look, avatar: rows[k]?.avatar || null, docs: docs[k] || 0, style: trained[k] || null };
  }
  CUSTOM_SLOTS.forEach((k, i) => {
    const r = rows[k];
    out[k] = { key: k, name: r?.title || `自定义教师 ${i + 1}`, title: r?.title || `自定义教师 ${i + 1}`, duty: r?.duty || '', person: r?.person || '', prompt: r?.prompt || '', fixed: false, custom: true,
      enabled: !!(r && r.enabled && r.title), gender: CUSTOM_LOOKS[i].gender, age: CUSTOM_LOOKS[i].age, look: CUSTOM_LOOKS[i].look, avatar: r?.avatar || null, docs: docs[k] || 0, style: trained[k] || null };
  });
  return out;
}
export const displayName = (r) => (r.person ? `${r.person} · ${r.title}` : r.title);
/** 运行快照用的角色定义（名称、职责、提示词、风格），研讨各步骤都从这里取，保证可复现。 */
export function roleDefs(db, user, seats) {
  const all_ = rolesFor(db, user);
  return Object.fromEntries(seats.map((k) => { const r = all_[k]; return [k, { name: displayName(r), title: r.title, person: r.person, duty: r.duty, prompt: r.prompt || '', style: r.style ? r.style.summary : '' }]; }));
}

const IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export function saveTeacherAgent(db, user, key, input) {
  check(FIXED_TEACHERS.includes(key) || CUSTOM_SLOTS.includes(key), 404, 'not_found', '没有这个教师智能体');
  const prev = one(db, 'SELECT * FROM teacher_agents WHERE owner_id=? AND agent_key=?', user.user_id, key);
  const v = { title: prev?.title || null, person: prev?.person || null, duty: prev?.duty || null, prompt: prev?.prompt || null, avatar: prev?.avatar || null, enabled: prev ? prev.enabled : 1 };
  if (input.avatar !== undefined) {
    if (input.avatar === null || input.avatar === '') v.avatar = null;
    else { check(IMG.test(input.avatar) && input.avatar.length <= 400000, 400, 'bad_avatar', '形象图片需为 PNG/JPEG/WebP，压缩后不超过约 300KB'); v.avatar = input.avatar; }
  }
  if (CUSTOM_SLOTS.includes(key)) {
    const s = (x, n) => String(x ?? '').trim().slice(0, n);
    if (input.title !== undefined) { v.title = s(input.title, 20); check(v.title.length >= 2, 400, 'bad_title', '请填写角色名称（如“专业博导”）'); }
    if (input.person !== undefined) v.person = s(input.person, 12);
    if (input.duty !== undefined) v.duty = s(input.duty, 60);
    if (input.prompt !== undefined) { v.prompt = s(input.prompt, 1500); check(!/忽略(以上|之前|前面)|ignore (all|previous)/i.test(v.prompt), 400, 'bad_prompt', '提示词中不能包含要求忽略系统规则的内容'); }
    if (input.enabled !== undefined) v.enabled = input.enabled ? 1 : 0;
  } else check(input.title === undefined && input.prompt === undefined && input.duty === undefined, 400, 'fixed_agent', '固定教师的名称、职责与提示词不可修改；可以更换形象或导入资料训练');
  run(db, `INSERT INTO teacher_agents(owner_id,agent_key,title,person,duty,prompt,avatar,enabled,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(owner_id,agent_key) DO UPDATE SET title=excluded.title, person=excluded.person, duty=excluded.duty, prompt=excluded.prompt, avatar=excluded.avatar, enabled=excluded.enabled, updated_at=excluded.updated_at`,
    user.user_id, key, v.title, v.person, v.duty, v.prompt, v.avatar, v.enabled, now());
  audit(db, { actor: user, action: 'teacher_agent_saved', target_type: 'agent', target_id: key, detail: { avatar: input.avatar !== undefined, custom: CUSTOM_SLOTS.includes(key) } });
  return rolesFor(db, user)[key];
}

// ---------- 文本特征（训练与检索共用） ----------
const STOP = new Set(['我们', '你们', '他们', '一个', '这个', '那个', '可以', '进行', '通过', '以及', '如果', '因为', '所以', '但是', '就是', '还是', '已经', '没有', '什么', '这样', '一些', '其中', '需要', '同学', '大家', '老师', '今天', '然后', '问题']);
// 以虚词开头/结尾、或夹着“的/是/了”等的片段不是完整术语
const EDGE = /^[的是了和与在为就也都而及或这那其之被把对从以于中指即有等个些]|[的是了和与在为就也都而及或这那其之被把对从以于指即有等个些使]$/;
const MIDDLE = /[的是了]/;
const cjkRuns = (t) => String(t).match(/[一-龥]{2,}/g) || [];
export function keyTerms(text, n = 12) {
  const cnt = new Map();
  for (const r of cjkRuns(text)) for (let L = 2; L <= 6; L++) for (let i = 0; i + L <= r.length; i++) { const w = r.slice(i, i + L); if (!STOP.has(w) && !EDGE.test(w) && !MIDDLE.test(w)) cnt.set(w, (cnt.get(w) || 0) + 1); }
  // 去掉被更长且同频的词覆盖的子串，优先完整术语
  const w8 = (w, c) => c * Math.min(w.length, 4);
  // 闭合性：若向左或向右多一个字后出现次数不变，说明它只是更长短语的片段
  const exts = new Map(); for (const [w, c] of cnt) if (w.length >= 3) for (const sub of [w.slice(1), w.slice(0, -1)]) if ((cnt.get(sub) || 0) === c) exts.set(sub, true);
  const cand = [...cnt.entries()].filter(([w, c]) => c >= (w.length >= 5 ? 3 : 2) && !exts.has(w)).sort((a, b) => w8(b[0], b[1]) - w8(a[0], a[1]));
  const out = [];
  for (const [w, c] of cand) { if (out.some((o) => o.term.includes(w) || (w.includes(o.term) && c <= o.count))) continue; out.push({ term: w, count: c }); if (out.length >= n) break; }
  return out;
}
const sentences = (t) => String(t).split(/(?<=[。！？!?；;\n])/).map((s) => s.trim()).filter((s) => s.length >= 4);
export function styleFeatures(text) {
  const ss = sentences(text), n = Math.max(1, ss.length);
  const rate = (re) => Math.round((ss.filter((s) => re.test(s)).length / n) * 100);
  return {
    sentences: ss.length, avg_len: Math.round(ss.reduce((a, s) => a + s.length, 0) / n),
    question_pct: rate(/[？?]|为什么|怎么|如何|是否/), example_pct: rate(/例如|比如|举个例子|案例|譬如/), summary_pct: rate(/总之|小结|总结|综上|归纳/),
    guide_pct: rate(/请(大家|同学)|想一想|讨论|思考|试着/), ideology_pct: rate(new RegExp(BASE_IDEOLOGY_TERMS.join('|'))),
    ideology_terms: BASE_IDEOLOGY_TERMS.filter((w) => text.includes(w)).slice(0, 8),
  };
}
function styleSummary(f, terms) {
  const lead = [];
  if (f.question_pct >= 15) lead.push(`常用提问推进（约 ${f.question_pct}% 的句子是问句）`);
  if (f.example_pct >= 8) lead.push(`喜欢举例说明（${f.example_pct}%）`);
  if (f.guide_pct >= 8) lead.push(`注重引导学生思考与讨论（${f.guide_pct}%）`);
  if (f.summary_pct >= 5) lead.push(`习惯及时小结（${f.summary_pct}%）`);
  lead.push(f.avg_len >= 40 ? '句子偏长、论证完整' : f.avg_len <= 22 ? '句子简短、口语化' : '句长适中');
  return `表达特点：${lead.join('；')}。高频主题：${terms.slice(0, 6).map((t) => t.term).join('、') || '—'}。${f.ideology_terms.length ? `思政关注：${f.ideology_terms.join('、')}。` : ''}`;
}
function chunkText(text, size = 320) {
  const paras = text.split(/\n{1,}/).map((p) => p.trim()).filter(Boolean), out = [];
  let buf = '';
  for (const p of paras) { if ((buf + p).length > size && buf) { out.push(buf); buf = ''; } buf += (buf ? '\n' : '') + p; while (buf.length > size * 1.6) { out.push(buf.slice(0, size)); buf = buf.slice(size); } }
  if (buf.trim()) out.push(buf);
  return out.filter((c) => c.length >= 12);
}
/** 按查询词在该教师资料中检索最相关的片段（词面重合打分）。 */
export function retrieve(db, owner_id, agent_key, query, k = 2) {
  const q = [...new Set(cjkRuns(query).flatMap((r) => { const o = []; for (let L = 2; L <= 4; L++) for (let i = 0; i + L <= r.length; i++) o.push(r.slice(i, i + L)); return o; }))].filter((w) => !STOP.has(w));
  if (!q.length) return [];
  const rows = all(db, 'SELECT c.text, c.idx, d.filename FROM agent_chunks c JOIN agent_docs d ON d.doc_id=c.doc_id WHERE c.owner_id=? AND c.agent_key=?', owner_id, agent_key);
  const need = Math.min(9, Math.max(...q.map((w) => w.length * w.length))); // 短查询（如两字术语）整词命中即可
  return rows.map((r) => ({ ...r, score: q.reduce((a, w) => a + (r.text.includes(w) ? w.length * w.length : 0), 0) })).filter((r) => r.score >= need).sort((a, b) => b.score - a.score).slice(0, k);
}
export const hasCorpus = (db, owner_id, agent_key) => !!one(db, 'SELECT 1 FROM agent_chunks WHERE owner_id=? AND agent_key=? LIMIT 1', owner_id, agent_key);

// ---------- 教师资料训练（服务端逐阶段执行，界面轮询可视化） ----------
export const TRAIN_STAGES = [
  ['collect', '采集校验'], ['extract', '文本抽取'], ['privacy', '隐私脱敏'], ['clean', '质量清洗'],
  ['chunk', '切分入库'], ['features', '特征提取'], ['profile', '人设画像'], ['verify', '检索验证'],
];
const STAGE_MIN_MS = 600; // 便于观察：每个阶段至少展示 0.6 秒（界面有说明）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startTraining(db, user, key, input) {
  const roles = rolesFor(db, user);
  check(roles[key] && (roles[key].fixed || roles[key].custom), 404, 'not_found', '没有这个教师智能体');
  check(input.consent === true, 400, 'consent_required', '请先阅读并确认数据采集原则');
  const files = Array.isArray(input.files) ? input.files : [];
  check(files.length >= 1 && files.length <= 20, 400, 'bad_files', '一次导入 1—20 份资料');
  check(!one(db, "SELECT 1 FROM agent_trainings WHERE owner_id=? AND agent_key=? AND status='running'", user.user_id, key), 409, 'training_running', '该智能体正在训练，请稍候');
  const train_id = id('train');
  const stages = TRAIN_STAGES.map(([k, label]) => ({ key: k, label, status: 'pending', ms: null, detail: '' }));
  run(db, 'INSERT INTO agent_trainings(train_id,owner_id,agent_key,status,stages,stats,created_at) VALUES(?,?,?,?,?,?,?)', train_id, user.user_id, key, 'running', JSON.stringify(stages), '{}', now());
  audit(db, { actor: user, action: 'agent_training_started', target_type: 'agent', target_id: key, detail: { files: files.length } });
  runTraining(db, user, key, train_id, files).catch((e) => {
    try {
      const t = one(db, 'SELECT stages FROM agent_trainings WHERE train_id=?', train_id); const st = json(t?.stages, []);
      const cur = st.find((s) => s.status === 'running'); if (cur) { cur.status = 'error'; cur.detail = e.message; }
      run(db, "UPDATE agent_trainings SET status='failed', stages=?, finished_at=? WHERE train_id=?", JSON.stringify(st), now(), train_id);
    } catch { /* database closed during shutdown */ }
  });
  return trainingView(db, user, train_id);
}
async function runTraining(db, user, key, train_id, files) {
  const stages = TRAIN_STAGES.map(([k, label]) => ({ key: k, label, status: 'pending', ms: null, detail: '' }));
  const stats = {};
  const save = () => { if (db._closing) throw new Error('服务关闭'); run(db, 'UPDATE agent_trainings SET stages=?, stats=? WHERE train_id=?', JSON.stringify(stages), JSON.stringify(stats), train_id); };
  const stage = async (k, fn) => {
    const s = stages.find((x) => x.key === k); s.status = 'running'; save();
    const t0 = Date.now(); s.detail = (await fn()) || ''; const took = Date.now() - t0;
    if (took < STAGE_MIN_MS) await sleep(STAGE_MIN_MS - took);
    s.ms = took; s.status = 'done'; save();
  };
  let docs = [];
  await stage('collect', () => {
    const bad = files.filter((f) => !/\.(docx|pptx|xlsx|txt|md|csv)$/i.test(f.filename || ''));
    if (bad.length) throw new Error(`不支持的文件：${bad.map((f) => f.filename).join('、')}`);
    stats.files = files.length; stats.bytes = files.reduce((a, f) => a + Math.floor(String(f.data_base64 || '').length * 0.75), 0);
    return `${files.length} 份资料，共 ${(stats.bytes / 1024).toFixed(0)} KB；已确认采集原则`;
  });
  await stage('extract', () => {
    docs = files.map((f) => { const buf = Buffer.from(String(f.data_base64 || ''), 'base64'); const x = extractText(f.filename, buf); return { filename: String(f.filename).slice(0, 120), kind: f.kind || '教学资料', text: x.text, sha: createHash('sha256').update(buf).digest('hex') }; });
    stats.chars = docs.reduce((a, d) => a + d.text.length, 0); stats.per_file = docs.map((d) => ({ filename: d.filename, chars: d.text.length }));
    return `抽取文字 ${stats.chars} 字`;
  });
  await stage('privacy', () => {
    let total = 0; const kinds = {};
    for (const d of docs) { const f = piiScan(d.text); d.pii = f; for (const [k, v] of Object.entries(f)) { kinds[k] = (kinds[k] || 0) + v; total += v; } d.text = redact(d.text); }
    stats.pii = kinds; stats.pii_total = total;
    return total ? `检测并隐去 ${total} 处个人信息（${Object.entries(kinds).map(([k, v]) => `${k}${v}`).join('、')}）` : '未检测到个人信息';
  });
  await stage('clean', () => {
    const seen = new Set(all(db, 'SELECT sha256 FROM agent_docs WHERE owner_id=? AND agent_key=?', user.user_id, key).map((d) => d.sha256));
    const dup = docs.filter((d) => seen.has(d.sha)); docs = docs.filter((d) => !seen.has(d.sha));
    let removed = 0;
    for (const d of docs) { const lines = d.text.split('\n'); const keep = []; const s = new Set(); for (const l of lines) { const t = l.trim(); if (t.length < 2 || s.has(t)) { removed++; continue; } s.add(t); keep.push(t); } d.text = keep.join('\n'); }
    stats.dup_files = dup.length; stats.removed_lines = removed; stats.clean_chars = docs.reduce((a, d) => a + d.text.length, 0);
    if (!docs.length) throw new Error('这些资料此前已导入过，没有新增内容');
    return `去除重复文件 ${dup.length} 份、空行与重复行 ${removed} 行，保留 ${stats.clean_chars} 字`;
  });
  await stage('chunk', () => {
    let n = 0;
    tx(db, () => { for (const d of docs) {
      const doc_id = id('adoc');
      run(db, 'INSERT INTO agent_docs(doc_id,owner_id,agent_key,filename,kind,sha256,n_chars,pii_flags,train_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', doc_id, user.user_id, key, d.filename, d.kind, d.sha, d.text.length, JSON.stringify(d.pii || {}), train_id, now());
      chunkText(d.text).forEach((c, i) => { run(db, 'INSERT INTO agent_chunks(chunk_id,doc_id,owner_id,agent_key,idx,text) VALUES(?,?,?,?,?,?)', id('ach'), doc_id, user.user_id, key, i, c); n++; });
    } });
    stats.chunks = n; stats.total_chunks = one(db, 'SELECT COUNT(*) n FROM agent_chunks WHERE owner_id=? AND agent_key=?', user.user_id, key).n;
    return `新增 ${n} 个知识片段（该智能体累计 ${stats.total_chunks} 个）`;
  });
  let corpus = '';
  await stage('features', () => {
    corpus = all(db, 'SELECT text FROM agent_chunks WHERE owner_id=? AND agent_key=? ORDER BY rowid', user.user_id, key).map((c) => c.text).join('\n');
    stats.terms = keyTerms(corpus, 12); stats.style = styleFeatures(corpus);
    return `高频主题 ${stats.terms.length} 个；${stats.style.sentences} 句，平均句长 ${stats.style.avg_len} 字`;
  });
  let profile;
  await stage('profile', () => { profile = { summary: styleSummary(stats.style, stats.terms), terms: stats.terms.slice(0, 8).map((t) => t.term), style: stats.style, docs: one(db, 'SELECT COUNT(*) n FROM agent_docs WHERE owner_id=? AND agent_key=?', user.user_id, key).n }; return profile.summary; });
  await stage('verify', () => {
    const qs = stats.terms.slice(0, 5).map((t) => t.term);
    const res = qs.map((q) => ({ q, hits: retrieve(db, user.user_id, key, q, 1) }));
    const ok = res.filter((r) => r.hits.length).length;
    stats.verify = res.map((r) => ({ query: r.q, hit: r.hits[0] ? `《${r.hits[0].filename}》${r.hits[0].text.slice(0, 60)}` : null }));
    stats.coverage = qs.length ? Math.round((ok / qs.length) * 100) : 0;
    return `用 ${qs.length} 个高频主题检索，命中 ${ok} 个（${stats.coverage}%）`;
  });
  run(db, "UPDATE agent_trainings SET status='done', stages=?, stats=?, profile=?, finished_at=? WHERE train_id=?", JSON.stringify(stages), JSON.stringify(stats), JSON.stringify(profile), now(), train_id);
}
export function trainingView(db, user, train_id) {
  const t = one(db, 'SELECT * FROM agent_trainings WHERE train_id=? AND owner_id=?', train_id, user.user_id);
  check(t, 404, 'not_found', '训练记录不存在');
  return { train_id: t.train_id, agent_key: t.agent_key, status: t.status, stages: json(t.stages, []), stats: json(t.stats, {}), profile: json(t.profile), created_at: t.created_at, finished_at: t.finished_at, min_stage_ms: STAGE_MIN_MS };
}
export function agentDetail(db, user, key) {
  const r = rolesFor(db, user)[key]; check(r, 404, 'not_found', '没有这个教师智能体');
  return { agent: r, docs: all(db, 'SELECT doc_id, filename, kind, n_chars, pii_flags, created_at FROM agent_docs WHERE owner_id=? AND agent_key=? ORDER BY created_at DESC', user.user_id, key).map((d) => ({ ...d, pii_flags: json(d.pii_flags, {}) })),
    trainings: all(db, 'SELECT train_id, status, created_at, finished_at FROM agent_trainings WHERE owner_id=? AND agent_key=? ORDER BY created_at DESC LIMIT 10', user.user_id, key),
    latest: (() => { const t = one(db, 'SELECT train_id FROM agent_trainings WHERE owner_id=? AND agent_key=? ORDER BY created_at DESC LIMIT 1', user.user_id, key); return t ? trainingView(db, user, t.train_id) : null; })() };
}
export function deleteDoc(db, user, key, doc_id) {
  const d = one(db, 'SELECT * FROM agent_docs WHERE doc_id=? AND owner_id=? AND agent_key=?', doc_id, user.user_id, key); check(d, 404, 'not_found', '资料不存在');
  tx(db, () => { run(db, 'DELETE FROM agent_chunks WHERE doc_id=?', doc_id); run(db, 'DELETE FROM agent_docs WHERE doc_id=?', doc_id); });
  if (!hasCorpus(db, user.user_id, key)) run(db, "UPDATE agent_trainings SET status='withdrawn' WHERE owner_id=? AND agent_key=? AND status='done'", user.user_id, key);
  audit(db, { actor: user, action: 'agent_doc_deleted', target_type: 'agent', target_id: key, detail: { doc_id } });
}

// ---------- 学生群体画像导入：自动分配到单个学生智能体 ----------
const FIELD = {
  code: /^(编号|代号|序号|学生代号|匿名代号|id|no)$/i, name: /姓名|名字|学生姓名/, sid: /学号/, gender: /性别/,
  prior: /前测|先修|基础|成绩|得分|分数|水平/, interest: /兴趣|偏好|方向/, express: /表达|发言|活跃|参与/,
  skeptic: /质疑|批判|追问|提问倾向/, coop: /合作|协作|团队/, note: /误解|易错|困难|备注|说明|特点/,
};
const LEVEL = { 优: 0.9, 良: 0.72, 中: 0.55, 及格: 0.45, 差: 0.3, 高: 0.8, 较高: 0.68, 一般: 0.5, 较低: 0.32, 低: 0.2, A: 0.9, B: 0.72, C: 0.55, D: 0.4, E: 0.25 };
function level(v, scale100 = false) {
  const s = String(v ?? '').trim(); if (!s) return null;
  if (LEVEL[s] != null) return LEVEL[s];
  const n = Number(s.replace(/[%分]/g, '')); if (!Number.isFinite(n)) return null;
  if (n <= 1 && !scale100) return Math.max(0, Math.min(1, n)); if (n <= 5 && !scale100) return Math.max(0, Math.min(1, n / 5));
  return Math.max(0, Math.min(1, n / 100));
}
const INTEREST_MAP = [['工程应用', /工程|应用|实践|动手/], ['数据分析', /数据|统计|计算/], ['安全伦理', /安全|伦理|责任/], ['案例讨论', /案例|讨论|故事/], ['理论推导', /理论|推导|原理/], ['职业规范', /职业|规范|岗位|标准/]];
export function parseTable(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sep = (l) => (l.includes('\t') ? '\t' : l.includes(',') ? ',' : /，/.test(l) ? '，' : /\s{2,}/.test(l) ? /\s{2,}/ : ',');
  const rows = lines.map((l) => l.split(sep(l)).map((c) => c.trim().replace(/^"|"$/g, '')));
  return { header: rows[0] || [], body: rows.slice(1).filter((r) => r.some((c) => c)) };
}
export function importClassProfile(db, user, input) {
  check(input.consent === true, 400, 'consent_required', '请先阅读并确认学生数据采集原则');
  const buf = Buffer.from(String(input.data_base64 || ''), 'base64');
  const stages = [];
  const t = (label, detail) => stages.push({ label, detail });
  const { text } = extractText(input.filename || 'profile.csv', buf);
  const { header, body } = parseTable(text);
  check(header.length >= 2 && body.length >= 4, 400, 'bad_table', '未识别到表格：第一行应为表头（如 代号、前测、兴趣、发言活跃度…），至少 4 行学生数据');
  check(body.length <= 300, 400, 'too_many', '一个班级画像最多 300 名学生');
  t('读取表格', `${body.length} 行 × ${header.length} 列`);
  const col = {}; header.forEach((h, i) => { for (const [k, re] of Object.entries(FIELD)) if (col[k] == null && re.test(h)) { col[k] = i; break; } });
  const dropped = ['name', 'sid'].filter((k) => col[k] != null).map((k) => header[col[k]]);
  const pii = piiScan(text);
  t('隐私检查', `${dropped.length ? `已丢弃列：${dropped.join('、')}；` : ''}${Object.keys(pii).length ? `检测到并忽略 ${Object.entries(pii).map(([k, v]) => `${k}${v}`).join('、')}` : '未检测到个人信息'}`);
  const used = ['prior', 'interest', 'express', 'skeptic', 'coop', 'note', 'gender'].filter((k) => col[k] != null);
  check(used.some((k) => ['prior', 'express', 'skeptic', 'coop'].includes(k)), 400, 'no_fields', '至少需要一个可用字段：前测/先修水平、发言活跃度、质疑倾向或合作倾向');
  t('字段识别', used.map((k) => `${{ prior: '先修水平', interest: '兴趣', express: '表达活跃度', skeptic: '质疑倾向', coop: '合作倾向', note: '常见误解/备注', gender: '性别' }[k]}←“${header[col[k]]}”`).join('；'));
  let missing = 0;
  const rows = body.map((r, i) => {
    const g = (k) => (col[k] != null ? r[col[k]] : '');
    const prior = level(g('prior'), true), express = level(g('express')), skeptic = level(g('skeptic')), coop = level(g('coop'));
    [prior, express, skeptic, coop].forEach((v, j) => { if (v == null && col[['prior', 'express', 'skeptic', 'coop'][j]] != null) missing++; });
    const it = String(g('interest') || ''); const interests = INTEREST_MAP.filter(([, re]) => re.test(it)).map(([k]) => k).slice(0, 2);
    return { code: String(g('code') || `R${String(i + 1).padStart(2, '0')}`).slice(0, 12), prior, express, skeptic, coop, interests, note: redact(String(g('note') || '')).slice(0, 80), gender: /女/.test(g('gender')) ? 'f' : /男/.test(g('gender')) ? 'm' : null };
  });
  const mean = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0.5; };
  const fill = { prior: mean('prior'), express: mean('express'), skeptic: mean('skeptic'), coop: mean('coop') };
  for (const r of rows) for (const k of Object.keys(fill)) if (r[k] == null) r[k] = Math.round(fill[k] * 1000) / 1000;
  t('标准化与补全', `数值统一到 0—1；${missing} 个缺失值用班级均值补全`);
  const gs = Math.max(2, Math.min(12, Number(input.group_size) || 5));
  const nGroups = Math.ceil(rows.length / gs);
  // 按先修水平排序后蛇形分配 → 每组高低搭配（异质分组）
  const order = rows.map((r, i) => i).sort((a, b) => rows[b].prior - rows[a].prior);
  const groups = Array.from({ length: nGroups }, () => []);
  order.forEach((ri, k) => { const round = Math.floor(k / nGroups), pos = k % nGroups; let g = round % 2 ? nGroups - 1 - pos : pos; while (groups[g].length >= gs) g = (g + 1) % nGroups; groups[g].push(ri); });
  const assigned = groups.flatMap((g) => g.map((ri) => rows[ri]));
  const gMeans = groups.map((g) => Math.round((g.reduce((a, ri) => a + rows[ri].prior, 0) / Math.max(1, g.length)) * 100));
  t('异质分组', `${nGroups} 组 × 每组最多 ${gs} 人；各组平均先修水平 ${Math.min(...gMeans)}—${Math.max(...gMeans)}`);
  t('生成学生智能体', `${assigned.length} 名学生智能体，按顺序对应 ${assigned.length} 条画像（代号保留、姓名不进入平台）`);
  const stats = { n: assigned.length, groups: nGroups, group_size: gs, group_means: gMeans, fields: used, dropped, dist: { prior: hist(rows.map((r) => r.prior)), express: hist(rows.map((r) => r.express)) } };
  const profile_id = id('cprof');
  run(db, 'INSERT INTO class_profiles(profile_id,owner_id,name,n,group_size,rows,stats,stages,created_at) VALUES(?,?,?,?,?,?,?,?,?)', profile_id, user.user_id, String(input.name || input.filename || '班级画像').slice(0, 40), assigned.length, gs, JSON.stringify(assigned), JSON.stringify(stats), JSON.stringify(stages), now());
  audit(db, { actor: user, action: 'class_profile_imported', target_type: 'class_profile', target_id: profile_id, detail: { n: assigned.length, fields: used, dropped } });
  return classProfileView(db, user, profile_id);
}
function hist(vals) { const b = [0, 0, 0, 0, 0]; for (const v of vals) b[Math.min(4, Math.floor((v ?? 0) * 5))]++; return b; }
export function classProfileView(db, user, pid) {
  const p = one(db, 'SELECT * FROM class_profiles WHERE profile_id=? AND owner_id=?', pid, user.user_id); check(p, 404, 'not_found', '班级画像不存在');
  return { profile_id: p.profile_id, name: p.name, n: p.n, group_size: p.group_size, rows: json(p.rows, []), stats: json(p.stats, {}), stages: json(p.stages, []), created_at: p.created_at };
}
export const listClassProfiles = (db, user) => all(db, 'SELECT profile_id, name, n, group_size, stats, created_at FROM class_profiles WHERE owner_id=? ORDER BY created_at DESC', user.user_id).map((p) => ({ ...p, stats: json(p.stats, {}) }));
export function deleteClassProfile(db, user, pid) { const r = run(db, 'DELETE FROM class_profiles WHERE profile_id=? AND owner_id=?', pid, user.user_id); check(r.changes, 404, 'not_found', '班级画像不存在'); }
/** 画像 → 学情摘要（供研课场“学情分析”使用）。只做计数与归纳，不推断个体。 */
export function learnerSummary(db, user, pid) {
  const p = classProfileView(db, user, pid);
  const band = (vals) => { const v = vals.filter((x) => x != null); return { low: v.filter((x) => x < 0.4).length, mid: v.filter((x) => x >= 0.4 && x < 0.7).length, high: v.filter((x) => x >= 0.7).length, missing: vals.length - v.length }; };
  const prior = band(p.rows.map((r) => r.prior)), express = band(p.rows.map((r) => r.express)), skeptic = band(p.rows.map((r) => r.skeptic));
  const count = (arr) => Object.entries(arr.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const interests = count(p.rows.flatMap((r) => r.interests || [])).slice(0, 4);
  const misconceptions = count(p.rows.map((r) => String(r.note || '').trim()).filter(Boolean)).slice(0, 5);
  const text = `依据班级画像「${p.name}」（${p.n} 人，匿名导入）：先修水平 高 ${prior.high} / 中 ${prior.mid} / 低 ${prior.low}${prior.missing ? ` / 缺失 ${prior.missing}` : ''} 人；课堂表达 活跃 ${express.high} / 一般 ${express.mid} / 较少 ${express.low} 人；质疑倾向较强 ${skeptic.high} 人。`
    + `${interests.length ? `兴趣集中在${interests.map(([k, n]) => `${k}（${n}人）`).join('、')}。` : ''}${misconceptions.length ? `教师记录的常见误解：${misconceptions.map(([k, n]) => `“${k}”（${n}人）`).join('；')}。` : '画像中没有记录常见误解。'}`;
  return { profile_id: p.profile_id, name: p.name, n: p.n, prior, express, skeptic, interests, misconceptions, text };
}
/** 画像 → 学生智能体参数覆盖（按座位顺序）。 */
export function profileOverrides(db, user, pid) {
  const p = classProfileView(db, user, pid);
  return { n: p.n, group_size: p.group_size, rows: p.rows.map((r) => ({ code: r.code, traits: { prior_knowledge: r.prior, expressiveness: r.express, skepticism: r.skeptic, cooperation: r.coop, ...(r.interests.length === 2 ? { interests: r.interests } : {}), ...(r.note ? { note: r.note } : {}) }, gender: r.gender })) };
}

// 学生形象（按座位号）
export function setStudentAvatar(db, user, seat, avatar) {
  check(Number.isInteger(seat) && seat >= 0 && seat < 300, 400, 'bad_seat', '无效座位');
  if (!avatar) { run(db, 'DELETE FROM student_avatars WHERE owner_id=? AND seat=?', user.user_id, seat); return; }
  check(IMG.test(avatar) && avatar.length <= 200000, 400, 'bad_avatar', '形象图片需为 PNG/JPEG/WebP，压缩后不超过约 150KB');
  run(db, 'INSERT INTO student_avatars(owner_id,seat,avatar,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,seat) DO UPDATE SET avatar=excluded.avatar, updated_at=excluded.updated_at', user.user_id, seat, avatar, now());
}
export const studentAvatars = (db, user) => Object.fromEntries(all(db, 'SELECT seat, avatar FROM student_avatars WHERE owner_id=?', user.user_id).map((r) => [r.seat, r.avatar]));
export { fail };
