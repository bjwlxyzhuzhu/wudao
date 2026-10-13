// 科研数据中心：研究项目、被试与知情同意、量表/测试（题项、作答、计分）、话语单元与编码、评分一致性，
// 以及所有表格数据的“智能导入/导出”注册表（CSV/XLSX/JSON/SPSS）。只处理研究者实际采集或导入的数据；不生成任何示例数据。
import { createHash } from 'node:crypto';
import { one, all, run, id, now, tx, check, fail, audit, json } from './db.js';
import { readTable, suggestMapping, applyMapping, toCsv, toXlsx, spssSyntax, templateXlsx, spssName, TYPE_LABEL } from './tabular.js';
import { describe, cronbach, itemAnalysis, cohenKappa, krippendorff, icc, lagSequential, INTERPRET, THRESHOLD_SOURCES } from './stats.js';
import { piiScan, redact } from './materials.js';
import { zip, unzip as unzipSync } from './zip.js';
import * as research from './research.js';
import { getOwned, rowToArtifact } from './artifacts.js';

export function ensureTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS study_projects(project_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, code TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planning', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS study_participants(participant_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, code TEXT NOT NULL, role TEXT, condition TEXT, cohort TEXT, grp TEXT, gender TEXT, age INTEGER, grade TEXT, major TEXT, prior_score REAL,
      consent TEXT NOT NULL DEFAULT 'pending', consent_date TEXT, withdrawn_at TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, code));
    CREATE TABLE IF NOT EXISTS study_instruments(instrument_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, kind TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, code));
    CREATE TABLE IF NOT EXISTS study_items(item_id TEXT PRIMARY KEY, instrument_id TEXT NOT NULL, owner_id TEXT NOT NULL, code TEXT NOT NULL, seq INTEGER, dimension TEXT, text TEXT, reverse INTEGER DEFAULT 0, qtype TEXT, options TEXT, answer TEXT, points REAL,
      knowledge_point TEXT, cognitive_level TEXT, goal_ref TEXT, placeholder INTEGER DEFAULT 0, UNIQUE(instrument_id, code));
    CREATE TABLE IF NOT EXISTS study_responses(response_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, instrument_id TEXT NOT NULL, participant_code TEXT NOT NULL, timepoint TEXT NOT NULL, item_code TEXT NOT NULL,
      value TEXT, score REAL, collected_at TEXT, batch_id TEXT, created_at TEXT NOT NULL, UNIQUE(instrument_id, participant_code, timepoint, item_code));
    CREATE TABLE IF NOT EXISTS study_codebooks(codebook_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'exclusive', framework TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS study_codes(codebook_id TEXT NOT NULL, owner_id TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL, category TEXT, definition TEXT, include_rule TEXT, exclude_rule TEXT, example TEXT, seq INTEGER, PRIMARY KEY(codebook_id, code));
    CREATE TABLE IF NOT EXISTS study_units(unit_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, source TEXT NOT NULL, session TEXT, seq INTEGER, speaker TEXT, speaker_role TEXT, grp TEXT, time TEXT, text TEXT,
      event_id TEXT, run_id TEXT, stage TEXT, participant_code TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS study_codings(coding_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_id TEXT NOT NULL, codebook_id TEXT NOT NULL, unit_id TEXT NOT NULL, coder TEXT NOT NULL, code TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, UNIQUE(codebook_id, unit_id, coder, code));
    CREATE INDEX IF NOT EXISTS ix_resp_inst ON study_responses(instrument_id);
    CREATE INDEX IF NOT EXISTS ix_units_proj ON study_units(project_id, session, seq);
    CREATE INDEX IF NOT EXISTS ix_codings_cb ON study_codings(codebook_id, unit_id);`);
}

// ---------- vocabularies ----------
export const DESIGNS = { quasi_prepost: '准实验：前后测 + 对照组', rct: '随机对照实验', one_group: '单组前后测', dbr: '设计型研究（DBR，多轮迭代）', action: '行动研究', mixed: '混合方法（量化 + 质性）', case: '案例研究', survey: '问卷调查研究', content: '内容分析 / 话语分析' };
export const FIELDS_OF_STUDY = ['教育学', '教育技术学', '思想政治教育', '课程与教学论', '高等教育学', '其他'];
const CONSENT = { pending: ['待确认', '未确认', '未知'], consented: ['已同意', '同意', '是', 'yes', 'y', '1', 'true'], declined: ['拒绝', '不同意', '否', 'no', 'n', '0', 'false'], withdrawn: ['已退出', '退出', '撤回', '撤销', 'withdrawn'] };
export const CONSENT_NAME = { pending: '待确认', consented: '已同意', declined: '拒绝', withdrawn: '已退出' };
const SOURCE_STATUS = { validated: '已验证量表（原版）', adapted: '改编 / 翻译（需报告修订与信效度）', self_developed: '自编（需预测试、EFA/CFA）', placeholder: '结构模板（题项待替换，不可施测）' };
const QTYPE = { single: ['单选', '单选题', '选择题', 'sc'], multi: ['多选', '多选题', 'mc'], truefalse: ['判断', '判断题', '是非', 'tf'], blank: ['填空', '填空题'], open: ['简答', '简答题', '计算', '计算题', '论述', '主观题', '综合'] };
const QTYPE_NAME = { single: '单选', multi: '多选', truefalse: '判断', blank: '填空', open: '主观题（人工给分）' };
const BLOOM = { remember: ['记忆', '识记'], understand: ['理解'], apply: ['应用'], analyze: ['分析'], evaluate: ['评价'], create: ['创造', '创新'] };

/**
 * Structure-only scale skeletons. Items are PLACEHOLDERS: the researcher must paste the original validated items and
 * document source/licence. Nothing here is presented as a validated instrument.
 */
export const SCALE_SKELETONS = {
  tpack: { name: 'TPACK 整合技术的学科教学知识（结构模板）', citation: 'Schmidt, D. A., et al. (2009). Survey of preservice teachers\' knowledge of teaching and technology. Journal of Research on Technology in Education, 42(2), 123–149.', scale: [1, 5],
    dims: [['TK', '技术知识', 6], ['CK', '学科内容知识', 3], ['PK', '教学法知识', 7], ['PCK', '学科教学知识', 1], ['TCK', '整合技术的学科知识', 1], ['TPK', '整合技术的教学法知识', 5], ['TPACK', '整合技术的学科教学知识', 4]] },
  tam: { name: '技术接受模型 TAM（结构模板）', citation: 'Davis, F. D. (1989). Perceived usefulness, perceived ease of use, and user acceptance of information technology. MIS Quarterly, 13(3), 319–340.', scale: [1, 7],
    dims: [['PU', '感知有用性', 6], ['PEOU', '感知易用性', 6], ['BI', '使用意向（常见于后续扩展模型，请核对所用版本）', 3]] },
  tlx: { name: 'NASA-TLX 工作负荷（结构模板）', citation: 'Hart, S. G., & Staveland, L. E. (1988). Development of NASA-TLX (Task Load Index). Advances in Psychology, 52, 139–183.', scale: [0, 100],
    dims: [['MD', '脑力需求', 1], ['PD', '体力需求', 1], ['TD', '时间需求', 1], ['PF', '绩效（注意方向）', 1], ['EF', '努力程度', 1], ['FR', '挫败感', 1]] },
  sus: { name: '系统可用性量表 SUS（结构模板）', citation: 'Brooke, J. (1996). SUS: A "quick and dirty" usability scale. In Usability Evaluation in Industry (pp. 189–194). Taylor & Francis.', scale: [1, 5], reverseEven: true,
    dims: [['SUS', '可用性（原量表单维；偶数题为反向题，总分换算见原文）', 10]] },
  ideology_teacher: { name: '教师课程思政教学能力（自编结构建议）', citation: '无公认成熟量表；以下维度仅为自编起点，须经专家评议、预测试与 EFA/CFA 后使用。', scale: [1, 5], selfDeveloped: true,
    dims: [['DIG', '思政元素挖掘', 4], ['DES', '融入教学设计', 4], ['IMP', '课堂实施', 4], ['EVA', '育人效果评价', 4], ['REF', '反思改进', 3]] },
  ideology_student: { name: '学生课程思政学习体验与价值认同（自编结构建议）', citation: '无公认成熟量表；自编须报告编制过程、内容效度与结构效度。', scale: [1, 5], selfDeveloped: true,
    dims: [['REL', '专业—价值关联感知', 4], ['ENG', '学习投入', 4], ['IDN', '价值认同', 4], ['ACT', '行为意向', 3]] },
};

// ---------- ownership helpers ----------
const own = (db, user, table, pk, value, label) => { const r = one(db, `SELECT * FROM ${table} WHERE ${pk}=? AND owner_id=?`, value, user.user_id); check(r, 404, 'not_found', `${label}不存在或无权访问`); return r; };
export const getProject = (db, user, pid) => { const p = own(db, user, 'study_projects', 'project_id', pid, '研究项目'); return { ...p, body: json(p.body, {}) }; };
const getInstrument = (db, user, iid) => { const i = own(db, user, 'study_instruments', 'instrument_id', iid, '量表/测试'); return { ...i, body: json(i.body, {}) }; };
const getCodebook = (db, user, cid) => own(db, user, 'study_codebooks', 'codebook_id', cid, '编码表');
const items = (db, iid) => all(db, 'SELECT * FROM study_items WHERE instrument_id=? ORDER BY seq, code', iid);
const codes = (db, cid) => all(db, 'SELECT * FROM study_codes WHERE codebook_id=? ORDER BY seq, code', cid);
const participants = (db, pid) => all(db, 'SELECT * FROM study_participants WHERE project_id=? ORDER BY code', pid);
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);
const CODE_RE = /^[\w一-龥.\-]{1,40}$/;

// ---------- projects ----------
function cleanProjectBody(b = {}) {
  const list = (a, n, map) => (Array.isArray(a) ? a : []).slice(0, n).map(map).filter(Boolean);
  const conds = list(b.conditions, 12, (c) => (c && str(c.code, 20) ? { code: str(c.code, 20), label: str(c.label || c.code, 40), description: str(c.description, 300) } : null));
  const tps = list(b.timepoints, 12, (t) => (t && str(t.code, 20) ? { code: str(t.code, 20), label: str(t.label || t.code, 40), date: str(t.date, 10) } : null));
  for (const x of [...conds, ...tps]) check(CODE_RE.test(x.code), 400, 'bad_code', `编码“${x.code}”只能含字母、数字、汉字、下划线`);
  check(new Set(conds.map((c) => c.code)).size === conds.length && new Set(tps.map((t) => t.code)).size === tps.length, 400, 'dup_code', '组别或时间点编码重复');
  return { field: FIELDS_OF_STUDY.includes(b.field) ? b.field : '教育学', rqs: list(b.rqs, 10, (q) => str(q, 400) || null), hypotheses: list(b.hypotheses, 10, (q) => str(q, 400) || null),
    design: Object.hasOwn(DESIGNS, b.design) ? b.design : 'quasi_prepost', design_note: str(b.design_note, 1000), unit_of_analysis: str(b.unit_of_analysis, 100), sampling: str(b.sampling, 1000),
    conditions: conds, timepoints: tps, ethics: { body: str(b.ethics?.body, 100), number: str(b.ethics?.number, 60), date: str(b.ethics?.date, 10), consent_version: str(b.ethics?.consent_version, 40), exempt_reason: str(b.ethics?.exempt_reason, 300) },
    prereg: str(b.prereg, 300), data_availability: str(b.data_availability, 1000), ai_disclosure: str(b.ai_disclosure, 1000),
    run_ids: list(b.run_ids, 500, (r) => (typeof r === 'string' && /^run_\w+$/.test(r) ? r : null)) };
}
export function saveProject(db, user, pid, input) {
  const title = str(input.title, 120), code = str(input.code || '', 20) || `P${Date.now().toString(36).slice(-5).toUpperCase()}`;
  check(title, 400, 'bad_title', '请填写研究题目'); check(CODE_RE.test(code), 400, 'bad_code', '项目编码只能含字母、数字、下划线');
  const body = cleanProjectBody(input.body || input);
  const status = ['planning', 'collecting', 'analysing', 'closed'].includes(input.status) ? input.status : 'planning';
  if (body.run_ids.length) { const mine = new Set(all(db, 'SELECT run_id FROM runs WHERE owner_id=?', user.user_id).map((r) => r.run_id)); body.run_ids = body.run_ids.filter((r) => mine.has(r)); }
  if (pid) {
    const p = getProject(db, user, pid);
    for (const t of p.body.timepoints || []) if (!body.timepoints.some((x) => x.code === t.code) && one(db, 'SELECT 1 FROM study_responses WHERE project_id=? AND timepoint=? LIMIT 1', pid, t.code)) fail(409, 'in_use', `时间点 ${t.code} 已有作答数据，不能删除`);
    run(db, 'UPDATE study_projects SET title=?, code=?, body=?, status=?, updated_at=? WHERE project_id=?', title, code, JSON.stringify(body), status, now(), pid);
    audit(db, { actor: user, action: 'study_project_updated', target_type: 'study_project', target_id: pid });
    return projectView(db, user, pid);
  }
  check(one(db, 'SELECT COUNT(*) n FROM study_projects WHERE owner_id=?', user.user_id).n < 50, 400, 'too_many', '最多 50 个研究项目');
  const project_id = id('proj');
  run(db, 'INSERT INTO study_projects(project_id,owner_id,code,title,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', project_id, user.user_id, code, title, JSON.stringify(body), status, now(), now());
  audit(db, { actor: user, action: 'study_project_created', target_type: 'study_project', target_id: project_id });
  return projectView(db, user, project_id);
}
export function deleteProject(db, user, pid) {
  getProject(db, user, pid);
  tx(db, () => {
    for (const t of ['study_responses', 'study_units', 'study_codings', 'study_participants']) run(db, `DELETE FROM ${t} WHERE project_id=?`, pid);
    for (const i of all(db, 'SELECT instrument_id FROM study_instruments WHERE project_id=?', pid)) run(db, 'DELETE FROM study_items WHERE instrument_id=?', i.instrument_id);
    for (const c of all(db, 'SELECT codebook_id FROM study_codebooks WHERE project_id=?', pid)) run(db, 'DELETE FROM study_codes WHERE codebook_id=?', c.codebook_id);
    run(db, 'DELETE FROM study_instruments WHERE project_id=?', pid); run(db, 'DELETE FROM study_codebooks WHERE project_id=?', pid); run(db, 'DELETE FROM study_projects WHERE project_id=?', pid);
    audit(db, { actor: user, action: 'study_project_deleted', target_type: 'study_project', target_id: pid });
  });
}
export const listProjects = (db, user) => all(db, 'SELECT project_id, code, title, status, body, created_at, updated_at FROM study_projects WHERE owner_id=? ORDER BY updated_at DESC', user.user_id)
  .map((p) => { const b = json(p.body, {}); return { ...p, body: undefined, field: b.field, design: DESIGNS[b.design], n_participants: one(db, 'SELECT COUNT(*) n FROM study_participants WHERE project_id=?', p.project_id).n }; });

/** Who may be analysed: consented and not withdrawn. Responses from unregistered codes are never silently included. */
const eligibleCodes = (db, pid) => new Set(all(db, "SELECT code FROM study_participants WHERE project_id=? AND consent='consented'", pid).map((r) => r.code));

export function projectView(db, user, pid) {
  const p = getProject(db, user, pid);
  const parts = participants(db, pid);
  const insts = all(db, 'SELECT * FROM study_instruments WHERE project_id=? ORDER BY kind DESC, created_at', pid).map((i) => ({ ...i, body: json(i.body, {}),
    n_items: one(db, 'SELECT COUNT(*) n FROM study_items WHERE instrument_id=?', i.instrument_id).n, n_placeholders: one(db, 'SELECT COUNT(*) n FROM study_items WHERE instrument_id=? AND placeholder=1', i.instrument_id).n,
    n_responses: one(db, 'SELECT COUNT(DISTINCT participant_code||\'|\'||timepoint) n FROM study_responses WHERE instrument_id=?', i.instrument_id).n }));
  const cbs = all(db, 'SELECT * FROM study_codebooks WHERE project_id=? ORDER BY created_at', pid).map((c) => ({ ...c, n_codes: one(db, 'SELECT COUNT(*) n FROM study_codes WHERE codebook_id=?', c.codebook_id).n,
    coders: all(db, 'SELECT coder, COUNT(DISTINCT unit_id) n FROM study_codings WHERE codebook_id=? GROUP BY coder', c.codebook_id) }));
  const units = one(db, "SELECT COUNT(*) n, SUM(source='platform_event') sim, COUNT(DISTINCT session) sessions FROM study_units WHERE project_id=?", pid);
  const consent = Object.fromEntries(Object.keys(CONSENT).map((k) => [k, parts.filter((x) => x.consent === k).length]));
  const flow = { registered: parts.length, ...consent, by_condition: (p.body.conditions || []).map((c) => ({ code: c.code, label: c.label, n: parts.filter((x) => x.condition === c.code && x.consent === 'consented').length })),
    unassigned: parts.filter((x) => x.consent === 'consented' && !(p.body.conditions || []).some((c) => c.code === x.condition)).length };
  return { project: p, participants: parts, instruments: insts, codebooks: cbs, units: { n: units.n || 0, simulated: units.sim || 0, sessions: units.sessions || 0 }, flow, checklist: checklist(db, p, parts, insts, cbs, units), designs: DESIGNS, source_status: SOURCE_STATUS, consent_names: CONSENT_NAME };
}

/** Frequent reviewer concerns (not any single journal's official requirement list). */
function checklist(db, p, parts, insts, cbs, units) {
  const b = p.body, out = [];
  const add = (key, label, status, detail) => out.push({ key, label, status, detail });
  add('rq', '研究问题与假设', b.rqs?.length ? 'ok' : 'todo', b.rqs?.length ? `${b.rqs.length} 个研究问题${b.hypotheses?.length ? `、${b.hypotheses.length} 个假设` : ''}` : '尚未填写研究问题');
  add('design', '研究设计、组别与时间点', b.conditions?.length && b.timepoints?.length ? 'ok' : 'todo', `${DESIGNS[b.design]}；组别 ${b.conditions?.length || 0} 个；时间点 ${b.timepoints?.length || 0} 个`);
  add('ethics', '伦理审查', b.ethics?.number ? 'ok' : b.ethics?.exempt_reason ? 'warn' : 'todo', b.ethics?.number ? `${b.ethics.body || '伦理委员会'} 批准号 ${b.ethics.number}` : b.ethics?.exempt_reason ? `申请豁免：${b.ethics.exempt_reason}` : '未填写伦理批准号或豁免理由');
  const cons = parts.filter((x) => x.consent === 'consented').length;
  add('consent', '知情同意与退出记录', !parts.length ? 'todo' : parts.some((x) => x.consent === 'pending') ? 'warn' : 'ok', parts.length ? `已同意 ${cons} / 登记 ${parts.length}；待确认 ${parts.filter((x) => x.consent === 'pending').length}；退出 ${parts.filter((x) => x.consent === 'withdrawn').length}（未同意或已退出者不进入分析与导出）` : '尚未登记被试');
  const ph = insts.reduce((a, i) => a + i.n_placeholders, 0), noCite = insts.filter((i) => i.kind === 'scale' && ['validated', 'adapted'].includes(i.body.source_status) && !i.body.citation);
  add('instruments', '测量工具来源与授权', !insts.length ? 'todo' : ph || noCite.length ? 'warn' : 'ok', !insts.length ? '尚未建立量表或测试' : ph ? `仍有 ${ph} 个占位题项未替换为原量表题项` : noCite.length ? `${noCite.map((i) => i.name).join('、')} 缺少来源引用` : `${insts.length} 个工具，来源已标注`);
  const scales = insts.filter((i) => i.kind === 'scale' && i.n_responses);
  add('reliability', '信度（Cronbach α / KR-20）', !scales.length && !insts.some((i) => i.kind === 'test' && i.n_responses) ? 'todo' : 'ok', scales.length || insts.some((i) => i.n_responses) ? '已有作答数据，可在“量表与测试 → 分析”中计算' : '尚无作答数据');
  const coded = cbs.filter((c) => c.coders.length >= 2);
  add('irr', '编码者间一致性', !cbs.length ? 'na' : coded.length ? 'ok' : 'warn', !cbs.length ? '未使用内容编码（如不做话语分析可忽略）' : coded.length ? `${coded.length} 个编码表有 ≥2 位编码者，可计算 κ / α` : '编码表只有 1 位编码者，无法报告一致性');
  add('simulated', '模拟数据与真实数据区分', units.sim ? 'warn' : 'ok', units.sim ? `话语单元中 ${units.sim} 条来自平台模拟（智能体生成），论文中须明确标注，不能作为真实课堂证据` : '未混入模拟话语');
  add('ai', 'AI 使用声明', b.ai_disclosure ? 'ok' : 'todo', b.ai_disclosure ? '已填写' : '许多期刊要求说明生成式 AI 在研究与写作中的用途');
  add('availability', '数据可得性声明', b.data_availability ? 'ok' : 'todo', b.data_availability ? '已填写' : '建议说明数据是否公开、公开范围与申请方式');
  add('prereg', '预注册（可选）', b.prereg ? 'ok' : 'na', b.prereg || '未预注册（非必需；验证性研究建议预注册）');
  return out;
}

// ---------- participants ----------
export function updateParticipant(db, user, participantId, input) {
  const x = own(db, user, 'study_participants', 'participant_id', participantId, '被试');
  const consent = Object.hasOwn(CONSENT, input.consent) ? input.consent : x.consent;
  const withdrawn_at = consent === 'withdrawn' ? (x.withdrawn_at || now()) : null;
  run(db, 'UPDATE study_participants SET condition=?, cohort=?, grp=?, consent=?, consent_date=?, withdrawn_at=?, note=?, updated_at=? WHERE participant_id=?',
    input.condition != null ? str(input.condition, 20) : x.condition, input.cohort != null ? str(input.cohort, 40) : x.cohort, input.grp != null ? str(input.grp, 20) : x.grp, consent,
    input.consent_date != null ? str(input.consent_date, 10) : x.consent_date, withdrawn_at, input.note != null ? redact(str(input.note, 300)) : x.note, now(), participantId);
  if (consent !== x.consent) audit(db, { actor: user, action: 'participant_consent_changed', target_type: 'study_participant', target_id: participantId, detail: { from: x.consent, to: consent } });
  return one(db, 'SELECT * FROM study_participants WHERE participant_id=?', participantId);
}
/** Withdrawal with data removal: deletes the participant's responses, their transcript units and codings on those units. */
export function purgeParticipantData(db, user, participantId) {
  const x = own(db, user, 'study_participants', 'participant_id', participantId, '被试');
  return tx(db, () => {
    const r = run(db, 'DELETE FROM study_responses WHERE project_id=? AND participant_code=?', x.project_id, x.code).changes;
    const uids = all(db, 'SELECT unit_id FROM study_units WHERE project_id=? AND participant_code=?', x.project_id, x.code).map((u) => u.unit_id);
    for (const u of uids) run(db, 'DELETE FROM study_codings WHERE unit_id=?', u);
    const u = run(db, 'DELETE FROM study_units WHERE project_id=? AND participant_code=?', x.project_id, x.code).changes;
    run(db, "UPDATE study_participants SET consent='withdrawn', withdrawn_at=COALESCE(withdrawn_at, ?), note=?, updated_at=? WHERE participant_id=?", now(), '已退出并删除其研究数据', now(), participantId);
    audit(db, { actor: user, action: 'participant_data_purged', target_type: 'study_participant', target_id: participantId, detail: { responses: r, units: u } });
    return { responses_deleted: r, units_deleted: u };
  });
}

// ---------- instruments ----------
export function saveInstrument(db, user, iid, input) {
  const kind = input.kind === 'test' ? 'test' : 'scale';
  const name = str(input.name, 80); check(name, 400, 'bad_name', '请填写名称');
  const code = str(input.code, 20) || `${kind === 'test' ? 'T' : 'S'}${Date.now().toString(36).slice(-4).toUpperCase()}`; check(CODE_RE.test(code), 400, 'bad_code', '编码只能含字母、数字、下划线');
  const scale = Array.isArray(input.scale) ? input.scale.map(Number) : [1, 5];
  if (kind === 'scale') check(scale.length === 2 && scale.every(Number.isInteger) && scale[0] < scale[1] && scale[1] - scale[0] <= 100, 400, 'bad_scale', '量表等级需为整数区间，如 1—5');
  const body = { source_status: Object.hasOwn(SOURCE_STATUS, input.source_status) ? input.source_status : kind === 'test' ? 'self_developed' : 'self_developed', citation: str(input.citation, 500), license_note: str(input.license_note, 300),
    scale: kind === 'scale' ? scale : null, anchors: str(input.anchors, 300), language: str(input.language, 20) || 'zh', adaptation_note: str(input.adaptation_note, 800), artifact_id: input.artifact_id || null };
  if (iid) {
    const i = getInstrument(db, user, iid);
    run(db, 'UPDATE study_instruments SET name=?, code=?, body=?, updated_at=? WHERE instrument_id=?', name, code, JSON.stringify({ ...i.body, ...body }), now(), iid);
    return instrumentView(db, user, iid);
  }
  getProject(db, user, input.project_id);
  check(!one(db, 'SELECT 1 FROM study_instruments WHERE project_id=? AND code=?', input.project_id, code), 409, 'dup_code', `编码 ${code} 已被使用`);
  const instrument_id = id('inst');
  run(db, 'INSERT INTO study_instruments(instrument_id,project_id,owner_id,kind,code,name,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', instrument_id, input.project_id, user.user_id, kind, code, name, JSON.stringify(body), now(), now());
  return instrumentView(db, user, instrument_id);
}
export function instrumentFromSkeleton(db, user, projectId, key) {
  const s = SCALE_SKELETONS[key]; check(s, 400, 'bad_skeleton', '未知模板');
  const v = saveInstrument(db, user, null, { project_id: projectId, kind: 'scale', name: s.name, code: key.toUpperCase().slice(0, 12), scale: s.scale, source_status: s.selfDeveloped ? 'self_developed' : 'placeholder', citation: s.citation });
  let seq = 0;
  tx(db, () => { for (const [dim, label, n] of s.dims) for (let k = 1; k <= n; k++) { seq++; putItem(db, user, v.instrument.instrument_id, { code: `${dim}${k}`, seq, dimension: dim, text: `【占位】请粘贴原量表“${label}”维度第 ${k} 题${s.selfDeveloped ? '（自编题项，需专家评议）' : '并注明来源与授权'}`, reverse: !!(s.reverseEven && seq % 2 === 0), placeholder: true }); } });
  return instrumentView(db, user, v.instrument.instrument_id);
}
/** Build a test from an exam/exercise artifact (questions, answers, points, goals); items stay linked to the artifact. */
export function instrumentFromArtifact(db, user, projectId, artifactId) {
  const a = rowToArtifact(getOwned(db, user, artifactId));
  check(['exam', 'exercises'].includes(a.type), 400, 'bad_type', '只能从“模拟试卷”或“模拟练习”生成测试');
  const qs = a.body.sections.find((s) => s.key === 'questions')?.rows || a.body.sections.find((s) => s.kind === 'table')?.rows || [];
  check(qs.length, 400, 'empty', '该产物没有题目');
  const v = saveInstrument(db, user, null, { project_id: projectId, kind: 'test', name: a.title.slice(0, 60), source_status: 'self_developed', citation: `来自产物库：${a.title} v${a.version}`, artifact_id: a.artifact_id });
  const qt = (t) => { const s = String(t || ''); for (const [k, syn] of Object.entries(QTYPE)) if (syn.some((x) => s.includes(x))) return k; return 'open'; };
  tx(db, () => qs.forEach((q, i) => putItem(db, user, v.instrument.instrument_id, { code: `Q${i + 1}`, seq: i + 1, dimension: q.goal_refs || '', text: String(q.stem || q.question || q.content || '').slice(0, 1000), qtype: qt(q.qtype || q.type), options: q.options || '', answer: q.answer || '', points: Number(q.score) || 1, knowledge_point: q.knowledge || q.kp || '', goal_ref: q.goal_refs || '' })));
  return instrumentView(db, user, v.instrument.instrument_id);
}
function putItem(db, user, iid, r) {
  const ex = one(db, 'SELECT item_id FROM study_items WHERE instrument_id=? AND code=?', iid, r.code);
  const vals = [r.seq ?? null, str(r.dimension, 40) || null, str(r.text, 1000), r.reverse ? 1 : 0, r.qtype || null, str(r.options, 1000) || null, str(r.answer, 200) || null, r.points ?? null, str(r.knowledge_point, 80) || null, r.cognitive_level || null, str(r.goal_ref, 40) || null, r.placeholder ? 1 : 0];
  if (ex) { run(db, 'UPDATE study_items SET seq=?, dimension=?, text=?, reverse=?, qtype=?, options=?, answer=?, points=?, knowledge_point=?, cognitive_level=?, goal_ref=?, placeholder=? WHERE item_id=?', ...vals, ex.item_id); return 'updated'; }
  run(db, 'INSERT INTO study_items(item_id,instrument_id,owner_id,code,seq,dimension,text,reverse,qtype,options,answer,points,knowledge_point,cognitive_level,goal_ref,placeholder) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id('item'), iid, user.user_id, r.code, ...vals);
  return 'inserted';
}
export function deleteItem(db, user, itemId) {
  const it = own(db, user, 'study_items', 'item_id', itemId, '题项');
  check(!one(db, 'SELECT 1 FROM study_responses WHERE instrument_id=? AND item_code=? LIMIT 1', it.instrument_id, it.code), 409, 'in_use', '该题项已有作答数据，不能删除');
  run(db, 'DELETE FROM study_items WHERE item_id=?', itemId);
}
export function deleteInstrument(db, user, iid) {
  const i = getInstrument(db, user, iid);
  tx(db, () => { run(db, 'DELETE FROM study_responses WHERE instrument_id=?', iid); run(db, 'DELETE FROM study_items WHERE instrument_id=?', iid); run(db, 'DELETE FROM study_instruments WHERE instrument_id=?', iid); });
  audit(db, { actor: user, action: 'study_instrument_deleted', target_type: 'study_instrument', target_id: iid, detail: { name: i.name } });
}
export function instrumentView(db, user, iid) {
  const i = getInstrument(db, user, iid);
  return { instrument: i, items: items(db, iid), qtypes: QTYPE_NAME, blooms: Object.fromEntries(Object.entries(BLOOM).map(([k, v]) => [k, v[0]])),
    n_response_sets: one(db, "SELECT COUNT(DISTINCT participant_code||'|'||timepoint) n FROM study_responses WHERE instrument_id=?", iid).n };
}

// ---------- scoring ----------
const normAns = (s) => { const t = String(s ?? '').trim().toUpperCase().replace(/\s+/g, ''); if (/^(对|√|✓|T|TRUE|正确|是|Y)$/.test(t)) return 'T'; if (/^(错|×|✗|F|FALSE|错误|否|N)$/.test(t)) return 'F'; return t; };
export function scoreItem(inst, item, value) {
  if (value == null || value === '') return null;
  if (inst.kind === 'scale') { const n = Number(value); if (!Number.isFinite(n)) return null; const [lo, hi] = inst.body.scale || [1, 5]; return item.reverse ? lo + hi - n : n; }
  const pts = item.points ?? 1, ans = String(item.answer ?? '').trim();
  if (['single', 'truefalse'].includes(item.qtype)) return ans ? (normAns(value) === normAns(ans) ? pts : 0) : null;
  if (item.qtype === 'multi') { const set = (s) => [...new Set(normAns(s).replace(/[,，、;；]/g, '').split(''))].sort().join(''); return ans ? (set(value) === set(ans) ? pts : 0) : null; }
  if (item.qtype === 'blank') return ans ? (ans.split(/[|｜]/).some((a) => normAns(a) === normAns(value)) ? pts : 0) : null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 && n <= pts ? n : null; // open questions: the teacher's given score
}
export function rescore(db, user, iid) {
  const inst = getInstrument(db, user, iid); const its = Object.fromEntries(items(db, iid).map((x) => [x.code, x]));
  let n = 0; tx(db, () => { for (const r of all(db, 'SELECT response_id, item_code, value FROM study_responses WHERE instrument_id=?', iid)) { run(db, 'UPDATE study_responses SET score=? WHERE response_id=?', its[r.item_code] ? scoreItem(inst, its[r.item_code], r.value) : null, r.response_id); n++; } });
  return { rescored: n };
}

// ---------- analysis ----------
function responseMatrix(db, inst, pid, { timepoint, condition } = {}) {
  const its = items(db, inst.instrument_id).filter((x) => !x.placeholder || inst.kind === 'scale');
  const ok = eligibleCodes(db, pid);
  const cond = Object.fromEntries(participants(db, pid).map((p) => [p.code, p.condition]));
  const rows = all(db, 'SELECT participant_code, timepoint, item_code, score FROM study_responses WHERE instrument_id=?', inst.instrument_id);
  const excluded = new Set(rows.filter((r) => !ok.has(r.participant_code)).map((r) => r.participant_code));
  const by = new Map();
  for (const r of rows) {
    if (!ok.has(r.participant_code) || (timepoint && r.timepoint !== timepoint) || (condition && cond[r.participant_code] !== condition)) continue;
    const k = `${r.participant_code}|${r.timepoint}`; if (!by.has(k)) by.set(k, { participant_code: r.participant_code, timepoint: r.timepoint, condition: cond[r.participant_code] || '', s: {} });
    by.get(k).s[r.item_code] = r.score;
  }
  return { its, sets: [...by.values()], excluded: [...excluded] };
}
export function analyzeInstrument(db, user, iid) {
  const inst = getInstrument(db, user, iid); const p = getProject(db, user, inst.project_id);
  const { its, sets, excluded } = responseMatrix(db, inst, inst.project_id);
  const tps = [...new Set(sets.map((s) => s.timepoint))].sort(), conds = [...new Set(sets.map((s) => s.condition))].sort();
  const base = { instrument: { name: inst.name, kind: inst.kind, source_status: inst.body.source_status, placeholders: its.filter((x) => x.placeholder).length }, n_sets: sets.length, excluded_unconsented: excluded.length, timepoints: tps, conditions: conds, thresholds: THRESHOLD_SOURCES,
    missing: its.map((it) => ({ item: it.code, missing: sets.filter((s) => s.s[it.code] == null).length })) };
  if (inst.kind === 'scale') {
    const dims = [...new Set(its.map((x) => x.dimension || '全量表'))];
    const dimItems = (d) => its.filter((x) => (x.dimension || '全量表') === d);
    const reliability = tps.flatMap((tp) => dims.map((d) => { const di = dimItems(d); const c = cronbach(sets.filter((s) => s.timepoint === tp).map((s) => di.map((x) => s.s[x.code]))); return { timepoint: tp, dimension: d, k: di.length, n: c.n, alpha: c.alpha, interpretation: INTERPRET.alpha(c.alpha), note: c.note || '', items: (c.items || []).map((x, j) => ({ item: di[j].code, reverse: !!di[j].reverse, mean: x.mean, sd: x.sd, citc: x.citc, alpha_if_deleted: x.alpha_if_deleted })) }; }));
    const descriptives = tps.flatMap((tp) => conds.flatMap((cd) => dims.map((d) => { const di = dimItems(d); const vals = sets.filter((s) => s.timepoint === tp && s.condition === cd).map((s) => { const v = di.map((x) => s.s[x.code]); return v.every((x) => x != null) ? v.reduce((a, b) => a + b, 0) / v.length : null; }).filter((x) => x != null); return { timepoint: tp, condition: cd || '（未分组）', dimension: d, ...describe(vals) }; })));
    return { ...base, dimensions: dims, reliability, descriptives, scoring_note: '维度分 = 该维度题项均值（反向题已按 最小+最大−原值 计分）；只统计已同意被试的完整作答。' };
  }
  const max = its.map((x) => x.points ?? 1);
  const analysis = tps.map((tp) => ({ timepoint: tp, ...itemAnalysis(sets.filter((s) => s.timepoint === tp).map((s) => its.map((x) => s.s[x.code])), max) }));
  analysis.forEach((a) => a.items?.forEach((x) => { x.item = its[x.index].code; x.flag = x.difficulty_p != null && (x.difficulty_p > 0.9 || x.difficulty_p < 0.2) ? '难度偏极端' : x.discrimination_d != null && x.discrimination_d < 0.2 ? '区分度偏低' : ''; }));
  const totals = tps.flatMap((tp) => conds.map((cd) => ({ timepoint: tp, condition: cd || '（未分组）', ...describe(sets.filter((s) => s.timepoint === tp && s.condition === cd).map((s) => { const v = its.map((x) => s.s[x.code]); return v.every((x) => x != null) ? v.reduce((a, b) => a + b, 0) : null; }).filter((x) => x != null)) })));
  const unscored = one(db, 'SELECT COUNT(*) n FROM study_responses WHERE instrument_id=? AND score IS NULL AND value IS NOT NULL AND value<>\'\'', iid).n;
  return { ...base, item_analysis: analysis, totals, unscored, max_total: max.reduce((a, b) => a + b, 0), scoring_note: `客观题按答案键自动计分；主观题需在作答表中填写得分。${unscored ? `仍有 ${unscored} 条作答未能计分（缺答案键或主观题未给分）。` : ''}难度 P = 平均得分率；区分度 D = 高分组(27%)与低分组得分率之差。` };
}

// ---------- codebooks / units / coding ----------
export function saveCodebook(db, user, input) {
  getProject(db, user, input.project_id);
  const name = str(input.name, 60); check(name, 400, 'bad_name', '请填写编码表名称');
  const codebook_id = id('cb');
  run(db, 'INSERT INTO study_codebooks(codebook_id,project_id,owner_id,name,mode,framework,created_at) VALUES(?,?,?,?,?,?,?)', codebook_id, input.project_id, user.user_id, name, input.mode === 'multi' ? 'multi' : 'exclusive', str(input.framework, 300), now());
  return codebookView(db, user, codebook_id);
}
export function deleteCodebook(db, user, cid) { getCodebook(db, user, cid); tx(db, () => { run(db, 'DELETE FROM study_codings WHERE codebook_id=?', cid); run(db, 'DELETE FROM study_codes WHERE codebook_id=?', cid); run(db, 'DELETE FROM study_codebooks WHERE codebook_id=?', cid); }); }
export const codebookView = (db, user, cid) => { const c = getCodebook(db, user, cid); return { codebook: c, codes: codes(db, cid), coders: all(db, 'SELECT coder, COUNT(DISTINCT unit_id) n FROM study_codings WHERE codebook_id=? GROUP BY coder', cid) }; };
export function putCode(db, user, cid, r) {
  getCodebook(db, user, cid); check(CODE_RE.test(r.code || ''), 400, 'bad_code', '代码只能含字母、数字、汉字、下划线'); check(str(r.label, 40), 400, 'bad_label', '请填写代码名称');
  const ex = one(db, 'SELECT 1 FROM study_codes WHERE codebook_id=? AND code=?', cid, r.code);
  const vals = [str(r.label, 40), str(r.category, 40) || null, str(r.definition, 600) || null, str(r.include_rule, 400) || null, str(r.exclude_rule, 400) || null, str(r.example, 400) || null, r.seq ?? null];
  if (ex) run(db, 'UPDATE study_codes SET label=?, category=?, definition=?, include_rule=?, exclude_rule=?, example=?, seq=? WHERE codebook_id=? AND code=?', ...vals, cid, r.code);
  else run(db, 'INSERT INTO study_codes(codebook_id,owner_id,code,label,category,definition,include_rule,exclude_rule,example,seq) VALUES(?,?,?,?,?,?,?,?,?,?)', cid, user.user_id, r.code, ...vals);
  return ex ? 'updated' : 'inserted';
}
export function deleteCode(db, user, cid, code) { getCodebook(db, user, cid); check(!one(db, 'SELECT 1 FROM study_codings WHERE codebook_id=? AND code=? LIMIT 1', cid, code), 409, 'in_use', '该代码已被使用，不能删除'); run(db, 'DELETE FROM study_codes WHERE codebook_id=? AND code=?', cid, code); }

/** Copy platform events (simulated) into the project as coding units, clearly marked source=platform_event. */
export function unitsFromRuns(db, user, pid, runIds) {
  getProject(db, user, pid);
  check(Array.isArray(runIds) && runIds.length && runIds.length <= 50, 400, 'bad_runs', '请选择 1—50 次运行');
  let n = 0;
  tx(db, () => { for (const rid of runIds) {
    const r = one(db, 'SELECT run_id, module FROM runs WHERE run_id=? AND owner_id=?', rid, user.user_id); check(r, 404, 'not_found', '运行不存在');
    const names = Object.fromEntries(all(db, 'SELECT agent_id, name, role FROM agent_profiles WHERE run_id=?', rid).map((p) => [p.agent_id, p]));
    for (const e of all(db, "SELECT * FROM events WHERE run_id=? AND actor_type<>'system' ORDER BY sequence", rid)) {
      if (one(db, 'SELECT 1 FROM study_units WHERE project_id=? AND event_id=?', pid, e.event_id)) continue;
      run(db, 'INSERT INTO study_units(unit_id,project_id,owner_id,source,session,seq,speaker,speaker_role,grp,time,text,event_id,run_id,stage,participant_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id('unit'), pid, user.user_id, 'platform_event', rid, e.sequence, e.actor_type === 'human' ? 'H' : e.actor_id, e.actor_type === 'human' ? `真人·${e.human_role || 'teacher'}` : names[e.actor_id]?.role || e.actor_type, e.group_id, e.time, e.text, e.event_id, rid, e.stage, null, now());
      n++;
    }
  } });
  return { added: n };
}
export function deleteUnits(db, user, pid, { session } = {}) {
  getProject(db, user, pid);
  const ids = all(db, `SELECT unit_id FROM study_units WHERE project_id=? ${session ? 'AND session=?' : ''}`, pid, ...(session ? [session] : [])).map((u) => u.unit_id);
  tx(db, () => { for (const u of ids) run(db, 'DELETE FROM study_codings WHERE unit_id=?', u); run(db, `DELETE FROM study_units WHERE project_id=? ${session ? 'AND session=?' : ''}`, pid, ...(session ? [session] : [])); });
  return { deleted: ids.length };
}
/** Coding workspace. Blind mode never reveals other coders' codes. */
export function codingView(db, user, cid, { coder, session, offset = 0, limit = 60 }) {
  const cb = getCodebook(db, user, cid);
  const sessions = all(db, 'SELECT session, source, COUNT(*) n FROM study_units WHERE project_id=? GROUP BY session, source ORDER BY session', cb.project_id);
  const s = session || sessions[0]?.session || null;
  const units = s ? all(db, 'SELECT unit_id, source, session, seq, speaker, speaker_role, grp, stage, text FROM study_units WHERE project_id=? AND session=? ORDER BY seq LIMIT ? OFFSET ?', cb.project_id, s, Math.min(Number(limit) || 60, 200), Number(offset) || 0) : [];
  const mine = coder ? all(db, 'SELECT unit_id, code FROM study_codings WHERE codebook_id=? AND coder=?', cid, coder) : [];
  const map = {}; for (const m of mine) (map[m.unit_id] ||= []).push(m.code);
  return { codebook: cb, codes: codes(db, cid), sessions, session: s, total: s ? one(db, 'SELECT COUNT(*) n FROM study_units WHERE project_id=? AND session=?', cb.project_id, s).n : 0, units: units.map((u) => ({ ...u, mine: map[u.unit_id] || [] })), coder };
}
export function setCoding(db, user, { codebook_id, unit_id, coder, codes: cs = [], note }) {
  const cb = getCodebook(db, user, codebook_id);
  check(CODE_RE.test(coder || ''), 400, 'bad_coder', '请填写编码者假名（如 C1）');
  check(one(db, 'SELECT 1 FROM study_units WHERE unit_id=? AND project_id=?', unit_id, cb.project_id), 404, 'not_found', '话语单元不存在');
  const valid = new Set(codes(db, codebook_id).map((c) => c.code));
  cs = [...new Set(cs)]; for (const c of cs) check(valid.has(c), 400, 'bad_code', `代码 ${c} 不在编码表中`);
  check(cb.mode === 'multi' || cs.length <= 1, 400, 'exclusive', '该编码表为互斥编码：每个单元只能选 1 个代码');
  tx(db, () => { run(db, 'DELETE FROM study_codings WHERE codebook_id=? AND unit_id=? AND coder=?', codebook_id, unit_id, coder);
    for (const c of cs) run(db, 'INSERT INTO study_codings(coding_id,project_id,owner_id,codebook_id,unit_id,coder,code,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id('cod'), cb.project_id, user.user_id, codebook_id, unit_id, coder, c, str(note, 300) || null, now()); });
  return { unit_id, codes: cs };
}
export function codingIrr(db, user, cid) {
  const cb = getCodebook(db, user, cid);
  const rows = all(db, 'SELECT unit_id, coder, code FROM study_codings WHERE codebook_id=?', cid);
  const coders = [...new Set(rows.map((r) => r.coder))].sort();
  if (coders.length < 2) return { coders, note: '至少需要 2 位编码者独立编码同一批单元' };
  const byUnit = new Map(); for (const r of rows) { if (!byUnit.has(r.unit_id)) byUnit.set(r.unit_id, {}); (byUnit.get(r.unit_id)[r.coder] ||= []).push(r.code); }
  const shared = [...byUnit.entries()].filter(([, m]) => Object.keys(m).length >= 2);
  const out = { coders, mode: cb.mode, n_units_coded: byUnit.size, n_units_shared: shared.length, thresholds: THRESHOLD_SOURCES };
  if (cb.mode === 'exclusive') {
    out.krippendorff = { ...krippendorff(shared.map(([, m]) => coders.map((c) => m[c]?.[0] ?? null)), 'nominal') }; out.krippendorff.interpretation = INTERPRET.kalpha(out.krippendorff.alpha);
    out.pairs = [];
    for (let a = 0; a < coders.length; a++) for (let b = a + 1; b < coders.length; b++) { const pr = shared.filter(([, m]) => m[coders[a]] && m[coders[b]]).map(([, m]) => [m[coders[a]][0], m[coders[b]][0]]); const k = cohenKappa(pr); out.pairs.push({ a: coders[a], b: coders[b], ...k, interpretation: INTERPRET.kappa(k.kappa) }); }
  } else {
    out.per_code = codes(db, cid).map((c) => { const units = shared.map(([, m]) => coders.map((cd) => (m[cd] ? (m[cd].includes(c.code) ? 1 : 0) : null))); const k = krippendorff(units, 'nominal'); return { code: c.code, label: c.label, alpha: k.alpha, interpretation: INTERPRET.kalpha(k.alpha) }; });
  }
  const disagreements = shared.filter(([, m]) => new Set(Object.values(m).map((x) => [...x].sort().join('+'))).size > 1).slice(0, 50);
  out.disagreements = disagreements.map(([uid, m]) => ({ unit_id: uid, text: (one(db, 'SELECT text FROM study_units WHERE unit_id=?', uid)?.text || '').slice(0, 120), codes: m }));
  return out;
}
/** Rows for ENA (one row per unit, binary code columns) and lag-sequential analysis. Uses one coder (or the consensus of all). */
export function sequenceData(db, user, cid, coder) {
  const cb = getCodebook(db, user, cid); const cs = codes(db, cid);
  const units = all(db, 'SELECT * FROM study_units WHERE project_id=? ORDER BY session, seq', cb.project_id);
  const rows = all(db, `SELECT unit_id, code, coder FROM study_codings WHERE codebook_id=? ${coder ? 'AND coder=?' : ''}`, cid, ...(coder ? [coder] : []));
  const nCoders = new Set(rows.map((r) => r.coder)).size;
  const by = new Map(); for (const r of rows) { if (!by.has(r.unit_id)) by.set(r.unit_id, new Map()); const m = by.get(r.unit_id); m.set(r.code, (m.get(r.code) || 0) + 1); }
  const has = (u, c) => { const m = by.get(u.unit_id); if (!m) return 0; return coder || nCoders <= 1 ? (m.get(c) ? 1 : 0) : (m.get(c) || 0) / nCoders > 0.5 ? 1 : 0; };
  const ena = units.filter((u) => by.has(u.unit_id)).map((u) => ({ session: u.session, source: u.source, seq: u.seq, speaker: u.speaker, speaker_role: u.speaker_role, group: u.grp || '', stage: u.stage || '', ...Object.fromEntries(cs.map((c) => [c.code, has(u, c.code)])) }));
  const seqs = [...new Set(units.map((u) => u.session))].map((s) => units.filter((u) => u.session === s && by.has(u.unit_id)).map((u) => cs.filter((c) => has(u, c.code)).map((c) => c.code)[0]).filter(Boolean));
  return { codes: cs, ena, lag: lagSequential(seqs), basis: coder ? `编码者 ${coder}` : nCoders > 1 ? `${nCoders} 位编码者多数一致` : '单一编码者' };
}

// ---------- rating agreement (existing ratings table) ----------
export function ratingIrr(db, user, rubricId) {
  const rub = one(db, 'SELECT * FROM rubrics WHERE rubric_id=? AND (owner_id IS NULL OR owner_id=?)', rubricId, user.user_id); check(rub, 404, 'not_found', '量规不存在');
  const def = json(rub.body);
  const latest = research.listRatings(db, user, {}).filter((r) => r.rubric_id === rubricId);
  const superseded = new Set(latest.map((r) => r.supersedes_rating_id).filter(Boolean));
  const cur = latest.filter((r) => !superseded.has(r.rating_id));
  const raters = [...new Set(cur.map((r) => r.rater_code))].sort();
  const targets = [...new Set(cur.map((r) => r.target_id))];
  const res = { rubric: { name: rub.name, version: rub.version }, raters, n_targets: targets.length, thresholds: THRESHOLD_SOURCES, dimensions: [] };
  if (raters.length < 2) return { ...res, note: '至少需要 2 位评价者（不同假名编码）独立评同一批对象' };
  for (const d of def.dimensions) {
    const grid = targets.map((t) => raters.map((rt) => { const r = cur.find((x) => x.target_id === t && x.rater_code === rt); const v = r?.scores?.[d.key]; return Number.isInteger(v) ? v : null; }));
    const shared = grid.filter((g) => g.filter((v) => v != null).length >= 2);
    const ka = krippendorff(shared, 'ordinal'); const ic = icc(shared.filter((g) => g.every((v) => v != null)));
    const pair = raters.length === 2 ? cohenKappa(shared.map((g) => [g[0], g[1]]), { weighted: true }) : null;
    res.dimensions.push({ key: d.key, label: d.label, n_shared: shared.length, krippendorff_ordinal: ka.alpha, alpha_interpretation: INTERPRET.kalpha(ka.alpha), weighted_kappa: pair?.kappa ?? null, percent_agreement: pair?.percent_agreement ?? null, icc2_1: ic.icc2_1 ?? null, icc_interpretation: INTERPRET.icc(ic.icc2_1), icc_note: ic.note });
  }
  return res;
}

// ---------- smart import/export registry ----------
const consentField = { key: 'consent', label: '知情同意', type: 'enum', options: CONSENT, synonyms: ['同意', '知情同意书', '是否同意', 'consent'], value_labels: CONSENT_NAME, help: '已同意 / 待确认 / 拒绝 / 已退出；只有“已同意”的被试进入分析与导出' };
const PII_HEADER = /姓名|名字|^name$|学号|工号|身份证|手机|电话|邮箱|e-?mail|住址|家庭/i;
const P_FIELDS = [
  { key: 'code', label: '被试编码', type: 'code', required: true, synonyms: ['编码', '编号', '代号', '研究编码', '被试', '被试号', 'id', 'participant', 'participant_id', 'pid', 'subject'], help: '研究编码，如 P001；不要用姓名或学号' },
  { key: 'role', label: '身份', type: 'enum', options: { student: ['学生'], teacher: ['教师', '老师'], expert: ['专家', '督导'], other: ['其他'] }, synonyms: ['角色', '类别', '身份类别', 'role'] },
  { key: 'condition', label: '组别', type: 'text', max_len: 20, synonyms: ['组别', '条件', '分组', '实验条件', '实验组别', 'group', 'condition', 'arm'], help: '填写研究项目中设置的组别编码' },
  { key: 'cohort', label: '班级/批次', type: 'text', max_len: 40, synonyms: ['班级', '批次', '学校', '院校', 'class', 'cohort', 'school'] },
  { key: 'grp', label: '小组', type: 'text', max_len: 20, synonyms: ['小组', '组号', '学习小组', 'team'] },
  { key: 'gender', label: '性别', type: 'enum', options: { f: ['女', 'female', 'F', '2'], m: ['男', 'male', 'M', '1'], other: ['其他'], undisclosed: ['不愿透露', '未知', '保密'] }, synonyms: ['sex', 'gender'], value_labels: { f: '女', m: '男', other: '其他', undisclosed: '不愿透露' } },
  { key: 'age', label: '年龄', type: 'int', min: 10, max: 90, synonyms: ['岁', 'age'], measure: 'scale' },
  { key: 'grade', label: '年级', type: 'text', max_len: 20, synonyms: ['年级', '学段', 'grade', '教龄'] },
  { key: 'major', label: '专业/学科', type: 'text', max_len: 40, synonyms: ['专业', '学科', '任教学科', 'major', 'subject'] },
  { key: 'prior_score', label: '前测/先修成绩', type: 'number', synonyms: ['前测', '先修', '先修成绩', '入学成绩', '基础成绩', 'pretest', 'prior'], measure: 'scale' },
  consentField,
  { key: 'consent_date', label: '同意日期', type: 'date', synonyms: ['签署日期', '同意时间', 'consent_date'] },
  { key: 'note', label: '备注', type: 'text', max_len: 300, synonyms: ['备注', '说明', 'note'] },
];
const SCALE_ITEM_FIELDS = [
  { key: 'code', label: '题项编码', type: 'code', required: true, synonyms: ['题号', '编号', '题项', 'item', 'item_code', '代码'] },
  { key: 'dimension', label: '维度', type: 'text', max_len: 40, synonyms: ['维度', '因子', '分量表', 'factor', 'dimension', 'subscale'] },
  { key: 'text', label: '题项内容', type: 'text', required: true, max_len: 1000, synonyms: ['题目', '题干', '内容', '条目', 'item_text', 'wording', 'statement'] },
  { key: 'reverse', label: '反向计分', type: 'bool', default: false, synonyms: ['反向', '反向题', '是否反向', 'reverse', 'reversed', 'r'] },
  { key: 'seq', label: '顺序', type: 'int', min: 0, max: 9999, synonyms: ['序号', '顺序', 'order'] },
];
const TEST_ITEM_FIELDS = [
  { key: 'code', label: '题号', type: 'code', required: true, synonyms: ['题号', '编号', '题目编号', 'item', 'q'] },
  { key: 'qtype', label: '题型', type: 'enum', options: QTYPE, synonyms: ['题型', '类型', 'type'] },
  { key: 'text', label: '题干', type: 'text', required: true, max_len: 1000, synonyms: ['题目', '题干', '内容', 'stem', 'question'] },
  { key: 'options', label: '选项', type: 'text', max_len: 1000, synonyms: ['选项', 'options', 'choices'] },
  { key: 'answer', label: '答案', type: 'text', max_len: 200, synonyms: ['答案', '参考答案', '正确答案', 'key', 'answer'], help: '单选填 A；多选填 ABD；判断填 对/错；填空多个可接受答案用 | 分隔；主观题可留空' },
  { key: 'points', label: '分值', type: 'number', min: 0, max: 100, synonyms: ['分值', '分数', '满分', 'points', 'score'] },
  { key: 'dimension', label: '考查维度/目标', type: 'text', max_len: 40, synonyms: ['维度', '目标', '课程目标', 'objective'] },
  { key: 'knowledge_point', label: '知识点', type: 'text', max_len: 80, synonyms: ['知识点', 'kp', 'topic'] },
  { key: 'cognitive_level', label: '认知层次', type: 'enum', options: BLOOM, synonyms: ['认知层次', '布卢姆', '层次', 'bloom', 'level'] },
  { key: 'seq', label: '顺序', type: 'int', min: 0, max: 9999, synonyms: ['序号', '顺序'] },
];
const UNIT_FIELDS = [
  { key: 'session', label: '场次/课次', type: 'code', required: true, synonyms: ['场次', '课次', '会话', '录音', 'session', 'lesson', 'conversation', '课堂'] },
  { key: 'seq', label: '序号', type: 'int', min: 0, max: 1e6, synonyms: ['序号', '行号', '话轮', 'turn', 'line', 'seq'] },
  { key: 'speaker', label: '说话人编码', type: 'code', synonyms: ['说话人', '发言人', '发言者', 'speaker', '被试编码'] },
  { key: 'speaker_role', label: '说话人身份', type: 'text', max_len: 20, synonyms: ['身份', '角色', 'role'] },
  { key: 'grp', label: '小组', type: 'text', max_len: 20, synonyms: ['小组', '组', 'group'] },
  { key: 'time', label: '时间', type: 'text', max_len: 20, synonyms: ['时间', '时间戳', 'time', 'timestamp'] },
  { key: 'text', label: '话语内容', type: 'text', required: true, max_len: 4000, synonyms: ['内容', '文本', '话语', '转录', 'utterance', 'text', 'transcript'] },
  { key: 'participant_code', label: '被试编码', type: 'code', synonyms: ['被试编码', 'participant', 'pid'] },
];
const CODE_FIELDS = [
  { key: 'code', label: '代码', type: 'code', required: true, synonyms: ['代码', '编码', '码', 'code'] },
  { key: 'label', label: '名称', type: 'text', required: true, max_len: 40, synonyms: ['名称', '类目', '标签', 'label', 'name'] },
  { key: 'category', label: '上位类别', type: 'text', max_len: 40, synonyms: ['类别', '维度', '上位', 'category', 'dimension'] },
  { key: 'definition', label: '定义', type: 'text', max_len: 600, synonyms: ['定义', '说明', 'definition'] },
  { key: 'include_rule', label: '纳入规则', type: 'text', max_len: 400, synonyms: ['纳入', '适用', 'include'] },
  { key: 'exclude_rule', label: '排除规则', type: 'text', max_len: 400, synonyms: ['排除', '不适用', 'exclude'] },
  { key: 'example', label: '示例', type: 'text', max_len: 400, synonyms: ['示例', '例子', '样例', 'example'] },
  { key: 'seq', label: '顺序', type: 'int', min: 0, max: 9999, synonyms: ['序号', '顺序'] },
];

/** Dataset registry. Every importable table declares fields; dynamic fields are computed from context (items, rubric dims, section columns). */
export const DATASETS = {
  participants: { label: '被试名册', ctx: ['project_id'], fields: () => P_FIELDS },
  scale_items: { label: '量表题项', ctx: ['instrument_id'], fields: () => SCALE_ITEM_FIELDS },
  test_items: { label: '测试题目与答案键', ctx: ['instrument_id'], fields: () => TEST_ITEM_FIELDS },
  responses: { label: '作答数据（宽表：一行一人一时间点）', ctx: ['instrument_id'], fields: (db, user, c) => responseFields(db, user, c) },
  codes: { label: '编码表（代码与定义）', ctx: ['codebook_id'], fields: () => CODE_FIELDS },
  units: { label: '话语单元（真实课堂 / 教研转录）', ctx: ['project_id'], fields: () => UNIT_FIELDS },
  codings: { label: '编码结果', ctx: ['codebook_id'], fields: () => [
    { key: 'unit_id', label: '单元ID', type: 'text', synonyms: ['单元', 'unit', 'unit_id'] }, { key: 'session', label: '场次/课次', type: 'text', synonyms: ['场次', '课次', 'session'] },
    { key: 'seq', label: '序号', type: 'int', synonyms: ['序号', '行号', 'turn', 'seq'] }, { key: 'coder', label: '编码者', type: 'code', required: true, synonyms: ['编码者', '编码员', 'coder', 'rater'] },
    { key: 'code', label: '代码', type: 'list', required: true, synonyms: ['代码', '编码', 'code', 'codes'], help: '多个代码用分号分隔（仅多选编码表）' }] },
  ratings: { label: '人工评分（外部评价者）', ctx: ['rubric_id'], fields: (db, user, c) => ratingFields(db, user, c) },
  artifact_section: { label: '产物表格', ctx: ['artifact_id', 'section_key'], fields: (db, user, c) => sectionFields(db, user, c), previewOnly: true },
};
function responseFields(db, user, c) {
  const inst = getInstrument(db, user, c.instrument_id), p = getProject(db, user, inst.project_id);
  const tpOpts = Object.fromEntries((p.body.timepoints || []).map((t) => [t.code, [t.label]]));
  check(Object.keys(tpOpts).length, 400, 'no_timepoints', '请先在研究项目中设置时间点（如 T0 前测、T1 后测）');
  const [lo, hi] = inst.body.scale || [null, null];
  return [
    { key: 'participant_code', label: '被试编码', type: 'code', required: true, synonyms: ['编码', '编号', '被试', '被试编码', 'id', 'pid', 'participant'] },
    { key: 'timepoint', label: '时间点', type: 'enum', options: tpOpts, required: !c.timepoint, synonyms: ['时间点', '测次', '施测', '阶段', 'time', 'wave', 'timepoint'], help: `可用：${Object.entries(tpOpts).map(([k, v]) => `${k}=${v[0]}`).join('，')}` },
    { key: 'collected_at', label: '施测日期', type: 'date', synonyms: ['日期', '施测时间', '填写时间', '提交时间', 'date'] },
    ...items(db, inst.instrument_id).map((it) => ({ key: `item:${it.code}`, label: it.code, item: it.code, type: inst.kind === 'scale' ? 'number' : 'text', min: inst.kind === 'scale' ? lo : undefined, max: inst.kind === 'scale' ? hi : undefined,
      synonyms: [`Q${it.seq}`, `第${it.seq}题`, String(it.seq ?? ''), `${it.code}`, `题${it.seq}`, String(it.text || '').replace(/【占位】.*/, '').slice(0, 16)].filter((x) => x && x.length), measure: inst.kind === 'scale' ? 'ordinal' : undefined })),
  ];
}
function ratingFields(db, user, c) {
  const rub = one(db, 'SELECT * FROM rubrics WHERE rubric_id=? AND (owner_id IS NULL OR owner_id=?)', c.rubric_id, user.user_id); check(rub, 404, 'not_found', '量规不存在');
  const def = json(rub.body);
  return [
    { key: 'target_type', label: '对象类型', type: 'enum', options: { event: ['事件', '发言'], artifact: ['产物', '产物版本'] }, synonyms: ['对象类型', 'type'] },
    { key: 'target_id', label: '对象ID', type: 'text', required: true, synonyms: ['对象', '事件ID', '产物ID', 'event_id', 'artifact_id', 'target'] },
    { key: 'rater_code', label: '评价者编码', type: 'code', required: true, synonyms: ['评价者', '评分者', '评委', 'rater', 'rater_code'] },
    ...def.dimensions.map((d) => ({ key: `dim:${d.key}`, dim: d.key, label: d.label, type: 'text', synonyms: [d.key] })),
    { key: 'note', label: '依据/备注', type: 'text', max_len: 2000, synonyms: ['备注', '依据', 'note'] },
  ];
}
function sectionFields(db, user, c) {
  const a = rowToArtifact(getOwned(db, user, c.artifact_id)); const s = a.body.sections.find((x) => x.key === c.section_key);
  check(s && s.kind === 'table', 400, 'bad_section', '该段落不是表格');
  return s.columns.map((col) => ({ key: col.key, label: col.label, type: 'text', max_len: 4000, synonyms: [col.key, ...(col.options || [])].slice(0, 1) }));
}
const ctxOf = (x = {}) => Object.fromEntries(['project_id', 'instrument_id', 'codebook_id', 'rubric_id', 'artifact_id', 'section_key', 'timepoint'].filter((k) => x[k]).map((k) => [k, String(x[k])]));
function dataset(db, user, name, ctx) {
  const d = DATASETS[name]; check(d, 400, 'bad_dataset', '未知数据表');
  for (const k of d.ctx) check(ctx[k], 400, 'bad_ctx', `缺少 ${k}`);
  if (ctx.project_id) getProject(db, user, ctx.project_id);
  if (ctx.instrument_id) { const i = getInstrument(db, user, ctx.instrument_id); if (name === 'scale_items') check(i.kind === 'scale', 400, 'bad_kind', '这是测试，请用“测试题目”'); if (name === 'test_items') check(i.kind === 'test', 400, 'bad_kind', '这是量表，请用“量表题项”'); }
  if (ctx.codebook_id) getCodebook(db, user, ctx.codebook_id);
  return { ...d, name, fieldList: d.fields(db, user, ctx) };
}

/** Parse → suggest mapping → validate. Nothing is written. */
export function importPreview(db, user, input) {
  const ctx = ctxOf(input.ctx); const ds = dataset(db, user, input.dataset, ctx);
  const buf = Buffer.from(String(input.data_base64 || ''), 'base64'); check(buf.length, 400, 'empty', '请选择文件');
  const sheets = readTable(input.filename, buf);
  const si = Math.min(Math.max(0, Number(input.sheet) || 0), sheets.length - 1);
  const grid = sheets[si]?.rows || [];
  check(grid.length >= 2, 400, 'empty', '表格至少需要表头和 1 行数据');
  const hr = Math.min(Math.max(0, Number(input.header_row) || 0), grid.length - 2);
  const headers = grid[hr].map((h, i) => h || `列${i + 1}`), body = grid.slice(hr + 1);
  check(body.length <= 20000, 400, 'too_many', '单次最多导入 20000 行');
  const pii = headers.map((h, i) => (PII_HEADER.test(h) ? i : -1)).filter((i) => i >= 0);
  let mapping = Array.isArray(input.mapping) && input.mapping.length === headers.length
    ? headers.map((h, i) => ({ index: i, column: h, field: ds.fieldList.some((f) => f.key === input.mapping[i]) ? input.mapping[i] : null, score: null, how: '手动指定' }))
    : suggestMapping(headers, ds.fieldList);
  mapping = mapping.map((m) => (pii.includes(m.index) ? { ...m, field: null, how: '疑似个人身份信息列，已忽略' } : m));
  const used = mapping.filter((m) => m.field).map((m) => m.field);
  check(new Set(used).size === used.length, 400, 'dup_mapping', '同一个字段只能对应一列');
  const extra = rowCheck(db, user, ds, ctx);
  const { records, errors } = applyMapping(body, mapping, ds.fieldList, { extra });
  const piiValues = piiScan(body.map((r) => r.join(' ')).join('\n'));
  audit(db, { actor: user, action: 'import_previewed', target_type: 'dataset', target_id: ds.name, detail: { rows: body.length, valid: records.length, errors: errors.length } });
  return { dataset: ds.name, label: ds.label, sheets: sheets.map((s) => ({ name: s.name, rows: s.rows.length })), sheet: si, header_row: hr, headers, mapping, fields: ds.fieldList.map(({ key, label, type, required, help, options }) => ({ key, label, type: TYPE_LABEL[type] || type, required: !!required, help, options: options ? Object.entries(options).map(([k, v]) => v?.[0] || k) : undefined })),
    sample: body.slice(0, 8).map((r) => r.map((c, i) => (pii.includes(i) && c ? '•••' : c))), n_rows: body.length, n_valid: records.length, errors: errors.slice(0, 200), n_errors: errors.length,
    unmapped_required: ds.fieldList.filter((f) => f.required && !used.includes(f.key)).map((f) => f.label), ignored_pii_columns: pii.map((i) => headers[i]), pii_values: piiValues,
    records: ds.previewOnly ? records : undefined, preview_only: !!ds.previewOnly };
}
function rowCheck(db, user, ds, ctx) {
  if (ds.name === 'participants') { const conds = new Set((getProject(db, user, ctx.project_id).body.conditions || []).map((c) => c.code)); return (rec) => (rec.condition && conds.size && !conds.has(rec.condition) ? [`组别“${rec.condition}”未在项目中设置（可用：${[...conds].join('/')}）`] : []); }
  if (ds.name === 'responses') {
    const inst = getInstrument(db, user, ctx.instrument_id); const roster = new Set(participants(db, inst.project_id).map((p) => p.code));
    return (rec) => { const e = []; if (rec.participant_code && !roster.has(rec.participant_code)) e.push(`被试编码 ${rec.participant_code} 未在被试名册中登记（请先导入名册并记录知情同意）`); if (!rec.timepoint && !ctx.timepoint) e.push('缺少时间点'); return e; };
  }
  if (ds.name === 'codings') { const cb = getCodebook(db, user, ctx.codebook_id); const valid = new Set(codes(db, ctx.codebook_id).map((c) => c.code));
    return (rec) => { const e = []; if (!rec.unit_id && !(rec.session && rec.seq != null)) e.push('需提供“单元ID”，或“场次 + 序号”'); for (const c of rec.code || []) if (!valid.has(c)) e.push(`代码 ${c} 不在编码表中`); if (cb.mode === 'exclusive' && (rec.code || []).length > 1) e.push('互斥编码表每个单元只能有 1 个代码'); return e; }; }
  if (ds.name === 'ratings') return (rec) => (rec.target_id ? [] : ['缺少对象ID']);
  return null;
}

/** Commit an import. mode: 'upsert' (default: update by key, insert new) | 'append' (skip existing keys). */
export function importCommit(db, user, input) {
  const p = importPreview(db, user, input);
  check(!p.preview_only, 400, 'preview_only', '该表格导入后在编辑器中合并，请保存产物');
  check(p.n_valid > 0, 400, 'no_valid', '没有可导入的有效行');
  check(!p.unmapped_required.length, 400, 'missing_required', `缺少必填列：${p.unmapped_required.join('、')}`);
  if (p.n_errors && input.skip_invalid !== true) fail(400, 'has_errors', `有 ${p.n_errors} 行未通过校验。请修正后重试，或选择“跳过无效行”`);
  const ctx = ctxOf(input.ctx), ds = dataset(db, user, input.dataset, ctx);
  const { records } = applyMapping(readTable(input.filename, Buffer.from(String(input.data_base64), 'base64'))[p.sheet].rows.slice(p.header_row + 1), p.mapping, ds.fieldList, { extra: rowCheck(db, user, ds, ctx) });
  const mode = input.mode === 'append' ? 'append' : 'upsert', batch = id('batch');
  const res = tx(db, () => commitRows(db, user, ds, ctx, records, mode, batch));
  audit(db, { actor: user, action: 'import_committed', target_type: 'dataset', target_id: ds.name, detail: { ...res, skipped_invalid: p.n_errors, batch } });
  return { ...res, skipped_invalid: p.n_errors, batch_id: batch };
}
function commitRows(db, user, ds, ctx, records, mode, batch) {
  let inserted = 0, updated = 0, skipped = 0;
  const tally = (r) => { if (r === 'inserted') inserted++; else if (r === 'updated') updated++; else skipped++; };
  if (ds.name === 'participants') for (const r of records) {
    const ex = one(db, 'SELECT participant_id FROM study_participants WHERE project_id=? AND code=?', ctx.project_id, r.code);
    if (ex && mode === 'append') { skipped++; continue; }
    const consent = r.consent || 'pending';
    if (ex) { const cols = P_FIELDS.map((f) => f.key).filter((k) => k !== 'code' && r[k] !== undefined && r[k] !== null); if (cols.length) run(db, `UPDATE study_participants SET ${cols.map((k) => `${k}=?`).join(', ')}, withdrawn_at=${r.consent === 'withdrawn' ? 'COALESCE(withdrawn_at, ?)' : r.consent ? 'NULL' : 'withdrawn_at'}, updated_at=? WHERE participant_id=?`, ...cols.map((k) => (k === 'note' ? redact(String(r[k])) : r[k])), ...(r.consent === 'withdrawn' ? [now()] : []), now(), ex.participant_id); updated++; continue; }
    run(db, 'INSERT INTO study_participants(participant_id,project_id,owner_id,code,role,condition,cohort,grp,gender,age,grade,major,prior_score,consent,consent_date,withdrawn_at,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id('ptc'), ctx.project_id, user.user_id, r.code, r.role || null, r.condition || null, r.cohort || null, r.grp || null, r.gender || null, r.age ?? null, r.grade || null, r.major || null, r.prior_score ?? null, consent, r.consent_date || null, consent === 'withdrawn' ? now() : null, r.note ? redact(r.note) : null, now(), now());
    inserted++;
  }
  else if (ds.name === 'scale_items' || ds.name === 'test_items') {
    let seq = one(db, 'SELECT MAX(seq) m FROM study_items WHERE instrument_id=?', ctx.instrument_id).m || 0;
    for (const r of records) { if (mode === 'append' && one(db, 'SELECT 1 FROM study_items WHERE instrument_id=? AND code=?', ctx.instrument_id, r.code)) { skipped++; continue; } tally(putItem(db, user, ctx.instrument_id, { ...r, seq: r.seq ?? ++seq, placeholder: /【占位】/.test(r.text || '') })); }
  }
  else if (ds.name === 'responses') {
    const inst = getInstrument(db, user, ctx.instrument_id); const its = Object.fromEntries(items(db, inst.instrument_id).map((x) => [x.code, x]));
    for (const r of records) {
      const tp = r.timepoint || ctx.timepoint;
      for (const [k, v] of Object.entries(r)) {
        if (!k.startsWith('item:') || v == null || v === '') continue;
        const code = k.slice(5), it = its[code]; const val = String(v); const score = scoreItem(inst, it, val);
        const ex = one(db, 'SELECT response_id FROM study_responses WHERE instrument_id=? AND participant_code=? AND timepoint=? AND item_code=?', inst.instrument_id, r.participant_code, tp, code);
        if (ex) { if (mode === 'append') { skipped++; continue; } run(db, 'UPDATE study_responses SET value=?, score=?, collected_at=COALESCE(?, collected_at), batch_id=? WHERE response_id=?', val, score, r.collected_at || null, batch, ex.response_id); updated++; }
        else { run(db, 'INSERT INTO study_responses(response_id,project_id,owner_id,instrument_id,participant_code,timepoint,item_code,value,score,collected_at,batch_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', id('resp'), inst.project_id, user.user_id, inst.instrument_id, r.participant_code, tp, code, val, score, r.collected_at || null, batch, now()); inserted++; }
      }
    }
  }
  else if (ds.name === 'codes') { let seq = 0; for (const r of records) { if (mode === 'append' && one(db, 'SELECT 1 FROM study_codes WHERE codebook_id=? AND code=?', ctx.codebook_id, r.code)) { skipped++; continue; } tally(putCode(db, user, ctx.codebook_id, { ...r, seq: r.seq ?? ++seq })); } }
  else if (ds.name === 'units') {
    const auto = {};
    for (const r of records) {
      const seq = r.seq ?? (auto[r.session] = (auto[r.session] ?? (one(db, 'SELECT MAX(seq) m FROM study_units WHERE project_id=? AND session=?', ctx.project_id, r.session).m || 0)) + 1);
      const ex = one(db, "SELECT unit_id FROM study_units WHERE project_id=? AND session=? AND seq=? AND source='imported_transcript'", ctx.project_id, r.session, seq);
      const text = redact(String(r.text));
      if (ex) { if (mode === 'append') { skipped++; continue; } run(db, 'UPDATE study_units SET speaker=?, speaker_role=?, grp=?, time=?, text=?, participant_code=? WHERE unit_id=?', r.speaker || null, r.speaker_role || null, r.grp || null, r.time || null, text, r.participant_code || null, ex.unit_id); updated++; }
      else { run(db, 'INSERT INTO study_units(unit_id,project_id,owner_id,source,session,seq,speaker,speaker_role,grp,time,text,event_id,run_id,stage,participant_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id('unit'), ctx.project_id, user.user_id, 'imported_transcript', r.session, seq, r.speaker || null, r.speaker_role || null, r.grp || null, r.time || null, text, null, null, null, r.participant_code || null, now()); inserted++; }
    }
  }
  else if (ds.name === 'codings') {
    const cb = getCodebook(db, user, ctx.codebook_id);
    for (const r of records) {
      const u = r.unit_id ? one(db, 'SELECT unit_id FROM study_units WHERE unit_id=? AND project_id=?', r.unit_id, cb.project_id) : one(db, 'SELECT unit_id FROM study_units WHERE project_id=? AND session=? AND seq=?', cb.project_id, r.session, r.seq);
      if (!u) { skipped++; continue; }
      if (mode === 'append' && one(db, 'SELECT 1 FROM study_codings WHERE codebook_id=? AND unit_id=? AND coder=?', cb.codebook_id, u.unit_id, r.coder)) { skipped++; continue; }
      setCoding(db, user, { codebook_id: cb.codebook_id, unit_id: u.unit_id, coder: r.coder, codes: r.code }); inserted++;
    }
  }
  else if (ds.name === 'ratings') {
    const SPECIAL = { 未评: 'not_rated', 不适用: 'not_applicable', 证据不足: 'insufficient_evidence', not_rated: 'not_rated', not_applicable: 'not_applicable', insufficient_evidence: 'insufficient_evidence' };
    for (const r of records) {
      const scores = {}; for (const [k, v] of Object.entries(r)) if (k.startsWith('dim:') && v != null && v !== '') scores[k.slice(4)] = SPECIAL[v] || (/^\d+$/.test(v) ? Number(v) : v);
      research.rate(db, user, { rubric_id: ctx.rubric_id, target_type: r.target_type || 'event', target_id: r.target_id, rater_code: r.rater_code, scores, note: r.note }); inserted++;
    }
  }
  return { inserted, updated, skipped };
}

/** Rows for export (field keys). Withdrawn / non-consented participants' data are excluded unless include_all. */
function exportRows(db, user, ds, ctx, { include_all = false } = {}) {
  if (ds.name === 'participants') return participants(db, ctx.project_id).filter((p) => include_all || p.consent === 'consented');
  if (ds.name === 'scale_items' || ds.name === 'test_items') return items(db, ctx.instrument_id).map((x) => ({ ...x, reverse: !!x.reverse }));
  if (ds.name === 'responses') {
    const inst = getInstrument(db, user, ctx.instrument_id); const ok = include_all ? null : eligibleCodes(db, inst.project_id);
    const by = new Map();
    for (const r of all(db, 'SELECT * FROM study_responses WHERE instrument_id=? ORDER BY participant_code, timepoint', inst.instrument_id)) {
      if (ok && !ok.has(r.participant_code)) continue;
      const k = `${r.participant_code}|${r.timepoint}`; if (!by.has(k)) by.set(k, { participant_code: r.participant_code, timepoint: r.timepoint, collected_at: r.collected_at || '' });
      by.get(k)[`item:${r.item_code}`] = inst.kind === 'scale' ? Number(r.value) : r.value;
    }
    return [...by.values()];
  }
  if (ds.name === 'codes') return codes(db, ctx.codebook_id);
  if (ds.name === 'units') return all(db, 'SELECT * FROM study_units WHERE project_id=? ORDER BY session, seq', ctx.project_id);
  if (ds.name === 'codings') { const cb = getCodebook(db, user, ctx.codebook_id); return all(db, 'SELECT c.unit_id, u.session, u.seq, c.coder, c.code FROM study_codings c JOIN study_units u ON u.unit_id=c.unit_id WHERE c.codebook_id=? ORDER BY u.session, u.seq, c.coder', cb.codebook_id); }
  if (ds.name === 'ratings') return research.listRatings(db, user, {}).filter((r) => r.rubric_id === ctx.rubric_id).map((r) => ({ target_type: r.target_type, target_id: r.target_id, rater_code: r.rater_code, note: r.note, ...Object.fromEntries(Object.entries(r.scores).map(([k, v]) => [`dim:${k}`, v])) }));
  if (ds.name === 'artifact_section') { const a = rowToArtifact(getOwned(db, user, ctx.artifact_id)); return a.body.sections.find((s) => s.key === ctx.section_key).rows; }
  return [];
}
const displayValue = (f, v) => (v == null ? '' : f.type === 'enum' && f.options?.[v] ? f.options[v][0] || v : f.type === 'bool' ? (v ? '是' : '否') : Array.isArray(v) ? v.join('；') : v);

/** Export one dataset. format: csv (keys header) | xlsx (label header + 字段说明) | json | sps (zip: csv + SPSS syntax) | template. */
export function exportDataset(db, user, name, rawCtx, format = 'xlsx', opts = {}) {
  const ctx = ctxOf(rawCtx); const ds = dataset(db, user, name, ctx);
  const f = ds.fieldList;
  const base = `${ds.label.replace(/[（）()：:\s/]/g, '_')}`;
  if (format === 'template') return { buf: templateXlsx(ds.label, f), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `导入模板_${base}.xlsx` };
  const rows = exportRows(db, user, ds, ctx, opts);
  audit(db, { actor: user, action: 'dataset_exported', target_type: 'dataset', target_id: name, detail: { format, rows: rows.length } });
  if (format === 'json') return { buf: Buffer.from(JSON.stringify({ dataset: name, label: ds.label, exported_at: now(), fields: f.map(({ key, label, type }) => ({ key, label, type })), rows }, null, 2)), type: 'application/json; charset=utf-8', filename: `${base}.json` };
  if (format === 'csv') return { buf: Buffer.from(toCsv(rows, f.map((x) => x.key), f.map((x) => csvKey(x))), 'utf8'), type: 'text/csv; charset=utf-8', filename: `${base}.csv` };
  if (format === 'sps') {
    const used = new Set(); const vars = f.map((x) => ({ ...x, key: spssName(csvKey(x), used) }));
    const csvText = toCsv(rows, f.map((x) => x.key), vars.map((v) => v.key));
    return { buf: zip([{ name: 'data.csv', data: csvText }, { name: 'data.sps', data: spssSyntax('data.csv', vars, { title: ds.label }) }, { name: 'README.txt', data: `${ds.label}\n在 SPSS 中打开 data.sps，把 FILE= 改为 data.csv 的完整路径后运行。编码：UTF-8。\n` }]), type: 'application/zip', filename: `${base}_SPSS.zip` };
  }
  return { buf: toXlsx([{ name: '数据', header: f.map((x) => x.label), rows: rows.map((r) => f.map((x) => displayValue(x, r[x.key]))) }, { name: '字段说明', header: ['列名', '字段键', '类型', '说明'], rows: f.map((x) => [x.label, x.key, TYPE_LABEL[x.type] || x.type, x.help || '']) }]), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${base}.xlsx` };
}
const csvKey = (f) => (f.item ? f.item : f.dim ? f.dim : f.key);

