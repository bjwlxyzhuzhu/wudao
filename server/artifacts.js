// Artifact versions, structural validation, current-artifact pointers and module transfers.
import { one, all, run, id, now, tx, check, fail, audit, json } from './db.js';
import { getTemplate, PDCA_SECTION, COURSE_FIELDS } from './templates.js';
import { safeKnowledge, kpsIn } from './knowledge.js';

export const MODULES = ['seminar', 'classroom'];
const MODULE_NAME = { seminar: '研课场', classroom: '演课场' };

/** Section definitions for a type given the framework choice (PDCA adds/replaces sections). */
export function sectionDefs(db, type, frameworkKey, withPdca) {
  const t = getTemplate(db, 'artifact', type);
  check(t, 400, 'bad_type', '未知产物类型');
  let defs = t.body.sections.map((s) => ({ ...s }));
  const fw = frameworkKey ? getTemplate(db, 'framework', frameworkKey) : null;
  if (fw && fw.body.scope === 'cycle') {
    // PDCA as the main framework: the design is an improvement cycle, not a six-step lesson.
    defs = defs.filter((s) => !s.framework_stages);
    defs.push({ ...PDCA_SECTION, title: 'PDCA 改进循环（主框架）' });
  } else if (withPdca) defs.push({ ...PDCA_SECTION });
  return { defs, template: t, framework: fw };
}

export function emptyBody(db, { type, framework_key, with_pdca, course = {}, framework_fields = {} }) {
  const { defs, template, framework } = sectionDefs(db, type, framework_key, with_pdca);
  return {
    course: cleanCourse(course),
    framework: framework ? { key: framework_key, version: framework.version, name: framework.body.name, scope: framework.body.scope, steps: framework.body.steps, fields: framework_fields } : null,
    with_pdca: !!with_pdca,
    template: { key: type, version: template.version },
    sections: defs.map((d) => ({ key: d.key, title: d.title, kind: d.kind, owner_role: d.owner || null, author: null, revision: 0,
      columns: d.columns || null, framework_stages: !!d.framework_stages, content: d.kind === 'text' ? '' : undefined, rows: d.kind === 'table' ? [] : undefined })),
    current_unit: null,
    ai_assisted: false,
    notice: '',
  };
}

export function cleanCourse(c = {}) {
  const out = {};
  for (const [k, , , t] of COURSE_FIELDS) {
    const v = c[k];
    if (v == null || v === '') continue;
    out[k] = t === 'number' ? (Number.isFinite(Number(v)) ? Number(v) : null) : String(v).slice(0, 4000);
  }
  return out;
}

const refs = (s) => String(s || '').split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean);
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

/** Structural checks per type. Returns [{level:'error'|'warn', section, message}]. */
export function validateBody(type, body, ctx = {}) {
  const out = [], sec = (k) => body.sections.find((s) => s.key === k);
  const warn = (section, message) => out.push({ level: 'warn', section, message });
  const err = (section, message) => out.push({ level: 'error', section, message });
  const goals = sec('goals')?.rows || [];
  const goalIds = new Set(goals.map((g) => String(g.id || '').trim()).filter(Boolean));
  const checkRefs = (section, rows) => rows.forEach((r, i) => refs(r.goal_refs).forEach((g) => { if (goalIds.size && !goalIds.has(g)) err(section, `第 ${i + 1} 行引用了不存在的目标「${g}」`); }));
  const coverage = (section, rows, label) => { const used = new Set(rows.flatMap((r) => refs(r.goal_refs))); for (const g of goalIds) if (!used.has(g)) warn(section, `目标 ${g} 未被任何${label}覆盖`); };
  const c = body.course || {};
  // 目标须可观察、可评价：只用“了解/理解/掌握”等内隐动词、没有外显行为时提示（布卢姆修订版动词）
  const VAGUE = /了解|理解|掌握|知道|熟悉|领会|懂得|认识到|体会|感悟|树立|增强|提高/, OBSERVABLE = /能|会|说出|写出|列举|复述|计算|判断|判定|设计|分析|比较|解释|完成|制定|评价|绘制|编写|测量|检测|选择|区分|辨析|论证|提出|操作|演示|撰写|归纳|举例|说明|运用|应用|给出/;
  goals.forEach((g) => { const d = String(g.description || '').replace(/【待教师补充[^】]*】/g, '').trim(); if (d.length >= 4 && VAGUE.test(d) && !OBSERVABLE.test(d)) warn('goals', `目标 ${g.id || ''}“${d.slice(0, 18)}”只用了内隐动词，难以观察和评价，建议改为“能……”的外显行为（如：能判断、能计算、能说明理由）`); });
  if (goals.length) {
    const cats = new Set(goals.map((g) => g.category));
    for (const k of ['知识', '能力', '价值']) if (['syllabus', 'lesson_plan'].includes(type) && !cats.has(k)) warn('goals', `缺少${k}目标`);
  }
  for (const s of body.sections) if (s.kind === 'table') s.rows.forEach((r, i) => {
    if ('source' in r && (r.case || r.title || r.element) && !String(r.source || '').trim()) warn(s.key, `第 ${i + 1} 行缺少来源，应标注“待核查”`);
  });
  if (type === 'syllabus') {
    const rows = sec('content')?.rows || [];
    const sum = rows.reduce((a, r) => a + (num(r.hours) || 0), 0);
    if (rows.some((r) => num(r.hours) == null)) err('content', '有单元未填写学时');
    if (num(c.hours) != null && sum !== num(c.hours)) err('content', `内容学时合计 ${sum}，与总学时 ${c.hours} 不一致`);
    checkRefs('content', rows); coverage('content', rows, '内容单元');
    const asm = sec('assessment')?.rows || [];
    const w = asm.reduce((a, r) => a + (num(r.weight) || 0), 0);
    if (asm.length && w !== 100) err('assessment', `考核权重合计 ${w}%，应为 100%`);
    checkRefs('assessment', asm); coverage('assessment', asm, '考核项');
  }
  if (type === 'semester_plan') {
    const rows = sec('weeks')?.rows || [];
    const weeks = rows.map((r) => num(r.week));
    if (weeks.some((w) => w == null)) err('weeks', '有行未填写周次');
    if (new Set(weeks).size !== weeks.length) err('weeks', '周次重复');
    if (num(c.weeks) != null && weeks.some((w) => w > num(c.weeks) || w < 1)) err('weeks', `周次超出 1—${c.weeks}`);
    const sum = rows.reduce((a, r) => a + (num(r.hours) || 0), 0);
    if (num(c.hours) != null && sum !== num(c.hours)) err('weeks', `学时合计 ${sum}，与总学时 ${c.hours} 不一致`);
    checkRefs('weeks', rows); coverage('weeks', rows, '周次');
  }
  if (type === 'lesson_plan' && sec('stages')) {
    const rows = sec('stages').rows;
    const sum = rows.reduce((a, r) => a + (num(r.minutes) || 0), 0);
    if (num(c.lesson_minutes) != null && sum !== num(c.lesson_minutes)) err('stages', `阶段时间合计 ${sum} 分钟，与单次课时长 ${c.lesson_minutes} 不一致`);
    const steps = body.framework?.steps || [];
    const used = new Set(rows.map((r) => r.stage));
    for (const [k, label] of steps) if (!used.has(k) && !used.has(label)) warn('stages', `框架阶段「${label}」未安排`);
    if (body.framework?.key === 'boppps') for (const k of ['pre_assessment', 'post_assessment']) {
      const r = rows.find((x) => x.stage === k || x.stage === (k === 'pre_assessment' ? '前测' : '后测'));
      if (r && !refs(r.goal_refs).length) err('stages', `BOPPPS 的${k === 'pre_assessment' ? '前测' : '后测'}必须关联教学目标`);
    }
    checkRefs('stages', rows); coverage('stages', rows, '教学阶段');
  }
  if (type === 'exercises') {
    const rows = sec('items')?.rows || [];
    rows.forEach((r, i) => { if (!String(r.answer || '').trim()) warn('items', `第 ${i + 1} 题缺少参考答案`); });
    checkRefs('items', rows); coverage('items', rows, '题目');
  }
  if (type === 'exam') {
    const rows = sec('questions')?.rows || [];
    const total = num(c.exam_total) ?? 100;
    const sum = rows.reduce((a, r) => a + (num(r.score) || 0), 0);
    if (rows.some((r) => num(r.score) == null)) err('questions', '有题目未填写分值');
    if (sum !== total) err('questions', `分值合计 ${sum}，与试卷总分 ${total} 不一致`);
    rows.forEach((r, i) => { if (['简答', '案例分析', '实践任务'].includes(r.qtype) && !String(r.rubric || '').trim()) warn('questions', `第 ${i + 1} 题（${r.qtype}）缺少评分标准`); });
    checkRefs('questions', rows); coverage('questions', rows, '题目');
  }
  if (type === 'course_design') {
    const rows = sec('units')?.rows || [];
    const sum = rows.reduce((a, r) => a + (num(r.hours) || 0), 0);
    if (num(c.hours) != null && rows.length && sum !== num(c.hours)) err('units', `单元学时合计 ${sum}，与总学时 ${c.hours} 不一致`);
    checkRefs('units', rows); coverage('units', rows, '教学单元');
    const asm = sec('assessment')?.rows || [];
    const w = asm.reduce((a, r) => a + (num(r.weight) || 0), 0);
    if (asm.length && w !== 100) err('assessment', `考核权重合计 ${w}%，应为 100%`);
    checkRefs('assessment', asm); coverage('assessment', asm, '考核项');
  }
  if (type === 'teaching_schedule') {
    const rows = sec('rows')?.rows || [];
    if (rows.some((r) => num(r.week) == null)) err('rows', '有行未填写周次');
    if (num(c.weeks) != null && rows.some((r) => num(r.week) > num(c.weeks) || num(r.week) < 1)) err('rows', `周次超出 1—${c.weeks}`);
    const sum = rows.reduce((a, r) => a + (num(r.hours) || 0), 0);
    if (num(c.hours) != null && rows.length && sum !== num(c.hours)) err('rows', `学时合计 ${sum}，与总学时 ${c.hours} 不一致`);
    const withIdeo = rows.filter((r) => String(r.ideology || '').trim()).length;
    if (rows.length >= 4 && withIdeo < Math.ceil(rows.length / 4)) warn('rows', `仅 ${withIdeo}/${rows.length} 次课标注思政融入点，建议按单元有计划地分布`);
  }
  if (type === 'talent_plan') {
    const gm = sec('goals_map')?.rows || [];
    gm.forEach((r, i) => { if (r.goal && !String(r.evidence || '').trim()) warn('goals_map', `第 ${i + 1} 条培养目标缺少“达成证据”，思政目标需可观察、可评价`); });
    const rq = sec('requirements')?.rows || [];
    if (rq.length && !rq.some((r) => r.level === 'H')) warn('requirements', '没有任何课程对思政相关毕业要求形成强支撑（H）');
  }
  // 课程思政质量：避免只贴口号——融入点须结合具体专业情境
  for (const s of body.sections) if (s.kind === 'table' && type !== 'classroom_feedback') s.rows.forEach((r, i) => {
    for (const k of ['ideology_point', 'ideology', 'focus', 'approach']) {
      if (s.columns?.find((c) => c.key === k)?.type === 'number') continue;
      const v = String(r[k] || '').replace(/【待教师补充】/g, '').trim();
      if (!v) continue;
      const stripped = v.replace(/[、，,。；;！!\s]|的|和|与|及|精神|意识|情怀|素养|责任|担当|爱国|敬业|诚信|法治|创新|工匠|奉献|价值观|家国|使命|职业道德|工程|公共|安全|质量/g, '');
      if (v.length < 8 || stripped.length < 3) warn(s.key, `第 ${i + 1} 行思政融入点“${v.slice(0, 16)}”偏口号化，建议写明结合的专业情境、学生任务或价值冲突`);
    }
  });
  if (type === 'reflection_report' && ctx.eventExists) {
    (sec('observed')?.rows || []).forEach((r, i) => { if (r.event_id && !ctx.eventExists(r.event_id)) err('observed', `第 ${i + 1} 行事件ID「${r.event_id}」不存在或不属于你`); });
  }
  if (body.framework?.fields) {
    const fw = body.framework;
    const need = { pjbl: 'driving_question', problem_based: 'real_problem', flipped: 'pre_class_materials', pdca: 'improvement_target' }[fw.key];
    if (need && !String(fw.fields[need] || '').trim()) err('framework', `所选框架要求填写「${need}」`);
  }
  return out;
}