// ---------- project package ----------
export function projectPackage(db, user, pid, { include_text = false, include_platform = true } = {}) {
  const v = projectView(db, user, pid); const p = v.project; const out = {};
  const sha = (s) => createHash('sha256').update(Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8')).digest('hex');
  const put = (name, fields, rows) => { out[name] = toCsv(rows, fields.map((f) => f.key), fields.map((f) => csvKey(f))); };
  const ok = eligibleCodes(db, pid);
  put('participants.csv', P_FIELDS.filter((f) => f.key !== 'note'), participants(db, pid).filter((x) => x.consent === 'consented'));
  const instRows = [], itemRows = [], longRows = [];
  for (const i of v.instruments) {
    instRows.push({ instrument_code: i.code, kind: i.kind, name: i.name, source_status: i.body.source_status, citation: i.body.citation, scale_min: i.body.scale?.[0] ?? '', scale_max: i.body.scale?.[1] ?? '', n_items: i.n_items, n_placeholders: i.n_placeholders });
    for (const it of items(db, i.instrument_id)) itemRows.push({ instrument_code: i.code, item_code: it.code, seq: it.seq, dimension: it.dimension, text: it.text, reverse: it.reverse ? 1 : 0, qtype: it.qtype, answer: it.answer, points: it.points, knowledge_point: it.knowledge_point, cognitive_level: it.cognitive_level, placeholder: it.placeholder });
    for (const r of all(db, 'SELECT * FROM study_responses WHERE instrument_id=? ORDER BY participant_code, timepoint, item_code', i.instrument_id)) if (ok.has(r.participant_code)) longRows.push({ instrument_code: i.code, participant_code: r.participant_code, timepoint: r.timepoint, item_code: r.item_code, value: r.value, score: r.score, collected_at: r.collected_at });
    const e = exportDataset(db, user, 'responses', { instrument_id: i.instrument_id }, 'sps');
    const wide = unzipText(e.buf);
    out[`responses_wide_${i.code}.csv`] = wide['data.csv']; out[`responses_wide_${i.code}.sps`] = wide['data.sps'].replace("'data.csv'", `'responses_wide_${i.code}.csv'`);
    if (i.n_responses) out[`analysis_${i.code}.json`] = JSON.stringify(analyzeInstrument(db, user, i.instrument_id), null, 2);
  }
  out['instruments.csv'] = toCsv(instRows, ['instrument_code', 'kind', 'name', 'source_status', 'citation', 'scale_min', 'scale_max', 'n_items', 'n_placeholders']);
  out['items.csv'] = toCsv(itemRows, ['instrument_code', 'item_code', 'seq', 'dimension', 'text', 'reverse', 'qtype', 'answer', 'points', 'knowledge_point', 'cognitive_level', 'placeholder']);
  out['responses_long.csv'] = toCsv(longRows, ['instrument_code', 'participant_code', 'timepoint', 'item_code', 'value', 'score', 'collected_at']);
  const units = all(db, 'SELECT * FROM study_units WHERE project_id=? ORDER BY session, seq', pid).filter((u) => !u.participant_code || ok.has(u.participant_code) || u.source === 'platform_event');
  out['units.csv'] = toCsv(units.map((u) => ({ ...u, is_simulated: u.source === 'platform_event', text: include_text ? u.text : '[省略]' })), ['unit_id', 'source', 'is_simulated', 'session', 'seq', 'speaker', 'speaker_role', 'grp', 'time', 'stage', 'participant_code', 'run_id', 'event_id', 'text']);
  const unitSet = new Set(units.map((u) => u.unit_id));
  for (const cb of v.codebooks) {
    out[`codebook_${cb.name}.csv`] = toCsv(codes(db, cb.codebook_id), CODE_FIELDS.map((f) => f.key));
    out[`codings_${cb.name}.csv`] = toCsv(all(db, 'SELECT c.unit_id, u.session, u.seq, c.coder, c.code FROM study_codings c JOIN study_units u ON u.unit_id=c.unit_id WHERE c.codebook_id=? ORDER BY u.session, u.seq', cb.codebook_id).filter((r) => unitSet.has(r.unit_id)), ['unit_id', 'session', 'seq', 'coder', 'code']);
    if (cb.coders.length) {
      const sq = sequenceData(db, user, cb.codebook_id);
      out[`ena_${cb.name}.csv`] = toCsv(sq.ena, ['session', 'source', 'seq', 'speaker', 'speaker_role', 'group', 'stage', ...sq.codes.map((c) => c.code)]);
      out[`lag_sequential_${cb.name}.csv`] = toCsv(sq.lag.cells, ['from', 'to', 'observed', 'expected', 'z']);
      out[`irr_${cb.name}.json`] = JSON.stringify(codingIrr(db, user, cb.codebook_id), null, 2);
    }
  }
  if (include_platform && p.body.run_ids?.length) {
    const pk = research.buildPackage(db, user, { run_ids: p.body.run_ids, package: 'shared' });
    for (const [name, { rows, cols }] of Object.entries(pk.files)) out[`platform/${name}`] = research.csv(rows, cols);
  }
  out['project.json'] = JSON.stringify({ code: p.code, title: p.title, status: p.status, ...p.body, run_ids: undefined, linked_runs: p.body.run_ids?.length || 0 }, null, 2);
  out['README.md'] = packageReadme(v, include_text);
  out['data-dictionary.md'] = STUDY_DICTIONARY;
  out['analysis.R'] = R_SCRIPT;
  const manifest = { app_version: research.APP_VERSION, schema_version: research.SCHEMA_VERSION, exported_at: now(), project: p.code, excluded: 'withdrawn / declined / pending participants and their data', files: Object.entries(out).map(([name, c]) => ({ name, bytes: Buffer.byteLength(c), sha256: sha(c) })) };
  out['manifest.json'] = JSON.stringify(manifest, null, 2);
  audit(db, { actor: user, action: 'study_package_exported', target_type: 'study_project', target_id: pid, detail: { files: Object.keys(out).length, include_text } });
  return zip(Object.entries(out).map(([name, data]) => ({ name: `${p.code}/${name}`, data })));
}
function unzipText(buf) { return Object.fromEntries(Object.entries(unzipSync(buf)).map(([k, v]) => [k, v.toString('utf8')])); }

function packageReadme(v, includeText) {
  const p = v.project, b = p.body, f = v.flow;
  return `# ${p.title}（${p.code}）研究数据包

- 研究领域：${b.field}；研究设计：${DESIGNS[b.design]}；分析单位：${b.unit_of_analysis || '未填写'}
- 研究问题：${(b.rqs || []).map((q, i) => `\n  - RQ${i + 1}：${q}`).join('') || '未填写'}
- 组别：${(b.conditions || []).map((c) => `${c.code}=${c.label}`).join('；') || '未设置'}；时间点：${(b.timepoints || []).map((t) => `${t.code}=${t.label}${t.date ? `(${t.date})` : ''}`).join('；') || '未设置'}
- 伦理：${b.ethics?.number ? `${b.ethics.body} 批准号 ${b.ethics.number}（${b.ethics.date || '日期未填'}）` : b.ethics?.exempt_reason ? `豁免：${b.ethics.exempt_reason}` : '未填写'}；知情同意书版本：${b.ethics?.consent_version || '未填写'}

## 被试流程（可用于流程图）

登记 ${f.registered} → 已同意 ${f.consented}（拒绝 ${f.declined}、待确认 ${f.pending}、退出 ${f.withdrawn}）
${(f.by_condition || []).map((c) => `- ${c.label}（${c.code}）：${c.n}`).join('\n')}
- 已同意但未分组：${f.unassigned}

**只有“已同意”的被试及其数据进入本包**；拒绝、待确认、已退出者的作答与话语不导出。

## 文件

- participants.csv：被试（研究编码，无姓名学号）
- instruments.csv / items.csv：测量工具与题项（source_status：validated 原版 / adapted 改编 / self_developed 自编 / placeholder 结构模板）
- responses_long.csv：长表作答（value 原始作答；score 计分，量表反向题已反转，测试按答案键计分）
- responses_wide_*.csv + .sps：宽表 + SPSS 读取语法；analysis.R：R 读取与信度示例脚本
- analysis_*.json：平台计算的描述统计、Cronbach α、题目分析（仅描述性，推断统计请在 SPSS/R 中完成）
- units.csv：话语单元（is_simulated=true 的来自平台智能体模拟，不是真实课堂证据）${includeText ? '' : '；正文已省略'}
- codebook_* / codings_* / irr_* / ena_* / lag_sequential_*：编码表、编码结果、编码者一致性、ENA 格式、滞后序列转移
${b.run_ids?.length ? '- platform/：关联的平台运行过程数据（共享包口径，假名化，无自由文本）\n' : ''}
## 边界

- 平台不生成、不补齐任何研究数据；空表即未采集。
- 模拟智能体数据只能用于研究“平台 / 模拟过程本身”，不能作为真实学生的学习证据。
- 量表若为 placeholder 或 self_developed，正式发表前需报告编制过程与信效度证据。
${b.ai_disclosure ? `\n## AI 使用声明\n\n${b.ai_disclosure}\n` : ''}${b.data_availability ? `\n## 数据可得性\n\n${b.data_availability}\n` : ''}`;
}

const STUDY_DICTIONARY = `# 科研数据字典

| 文件 | 字段 | 含义 |
|---|---|---|
| participants | code / condition / cohort / grp | 研究编码、组别编码、班级批次、小组 |
| participants | consent / consent_date | 知情同意状态（只导出 consented）与日期 |
| items | reverse | 1 = 反向计分：score = 最小值 + 最大值 − 原始值 |
| items | qtype / answer / points | 题型、答案键、分值；主观题 score 为教师给分 |
| responses_long | value / score | 原始作答 / 计分结果；缺失为空，不以 0 代替 |
| units | source / is_simulated | imported_transcript 真实转录；platform_event 平台模拟 |
| codings | coder | 编码者假名；每位编码者独立编码 |
| ena_* | 代码列 | 1 = 该单元出现该代码（多位编码者时取多数一致） |
| lag_sequential_* | z | 调整残差（Bakeman & Quera, 2011），|z|>1.96 常作显著参考 |
| analysis_* | alpha / citc / alpha_if_deleted | Cronbach α、校正题总相关、删除该题后 α |
| analysis_* | difficulty_p / discrimination_d / corrected_r | 难度、区分度（27% 高低分组）、校正题总相关 |
`;

const R_SCRIPT = `# 研思智境导出数据的 R 读取示例（需要 psych、irr 包：install.packages(c("psych","irr"))）
library(psych)
long <- read.csv("responses_long.csv", fileEncoding = "UTF-8-BOM")
items <- read.csv("items.csv", fileEncoding = "UTF-8-BOM")
parts <- read.csv("participants.csv", fileEncoding = "UTF-8-BOM")
# 宽表：每个被试×时间点一行，题项为列（score 已处理反向题）
wide <- reshape(long[, c("instrument_code","participant_code","timepoint","item_code","score")],
                idvar = c("instrument_code","participant_code","timepoint"), timevar = "item_code", direction = "wide")
# 示例：某量表某维度的 α（请替换量表编码与维度）
# dim_items <- paste0("score.", items$item_code[items$instrument_code == "TPACK" & items$dimension == "TK"])
# psych::alpha(wide[wide$instrument_code == "TPACK" & wide$timepoint == "T0", dim_items])
# 组间与前后测比较、多层模型等推断统计请按研究设计在此处编写并报告效应量与置信区间。
`;