/** Two-way target—content—assessment matrix for syllabus and blueprint for exams (computed, not stored). */
export function ideologyCheck(body, issues = []) {
  const IDEO = ['ideology_point', 'ideology', 'focus', 'approach', 'element'];
  let rows = 0, withIdeo = 0;
  for (const s of body.sections) {
    const keys = s.kind === 'table' ? (s.columns || []).filter((c) => IDEO.includes(c.key) && c.type !== 'number').map((c) => c.key) : [];
    if (!keys.length) continue;
    for (const r of s.rows) { rows++; if (keys.some((k) => String(r[k] || '').replace(/【待教师补充[^】]*】/g, '').trim())) withIdeo++; }
  }
  const goals = body.sections.find((s) => s.key === 'goals')?.rows || [];
  const valueGoals = goals.filter((g) => g.category === '价值').map((g) => String(g.id || '').trim()).filter(Boolean);
  const used = new Set(body.sections.flatMap((s) => (s.kind === 'table' ? s.rows.flatMap((r) => String(r.goal_refs || '').split(/[,，、;；\s]+/)) : [])));
  const texts = body.sections.map((s) => (s.kind === 'text' ? s.content : JSON.stringify(s.rows || []))).join(' ');
  // 贴标签检查（启发式）：过度嵌入、同质化重复、与所在行的专业内容没有交集
  const PROF = ['content', 'unit', 'chapter', 'teacher_activity', 'student_activity', 'case', 'professional_link', 'term', 'explanation', 'task', 'activity', 'topic'];
  const GENERIC = /[的和与及在中对把让使将了、，,。；;：:！!？?\s“”「」（）()]|学生|教师|任务|情境|要求|给出|依据|理由|示例|表述|请结合|实际|修改|相冲突|进度|成本|工程|责任|意识|精神|培养|引导|体会|树立|增强|提升/g;
  const ideoTexts = [], detachedRows = [];
  for (const s of body.sections) {
    if (s.kind !== 'table') continue;
    const keys = (s.columns || []).filter((c) => IDEO.includes(c.key) && c.type !== 'number').map((c) => c.key);
    const profKeys = (s.columns || []).filter((c) => PROF.includes(c.key)).map((c) => c.key);
    s.rows.forEach((r, i) => {
      const v = keys.map((k) => String(r[k] || '').replace(/【待教师补充[^】]*】/g, '').trim()).filter(Boolean).join(' ');
      if (!v) return;
      ideoTexts.push(v.replace(/[「」“”].*?[」”]/g, '').replace(/\s+/g, ''));
      const prof = profKeys.map((k) => String(r[k] || '')).join(' ').replace(GENERIC, '');
      if (!prof) return;
      const core = v.replace(GENERIC, '');
      let hit = false; for (let j = 0; j + 1 < core.length && !hit; j++) if (prof.includes(core.slice(j, j + 2))) hit = true;
      if (!hit) detachedRows.push(`${s.title}第 ${i + 1} 行`);
    });
  }
  const freq = ideoTexts.reduce((m, x) => ((m[x] = (m[x] || 0) + 1), m), {});
  const repeated = Object.values(freq).filter((n) => n >= 2).reduce((a, n) => a + n, 0);
  const ratio = rows ? withIdeo / rows : 0;
  return { rows_total: rows, rows_with_ideology: withIdeo, embedding: !rows ? 'none' : ratio < 0.25 ? 'under' : ratio > 0.8 && rows >= 5 ? 'over' : 'balanced',
    repeated_rows: repeated, detached_rows: detachedRows.slice(0, 10), n_detached: detachedRows.length, slogan_like: issues.filter((i) => /口号化/.test(i.message)).length,
    value_goals: valueGoals.length, value_goals_linked: valueGoals.filter((g) => used.has(g)).length,
    ideology_text_filled: body.sections.some((s) => s.kind === 'text' && /ideology|思政/.test(`${s.key}${s.title}`) && String(s.content || '').replace(/【待教师补充[^】]*】/g, '').trim().length >= 10),
    pending_sources: (texts.match(/待核查/g) || []).length, cites_materials: /上传材料《|教师上传材料/.test(texts) };
}

export function derivedViews(type, body) {
  const sec = (k) => body.sections.find((s) => s.key === k);
  const goals = sec('goals')?.rows || [];
  if (type === 'syllabus') {
    const content = sec('content')?.rows || [], asm = sec('assessment')?.rows || [];
    return { matrix: goals.map((g) => ({ goal: g.id, category: g.category, content: content.filter((r) => refs(r.goal_refs).includes(g.id)).map((r) => r.unit), assessment: asm.filter((r) => refs(r.goal_refs).includes(g.id)).map((r) => r.item) })) };
  }
  if (type === 'course_design') {
    const content = sec('units')?.rows || [], asm = sec('assessment')?.rows || [];
    return { matrix: goals.map((g) => ({ goal: g.id, category: g.category, content: content.filter((r) => refs(r.goal_refs).includes(g.id)).map((r) => r.unit), assessment: asm.filter((r) => refs(r.goal_refs).includes(g.id)).map((r) => r.item) })) };
  }
  if (type === 'lesson_plan' && sec('stages')) {
    // 目标—活动—评价一致性：每个目标由哪些阶段支撑、在哪些阶段被评价
    const st = sec('stages').rows, label = (k) => (body.framework?.steps || []).find(([x]) => x === k)?.[1] || k;
    return { alignment: goals.map((g) => ({ goal: g.id, category: g.category, activities: st.filter((r) => refs(r.goal_refs).includes(g.id)).map((r) => label(r.stage)), assessed_in: st.filter((r) => refs(r.goal_refs).includes(g.id) && String(r.assessment || '').trim()).map((r) => label(r.stage)) })) };
  }
  if (type === 'exam') {
    const qs = sec('questions')?.rows || [];
    const types = [...new Set(qs.map((q) => q.qtype || '未分类'))];
    return { blueprint: { types, rows: goals.map((g) => ({ goal: g.id, cells: types.map((t) => qs.filter((q) => (q.qtype || '未分类') === t && refs(q.goal_refs).includes(g.id)).reduce((a, q) => a + (num(q.score) || 0), 0)) })) } };
  }
  return {};
}

// ---- persistence ----
export function rowToArtifact(r, withBody = true) {
  if (!r) return null;
  const a = { artifact_id: r.artifact_id, lineage_id: r.lineage_id, module: r.module, type: r.type, title: r.title, status: r.status, version: r.version,
    parent_id: r.parent_id, source_run_id: r.source_run_id, origin: r.origin, framework_key: r.framework_key, framework_version: r.framework_version,
    template_version: r.template_version, reviewed_by_teacher: !!r.reviewed_by_teacher, created_at: r.created_at, updated_at: r.updated_at, saved_at: r.saved_at };
  if (withBody) a.body = json(r.body);
  return a;
}
export function getOwned(db, user, artifactId) {
  const r = one(db, 'SELECT * FROM artifacts WHERE artifact_id=?', artifactId);
  if (!r || r.owner_id !== user.user_id) fail(404, 'not_found', '产物不存在或无权访问');
  return r;
}

function sanitizeBody(db, type, body, prev) {
  check(body && Array.isArray(body.sections), 400, 'bad_body', '产物结构无效');
  const base = prev || body;
  // Keep section structure from the template; accept only content/rows/author edits.
  const sections = base.sections.map((s) => {
    const incoming = body.sections.find((x) => x.key === s.key) || s;
    const out = { ...s, author: incoming.author ?? s.author ?? null };
    if (s.kind === 'text') out.content = String(incoming.content ?? '').slice(0, 20000);
    else {
      const keys = (s.columns || []).map((c) => c.key);
      check(Array.isArray(incoming.rows) && incoming.rows.length <= 300, 400, 'bad_rows', `「${s.title}」行数过多或格式无效`);
      out.rows = incoming.rows.map((row) => Object.fromEntries(keys.map((k) => [k, row?.[k] == null ? '' : String(row[k]).slice(0, 5000)])));
    }
    return out;
  });
  const fwFields = {};
  if (base.framework) for (const [k, v] of Object.entries(body.framework?.fields || base.framework.fields || {})) fwFields[k] = String(v ?? '').slice(0, 2000);
  return { ...base, course: cleanCourse(body.course || base.course), framework: base.framework ? { ...base.framework, fields: fwFields } : null,
    sections, current_unit: body.current_unit ?? base.current_unit ?? null, ai_assisted: !!(base.ai_assisted || body.ai_assisted), notice: String(body.notice ?? base.notice ?? '').slice(0, 1000) };
}

export function createArtifact(db, user, { module, type, title, body, framework_key, with_pdca, course, framework_fields, parent_id = null, source_run_id = null, origin = 'teacher_authored', status = 'draft', lineage_id }) {
  check(MODULES.includes(module), 400, 'bad_module', '无效模块');
  const t = getTemplate(db, 'artifact', type);
  check(t, 400, 'bad_type', '未知产物类型');
  const b = body ? sanitizeBody(db, type, body) : emptyBody(db, { type, framework_key, with_pdca, course, framework_fields });
  const clean = String(title || '').trim().slice(0, 120) || `${t.name}（未命名）`;
  return tx(db, () => {
    const artifact_id = id('art');
    let lineage = lineage_id, version = 1;
    if (parent_id) { const p = getOwned(db, user, parent_id); lineage = lineage || p.lineage_id; }
    lineage = lineage || id('lin');
    version = (one(db, 'SELECT MAX(version) v FROM artifacts WHERE lineage_id=?', lineage).v || 0) + 1;
    run(db, `INSERT INTO artifacts(artifact_id,owner_id,lineage_id,module,type,title,body,framework_key,framework_version,template_version,status,version,parent_id,source_run_id,origin,created_at,updated_at,saved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, artifact_id, user.user_id, lineage, module, type, clean, JSON.stringify(b), b.framework?.key || null, b.framework?.version || null,
      b.template?.version || t.version, status, version, parent_id, source_run_id, origin, now(), now(), status === 'saved' ? now() : null);
    audit(db, { actor: user, action: 'artifact_created', target_type: 'artifact', target_id: artifact_id, detail: { module, type, version, status } });
    return rowToArtifact(one(db, 'SELECT * FROM artifacts WHERE artifact_id=?', artifact_id));
  });
}

/** Drafts are edited in place. Saved versions are immutable: editing one creates a new draft child. */
export function updateArtifact(db, user, artifactId, { title, body }) {
  const r = getOwned(db, user, artifactId);
  const prev = json(r.body);
  const b = body ? sanitizeBody(db, r.type, body, prev) : prev;
  const t = title != null ? String(title).trim().slice(0, 120) || r.title : r.title;
  if (r.status === 'saved') {
    return createArtifact(db, user, { module: r.module, type: r.type, title: t, body: b, parent_id: r.artifact_id, origin: 'teacher_edit', lineage_id: r.lineage_id, source_run_id: null });
  }
  run(db, 'UPDATE artifacts SET title=?, body=?, updated_at=? WHERE artifact_id=?', t, JSON.stringify(b), now(), artifactId);
  return rowToArtifact(one(db, 'SELECT * FROM artifacts WHERE artifact_id=?', artifactId));
}

export function saveVersion(db, user, artifactId, { reviewed } = {}) {
  const r = getOwned(db, user, artifactId);
  if (r.status === 'saved') return rowToArtifact(r);
  tx(db, () => {
    run(db, "UPDATE artifacts SET status='saved', saved_at=?, reviewed_by_teacher=?, updated_at=? WHERE artifact_id=?", now(), reviewed ? 1 : r.reviewed_by_teacher, now(), artifactId);
    audit(db, { actor: user, action: 'artifact_saved', target_type: 'artifact', target_id: artifactId, detail: { version: r.version } });
  });
  return rowToArtifact(one(db, 'SELECT * FROM artifacts WHERE artifact_id=?', artifactId));
}

export function setCurrent(db, user, module, artifactId) {
  check(MODULES.includes(module), 400, 'bad_module', '无效模块');
  if (artifactId) { const r = getOwned(db, user, artifactId); check(r.module === module, 400, 'wrong_module', `该产物属于${MODULE_NAME[r.module]}`); }
  run(db, 'INSERT INTO module_state(owner_id,module,current_artifact_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(owner_id,module) DO UPDATE SET current_artifact_id=excluded.current_artifact_id, updated_at=excluded.updated_at',
    user.user_id, module, artifactId || null, now());
  audit(db, { actor: user, action: 'current_artifact_set', target_type: 'artifact', target_id: artifactId, detail: { module } });
}
export function getCurrent(db, user, module) {
  const s = one(db, 'SELECT current_artifact_id FROM module_state WHERE owner_id=? AND module=?', user.user_id, module);
  if (!s || !s.current_artifact_id) return null;
  return rowToArtifact(one(db, 'SELECT * FROM artifacts WHERE artifact_id=? AND owner_id=?', s.current_artifact_id, user.user_id));
}

export function summary(a) {
  const b = a.body || {};
  const first = (b.sections || []).find((s) => (s.kind === 'text' && s.content) || (s.kind === 'table' && s.rows?.length));
  const text = first ? (first.kind === 'text' ? first.content : `${first.title}：${first.rows.length} 行`) : '（暂无内容）';
  return String(text).replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * Arrow transfer: source = the module's explicit current artifact (never "latest history").
 * Creates a new target version, sets it current in the target module. Idempotent per key.
 */
export function transfer(db, user, { from, idempotency_key, save_draft }) {
  check(MODULES.includes(from), 400, 'bad_module', '无效方向');
  check(typeof idempotency_key === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(idempotency_key), 400, 'bad_key', '缺少幂等键');
  const to = from === 'seminar' ? 'classroom' : 'seminar';
  return tx(db, () => {
    const done = one(db, 'SELECT * FROM transfers WHERE idempotency_key=?', idempotency_key);
    if (done) { check(done.owner_id === user.user_id, 409, 'key_conflict', '幂等键冲突'); return { replayed: true, transfer: done, target: rowToArtifact(one(db, 'SELECT * FROM artifacts WHERE artifact_id=?', done.target_artifact_id)) }; }
    const src = getCurrent(db, user, from);
    check(src, 409, 'no_current', `${MODULE_NAME[from]}没有当前产物`);
    let savedFirst = false;
    if (src.status === 'draft') {
      check(save_draft === true, 409, 'draft_unsaved', '当前产物是未保存草稿，需确认“保存当前版本并导入”');
      saveVersion(db, user, src.artifact_id); savedFirst = true;
    }
    const target = createArtifact(db, user, { module: to, type: src.type, title: src.title, body: src.body, parent_id: src.artifact_id,
      source_run_id: src.source_run_id, origin: `transfer_from_${from}`, status: 'saved', lineage_id: src.lineage_id });
    const evidence = src.type === 'classroom_feedback' ? [...new Set([...(src.body.sections.find((s) => s.key === 'open_issues')?.rows || []).map((r) => r.event_id), ...(src.body.sections.find((s) => s.key === 'suggestions')?.rows || []).map((r) => r.basis_event_id)].filter(Boolean))] : [];
    const transfer_id = id('xfer');
    run(db, `INSERT INTO transfers(transfer_id,owner_id,from_module,to_module,source_artifact_id,source_version,target_artifact_id,source_run_id,evidence_event_ids,saved_draft_first,idempotency_key,confirmed_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, transfer_id, user.user_id, from, to, src.artifact_id, src.version, target.artifact_id, src.source_run_id || null, JSON.stringify(evidence), savedFirst ? 1 : 0, idempotency_key, user.pseudonym, now());
    setCurrent(db, user, to, target.artifact_id);
    audit(db, { actor: user, action: 'module_transfer', target_type: 'transfer', target_id: transfer_id, detail: { from, to } });
    return { replayed: false, transfer: one(db, 'SELECT * FROM transfers WHERE transfer_id=?', transfer_id), target };
  });
}

/** Provenance chain for an artifact (parents + transfers), shown in 产物详情／来源. */
export function provenance(db, user, artifactId) {
  const chain = []; let cur = getOwned(db, user, artifactId);
  const seen = new Set();
  while (cur && !seen.has(cur.artifact_id) && chain.length < 50) {
    seen.add(cur.artifact_id);
    const t = one(db, 'SELECT * FROM transfers WHERE target_artifact_id=?', cur.artifact_id);
    chain.push({ ...rowToArtifact(cur, false), transfer: t || null });
    cur = cur.parent_id ? one(db, 'SELECT * FROM artifacts WHERE artifact_id=? AND owner_id=?', cur.parent_id, user.user_id) : null;
  }
  return chain;
}

// ---- views: student-visible materials, render blocks ----
/** Remove teacher-only columns (answers, analysis, rubric, notes). Used for student agent context and student papers. */
export function studentView(body) {
  return { ...body, sections: body.sections.map((s) => s.kind !== 'table' ? s : { ...s, columns: s.columns.filter((c) => !c.teacher_only),
    rows: s.rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !s.columns.find((c) => c.key === k)?.teacher_only))) }) };
}

/**
 * Convert an artifact into classroom stages. Syllabus/semester plans require the selected current unit.
 * Returns { stages:[{key,label,minutes,teacher_text,question,materials,topic}], unit_label } or throws with guidance.
 */
function rawStages(a) {
  const b = a.body, sec = (k) => b.sections.find((s) => s.key === k);
  const unitNeeded = (label) => fail(409, 'unit_required', `该${label}没有设定“当前单元”。请在${MODULE_NAME[a.module]}的产物编辑中选择当前单元后再开始课堂。`);
  const topicOf = (t) => String(t || b.course?.unit || a.title).replace(/^[^：:]{1,8}[：:]/, '').slice(0, 40);
  const stepLabel = (k) => (b.framework?.steps || []).find(([key]) => key === k)?.[1] || k;
  if (a.type === 'lesson_plan') {
    const st = sec('stages');
    const rows = st ? st.rows : (sec('pdca')?.rows || []).map((r) => ({ stage: r.phase, teacher_activity: r.content, question: '', minutes: '' }));
    check(rows.length, 409, 'no_stages', '该教案没有可执行的教学阶段，请先补充教学过程');
    return { unit_label: b.course?.unit || a.title, stages: rows.map((r, i) => ({ key: `s${i + 1}`, label: stepLabel(r.stage) || `阶段${i + 1}`, minutes: num(r.minutes), teacher_text: r.teacher_activity || '', student_task: r.student_activity || '', question: r.question || '', materials: r.materials || '', topic: topicOf(b.course?.unit) })) };
  }
  if (a.type === 'courseware') {
    const rows = sec('slides')?.rows || [];
    check(rows.length, 409, 'no_stages', '该课件没有页面');
    return { unit_label: b.course?.unit || a.title, stages: rows.map((r, i) => ({ key: `p${i + 1}`, label: r.title || `第${i + 1}页`, minutes: null, teacher_text: r.points || '', question: r.question || '', materials: [r.case, r.source && `来源：${r.source}`].filter(Boolean).join('；'), topic: topicOf(r.title) })) };
  }
  const UNIT = { syllabus: ['content', '大纲', (r) => [r.unit, r.content, r.ideology_point]], semester_plan: ['weeks', '学期教学设计', (r) => [`第${r.week}周 ${r.chapter}`, r.activity, r.ideology]],
    course_design: ['units', '课程教学设计', (r) => [r.unit, r.content, r.ideology_point]], teaching_schedule: ['rows', '教学计划进度表', (r) => [`第${r.week}周 ${r.lesson_no || ''} ${String(r.content || '').slice(0, 20)}`, r.content, r.ideology]] };
  if (UNIT[a.type]) {
    const [key, label, pick] = UNIT[a.type];
    const rows = sec(key)?.rows || [];
    const idx = b.current_unit == null ? -1 : Number(b.current_unit);
    if (!(idx >= 0 && idx < rows.length)) unitNeeded(label);
    const [name, content, ideo] = pick(rows[idx]);
    return { unit_label: name, stages: [
      { key: 'u1', label: '导入', weight: 0.1, teacher_text: `本次课学习「${name}」。${b.course?.cases ? `先看一个案例：${b.course.cases}。` : ''}`, question: '', materials: '', topic: topicOf(name) },
      { key: 'u2', label: '讲授', weight: 0.45, teacher_text: content || '', question: `关于「${name}」的核心概念，你能举一个工程中的例子吗？`, materials: '', topic: topicOf(name) },
      { key: 'u3', label: '思政情境讨论', weight: 0.3, teacher_text: ideo || '', question: ideo ? '在这个情境中，工程师应承担什么责任？依据是什么？' : '', materials: '', topic: topicOf(ideo || name) },
      { key: 'u4', label: '总结', weight: 0.15, teacher_text: '梳理本节要点与未解决问题。', question: '', materials: '', topic: topicOf(name) },
    ] };
  }
  if (a.type === 'exercises' || a.type === 'exam') {
    const sv = studentView(b); // stages only carry student-visible fields
    const rows = sv.sections.find((s) => s.key === (a.type === 'exam' ? 'questions' : 'items'))?.rows || [];
    check(rows.length, 409, 'no_stages', '没有题目可作为课堂活动');
    return { unit_label: `${a.title}（课堂活动材料）`, stages: rows.slice(0, 30).map((r, i) => ({ key: `q${i + 1}`, label: `活动 ${i + 1}·${r.qtype || '题目'}`, minutes: null,
      teacher_text: `请大家看第 ${i + 1} 题。`, question: [r.stem, r.options].filter(Boolean).join('\n'), materials: r.knowledge || '', topic: topicOf(r.knowledge || r.stem) })) };
  }
  fail(409, 'type_not_runnable', a.type === 'talent_plan' ? '人才培养方案是专业层面的设计，不能直接作为一节课执行。请据此在研课场中生成课程教学设计或教案后再导入课堂' : '该产物类型不能直接用于演课场，请在研课场中选择教案、课件、大纲/计划/进度表（含当前单元）或练习/试卷');
}

const PLACEHOLDER = /【待教师补充】/g;
/** Split lecture content into spoken segments so the teacher can "teach through" the lesson over class time. */
export function lectureSegments(stage) {
  const text = [stage.teacher_text, stage.materials && `材料：${stage.materials}`].filter(Boolean).join('\n').replace(PLACEHOLDER, '').replace(/^[^：:\n]{1,10}[：:]\s*/, '');
  const parts = text.split(/(?<=[。！？；\n])/).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 4);
  const out = [];
  for (const p of parts) { if (out.length && (out.at(-1) + p).length <= 90) out[out.length - 1] += p; else out.push(p.slice(0, 160)); }
  return out.length ? out : [`围绕「${stage.topic}」讲解本环节要点（教案未填写具体讲解内容）。`];
}

/** Classroom stages with lecture segments and a time budget per stage (minutes), scaled to the class length. */
export function classroomStages(a, classMinutes) {
  const r = rawStages(a);
  const total = Number(classMinutes) || Number(a.body.course?.lesson_minutes) || 45;
  const given = r.stages.map((s) => (s.minutes > 0 ? s.minutes : null));
  const sumGiven = given.reduce((x, m) => x + (m || 0), 0);
  const weights = r.stages.map((s, i) => (sumGiven && given.every((m) => m) ? given[i] / sumGiven : s.weight ?? 1 / r.stages.length));
  const wsum = weights.reduce((x, w) => x + w, 0);
  const kn = safeKnowledge(a.body.knowledge || []);
  r.stages = r.stages.map((s, i) => ({ ...s, minutes: Math.max(0.5, Math.round((weights[i] / wsum) * total * 10) / 10), planned_minutes: given[i], segments: lectureSegments(s), knowledge: kpsIn(`${s.teacher_text}${s.question}${s.materials}${s.topic}`, kn) }));
  r.knowledge = kn;
  r.class_minutes = total;
  return r;
}
