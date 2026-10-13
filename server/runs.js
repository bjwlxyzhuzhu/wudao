// Run engine for 研课场 (plan-driven orchestration) and 演课场 (event-driven random scheduler).
// State machine: ready → running ↔ paused; running → awaiting_human → running; → completed | cancelled | failed.
import { one, all, run, id, now, tx, check, fail, audit, json, getSetting } from './db.js';
import { reserve, beginCall, settleCall, failCall, releaseReservation } from './credits.js';
import { resolveProvider, chat, ModelError } from './models.js';
import { getTemplate, SEMINAR_ROLES, SEMINAR_MODES, PHASES, DEFAULT_SEATS } from './templates.js';
import { emptyBody, validateBody, createArtifact, getOwned, getCurrent, rowToArtifact, classroomStages, studentView, updateArtifact } from './artifacts.js';
import * as sched from './scheduler.js';
import { loadMaterials, readMaterial, ideologyTerms, matchTerms } from './materials.js';
import { analyzeMaterials, answerFromMaterials } from './knowledge.js';
import { reviseWithFeedback } from './kgen.js';
import { rolesFor, roleDefs, retrieve, hasCorpus, profileOverrides, studentIdentity, learnerSummary } from './agents.js';
import { skeletonSection, demoSeminarLine, demoRevise, demoClassLine, seminarPrompt, parseSectionOutput, classroomPrompt, KIND_OF, ACTION_LABEL } from './dialogue.js';

const busy = new Set();
export const KP_KINDS = ['kp_explain', 'kp_difficulty', 'kp_ideology', 'kp_item', 'kp_check', 'kp_decide'];
const KP_SEAT = { kp_explain: 'subject', kp_difficulty: 'designer', kp_ideology: 'ideology', kp_item: 'assessor', kp_check: 'evidence', kp_decide: 'leader' };
const MODEL_KINDS = new Set([...KP_KINDS, 'kp_view', 'discuss', 'vote', 'finalize', 'review', 'draft', 'challenge', 'response', 'revision', 'question', 'answer', 'report', 'reflect', 'integrate']);
// 知识点讨论中，除六位专长教师外的成员（行业导师、青年教师、自定义教师）各补充一次视角
const KP_VIEW_SKIP = new Set(['leader', 'designer', 'subject', 'ideology', 'assessor', 'evidence', 'lab']);

// ---------- seminar planning ----------
export function seminarPlan(db, user, cfg) {
  const seats = cfg.seats;
  const modeDef = cfg.custom_phases ? { name: cfg.mode_name || '自定义模式', phases: cfg.custom_phases } : SEMINAR_MODES[cfg.mode];
  check(modeDef, 400, 'bad_mode', '无效研讨模式');
  const body = cfg.base_body;
  const sections = body.sections;
  const seatOf = (roleKey) => seats.findIndex((s) => s === roleKey);
  const members = seats.map((r, i) => i).filter((i) => i > 0);
  let rr = 0;
  const owners = {};
  for (const s of sections) {
    let idx = s.owner_role ? seatOf(s.owner_role) : -1;
    if (idx < 0) idx = members.length ? members[rr++ % members.length] : 0;
    owners[s.key] = idx;
  }
  const groups = members.length >= 2 ? [members.filter((_, i) => i % 2 === 0), members.filter((_, i) => i % 2 === 1)] : [members, members];
  const groupOf = (seat) => (groups[0].includes(seat) ? 0 : 1);
  const steps = [];
  const add = (s) => steps.push({ i: steps.length, ...s });
  const limit = Math.max(1, Math.min(Number(cfg.challenge_limit) || 3, sections.length));
  // Prioritise sections most likely to need scrutiny: tables first.
  const focus = [...sections].sort((a, b) => (b.kind === 'table') - (a.kind === 'table')).slice(0, limit);
  const challenger = (sec, k) => { const pool = members.filter((m) => m !== owners[sec.key]); return pool.length ? pool[(k + sections.indexOf(sec)) % pool.length] : 0; };
  // uploaded materials are read first by the evidence reviewer (or the leader), before any drafting
  if (cfg.material_ids?.length) add({ phase: modeDef.phases[0] === 'assign' && modeDef.phases.includes('finalize') ? 'assign' : 'materials', kind: 'review', seat: Math.max(0, seats.indexOf('evidence')) }); // 研课八步：材料研读并入“任务分配”
  for (const ph of modeDef.phases) {
    if (ph === 'knowledge') for (const kid of cfg.kp_focus || []) {
      // each knowledge point is discussed by specialty: explain → difficulty → ideology → item → check → leader decides
      KP_KINDS.forEach((kind, j) => { const seat = Math.max(0, seats.indexOf(KP_SEAT[kind])); add({ phase: ph, kind, seat: kind === 'kp_decide' ? 0 : seat, kp: kid, reply: j ? 'prev' : undefined, target_seat: kind === 'kp_difficulty' ? Math.max(0, seats.indexOf('subject')) : undefined }); });
    }
    if (ph === 'discuss') {
      if ((cfg.kp_focus || []).length) for (const kid of cfg.kp_focus) {
        KP_KINDS.forEach((kind, j) => { if (kind === 'kp_decide') return; const seat = Math.max(0, seats.indexOf(KP_SEAT[kind])); add({ phase: ph, kind, seat, kp: kid, reply: j ? 'prev' : undefined, target_seat: kind === 'kp_difficulty' ? Math.max(0, seats.indexOf('subject')) : undefined }); });
        seats.forEach((r, i) => { if (i && !KP_VIEW_SKIP.has(r)) add({ phase: ph, kind: 'kp_view', seat: i, kp: kid, reply: 'prev' }); });
        add({ phase: ph, kind: 'kp_decide', seat: 0, kp: kid, reply: 'prev' });
      } else members.forEach((m) => add({ phase: ph, kind: 'discuss', seat: m }));
    }
    if (ph === 'debate') focus.forEach((s, k) => { const c = challenger(s, k); add({ phase: ph, kind: 'challenge', seat: c, section: s.key, target_seat: owners[s.key] }); add({ phase: ph, kind: 'response', seat: owners[s.key], section: s.key, target_seat: c, reply: 'prev' }); });
    if (ph === 'revise') focus.forEach((s) => add({ phase: ph, kind: 'revision', seat: owners[s.key], section: s.key }));
    if (ph === 'review') members.forEach((m) => add({ phase: ph, kind: 'vote', seat: m, target_seat: 0 }));
    if (ph === 'finalize') add({ phase: ph, kind: 'finalize', seat: 0 });
    if (ph === 'assign') add({ phase: ph, kind: 'assign', seat: 0 });
    if (ph === 'draft') for (const s of sections) add({ phase: ph, kind: 'draft', seat: owners[s.key], section: s.key });
    if (ph === 'poll') add({ phase: ph, kind: 'poll', seat: 0 });
    if (ph === 'challenge') focus.forEach((s, k) => { const c = challenger(s, k); add({ phase: ph, kind: 'challenge', seat: c, section: s.key, target_seat: owners[s.key] }); add({ phase: ph, kind: 'response', seat: owners[s.key], section: s.key, target_seat: c, reply: 'prev' }); add({ phase: ph, kind: 'revision', seat: owners[s.key], section: s.key, reply: 'prev' }); });
    if (ph === 'group_report') groups.forEach((g, gi) => { if (g.length) add({ phase: ph, kind: 'report', seat: g[0], group: gi, section: sections.find((s) => groupOf(owners[s.key]) === gi)?.key }); });
    if (ph === 'group_challenge') focus.forEach((s, k) => { const og = groupOf(owners[s.key]); const c = groups[1 - og][k % Math.max(1, groups[1 - og].length)] ?? 0; add({ phase: ph, kind: 'challenge', seat: c, section: s.key, target_seat: owners[s.key], group: 1 - og }); add({ phase: ph, kind: 'response', seat: owners[s.key], section: s.key, target_seat: c, reply: 'prev', group: og }); add({ phase: ph, kind: 'revision', seat: owners[s.key], section: s.key, reply: 'prev', group: og }); });
    if (ph === 'reflect') for (const s of sections) add({ phase: ph, kind: 'reflect', seat: owners[s.key], section: s.key });
    if (ph === 'socratic') focus.forEach((s) => { add({ phase: ph, kind: 'question', seat: 0, section: s.key, target_seat: owners[s.key] }); add({ phase: ph, kind: 'answer', seat: owners[s.key], section: s.key, target_seat: 0, reply: 'prev' }); add({ phase: ph, kind: 'revision', seat: owners[s.key], section: s.key, reply: 'prev' }); });
    if (ph === 'integrate') add({ phase: ph, kind: 'integrate', seat: 0 });
  }
  if (!steps.some((s) => s.kind === 'integrate')) add({ phase: 'integrate', kind: 'integrate', seat: 0 });
  return { steps, owners, groups, mode_name: modeDef.name, phases: modeDef.phases };
}

// ---------- estimates & creation ----------
function pricing(db, execMode, providerId) {
  if (execMode !== 'model') return { rate: 0, pricing_version: Number(getSetting(db, 'pricing_version')), provider: null };
  const p = resolveProvider(db, providerId);
  if (p.error) fail(409, p.error.code, p.error.message);
  return { rate: p.config.credit_rate, pricing_version: Number(getSetting(db, 'pricing_version')), provider: p.config };
}

function prepareSeminar(db, user, input) {
  const seats = Array.isArray(input.seats) && input.seats.length ? input.seats : DEFAULT_SEATS;
  const avail = rolesFor(db, user);
  check(seats[0] === 'leader', 400, 'bad_seats', '主位必须是教研组长');
  check(seats.length >= 3 && seats.length <= 12 && seats.every((r) => avail[r] && (!avail[r].custom || avail[r].enabled)) && new Set(seats).size === seats.length, 400, 'bad_seats', '席位需 3—12 个、角色有效且不重复（自定义教师需先在智能体中心设置）');
  let custom = null;
  if (input.custom_mode_id) {
    const m = one(db, 'SELECT * FROM custom_modes WHERE mode_id=? AND owner_id=?', input.custom_mode_id, user.user_id);
    check(m, 404, 'not_found', '自定义模式不存在'); custom = { name: m.name, phases: json(m.body).phases };
  }
  let base_body, target_artifact_id = null, task = input.task === 'regen' ? 'regen' : 'generate';
  let reference = null;
  if (input.reference_artifact_id) reference = rowToArtifact(getOwned(db, user, input.reference_artifact_id));
  const mats = loadMaterials(db, user, input.material_ids);
  const analysis = mats.length ? analyzeMaterials(mats) : null;
  const guessed = Object.fromEntries(Object.entries(analysis?.course || {}).filter(([, v]) => v !== '' && v != null));
  const courseIn = { ...guessed, ...Object.fromEntries(Object.entries(input.course || {}).filter(([, v]) => v !== '' && v != null)) };
  let base = null;
  if (input.base_artifact_id) base = rowToArtifact(getOwned(db, user, input.base_artifact_id));
  if (base) {
    // revise an existing artifact (e.g. the lesson plan) using a reference such as classroom feedback
    base_body = structuredClone(base.body); input.type = base.type;
  } else if (task === 'regen') {
    const a = rowToArtifact(getOwned(db, user, input.target_artifact_id));
    check(a.body.sections.some((s) => s.key === input.section_key), 400, 'bad_section', '无效段落');
    base_body = a.body; target_artifact_id = a.artifact_id;
  } else {
    const type = input.type;
    const t = getTemplate(db, 'artifact', type);
    check(t && !t.body.system_only, 400, 'bad_type', '请选择产物类型');
    if (input.framework_key) check(getTemplate(db, 'framework', input.framework_key), 400, 'bad_framework', '未知教学设计框架');
    if (reference && reference.type === type) { base_body = { ...reference.body, course: { ...reference.body.course, ...input.course } }; }
    else base_body = emptyBody(db, { type, framework_key: input.framework_key, with_pdca: !!input.with_pdca, course: courseIn, framework_fields: input.framework_fields || {} });
  }
  // knowledge points extracted from the imported materials travel with the artifact (without being re-invented)
  const kps = analysis?.knowledge_points || base_body.knowledge || [];
  if (kps.length) base_body.knowledge = kps;
  if (input.kp_notes && typeof input.kp_notes === 'object') base_body.kp_notes = input.kp_notes; // carry the knowledge-seminar decisions into later outputs
  if (input.class_profile_id) base_body.learner_profile = learnerSummary(db, user, input.class_profile_id); // 学情分析以导入的班级画像为依据
  const wanted = Array.isArray(input.kp_ids) && input.kp_ids.length ? input.kp_ids : kps.slice(0, Math.min(Number(input.kp_limit) || 4, 8)).map((k) => k.id);
  const kp_focus = wanted.filter((k) => kps.some((x) => x.id === k)).slice(0, 8);
  const material_ids = mats.map((m) => m.material_id);
  const mode = input.mode || (base ? 'reflection' : 'full');
  if (base && !custom) custom = { name: '依据反馈修订', phases: ['assign', 'reflect', 'integrate'] }; // keep the teacher's content; revise section by section
  const cfg = { material_ids, kp_focus, base_artifact_id: base?.artifact_id || null, task, seats, role_defs: roleDefs(db, user, seats), table_shape: ['oval', 'round', 'u'].includes(input.table_shape) ? input.table_shape : 'oval', mode,
    custom_phases: custom?.phases, mode_name: custom?.name, challenge_limit: input.challenge_limit, type: input.type || null, title: String(input.title || base?.title || '').slice(0, 120),
    reference_artifact_id: reference?.artifact_id || null, class_profile_id: input.class_profile_id || null, target_artifact_id, section_key: input.section_key || null, human_reply_budget: Math.min(Number(input.human_reply_budget ?? 3), 20) };
  let plan;
  if (task === 'regen') {
    const sec = base_body.sections.find((s) => s.key === input.section_key);
    const seat = Math.max(0, seats.indexOf(sec.owner_role || 'designer'));
    plan = { steps: [{ i: 0, phase: 'draft', kind: 'draft', seat, section: sec.key }], owners: { [sec.key]: seat }, groups: [[], []], mode_name: '局部重生成', phases: ['draft'] };
  } else plan = seminarPlan(db, user, { ...cfg, base_body });
  const modelSteps = plan.steps.filter((s) => MODEL_KINDS.has(s.kind)).length + (task === 'regen' ? 0 : cfg.human_reply_budget);
  return { cfg, plan, base_body, modelSteps, reference };
}

function prepareClassroom(db, user, input) {
  const current = getCurrent(db, user, 'classroom');
  check(current, 409, 'no_current', '演课场没有当前产物，请先从研课场导入');
  const raw = input.config || input;
  // 导入的班级画像：人数与分组随画像，逐人参数覆盖到对应学生智能体
  const prof = raw.class_profile_id ? profileOverrides(db, user, raw.class_profile_id) : null;
  const config = sched.normalizeConfig({ ...raw, ...(prof ? { class_size: prof.n, group_size: prof.group_size } : {}), class_minutes: Number(raw.class_minutes) || Number(current.body.course?.lesson_minutes) || 45 });
  if (prof) { config.class_profile_id = raw.class_profile_id; config.profile_rows = prof.rows; }
  const { stages, unit_label, knowledge } = classroomStages(current, config.class_minutes);
  if (!config.seed) config.seed = `seed-${Date.now().toString(36)}`;
  return { config, current, stages, unit_label, knowledge, modelSteps: config.max_turns };
}

export function estimate(db, user, input) {
  const execMode = input.exec_mode === 'model' ? 'model' : 'demo';
  const p = execMode === 'model' ? pricing(db, execMode, input.provider_id) : { rate: 0 };
  const cap = Number(getSetting(db, 'max_calls_per_task'));
  if (input.module === 'seminar') {
    const s = prepareSeminar(db, user, input);
    const calls = execMode === 'model' ? Math.min(s.modelSteps, cap) : 0;
    return { exec_mode: execMode, max_calls: calls, max_credits: calls * p.rate, rate: p.rate, steps: s.plan.steps.length, capped: s.modelSteps > cap,
      plan_summary: s.plan.steps.map((x) => ({ kind: x.kind, phase: PHASES[x.phase] || x.phase, role: (s.cfg.role_defs?.[s.cfg.seats[x.seat]] || SEMINAR_ROLES[s.cfg.seats[x.seat]])?.name, section: x.section || null })) };
  }
  const c = prepareClassroom(db, user, input);
  const calls = execMode === 'model' ? Math.min(c.modelSteps, cap) : 0;
  return { exec_mode: execMode, max_calls: calls, max_credits: calls * p.rate, rate: p.rate, unit_label: c.unit_label, stages: c.stages.map((s) => `${s.label}（${s.minutes}分）`), class_minutes: c.config.class_minutes, input_artifact: { artifact_id: c.current.artifact_id, title: c.current.title, version: c.current.version } };
}

export function createRun(db, user, input) {
  const module = input.module;
  check(['seminar', 'classroom'].includes(module), 400, 'bad_module', '无效模块');
  const exec_mode = input.exec_mode === 'model' ? 'model' : 'demo';
  const p = pricing(db, exec_mode, input.provider_id);
  const cap = Number(getSetting(db, 'max_calls_per_task'));
  return tx(db, () => {
    const run_id = id('run');
    if (module === 'seminar') {
      const s = prepareSeminar(db, user, input);
      const body = s.base_body;
      run(db, `INSERT INTO runs(run_id,owner_id,module,exec_mode,status,input_artifact_id,input_snapshot,config,plan,state,seed,budget_calls,provider_id,rate,pricing_version,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, run_id, user.user_id, module, exec_mode, 'ready', s.reference?.artifact_id || s.cfg.target_artifact_id || null,
        s.reference ? JSON.stringify(s.reference) : null, JSON.stringify(s.cfg), JSON.stringify(s.plan), JSON.stringify({ cursor: 0, body, extra: [] }), null,
        exec_mode === 'model' ? Math.min(s.modelSteps, cap) : 0, p.provider?.provider_id || null, p.rate, p.pricing_version, now());
      s.cfg.seats.forEach((r, i) => run(db, 'INSERT INTO agent_profiles(run_id,agent_id,kind,name,role,seat,group_id,avatar,traits) VALUES(?,?,?,?,?,?,?,?,?)',
        run_id, `M${i}`, 'teacher_agent', s.cfg.role_defs?.[r]?.name || SEMINAR_ROLES[r].name, r, i, i === 0 ? null : `G${s.plan.groups[0].includes(i) ? 1 : 2}`, i * 7 + 3, JSON.stringify({ duty: s.cfg.role_defs?.[r]?.duty || SEMINAR_ROLES[r].duty, title: s.cfg.role_defs?.[r]?.title || SEMINAR_ROLES[r].name, person: s.cfg.role_defs?.[r]?.person || '' })));
    } else {
      const c = prepareClassroom(db, user, input);
      const students = sched.makeStudents(c.config, c.config.seed, c.config.profile_rows || null);
      const profileRows = c.config.profile_rows; delete c.config.profile_rows; void profileRows;
      run(db, `INSERT INTO runs(run_id,owner_id,module,exec_mode,status,input_artifact_id,input_snapshot,config,plan,state,seed,budget_calls,provider_id,rate,pricing_version,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, run_id, user.user_id, module, exec_mode, 'ready', c.current.artifact_id, JSON.stringify(c.current), JSON.stringify(c.config),
        JSON.stringify({ stages: c.stages, unit_label: c.unit_label, knowledge: c.knowledge || [] }), JSON.stringify({ sched: sched.initState(c.config, c.config.seed), memory: {} }), c.config.seed,
        exec_mode === 'model' ? Math.min(c.modelSteps, cap) : 0, p.provider?.provider_id || null, p.rate, p.pricing_version, now());
      run(db, 'INSERT INTO agent_profiles(run_id,agent_id,kind,name,role,seat,group_id,avatar,traits) VALUES(?,?,?,?,?,?,?,?,?)', run_id, 'T', 'teacher_agent', '任课教师 · 苏婉清', 'teacher', -1, null, 5, JSON.stringify({ person: '苏婉清', title: '任课教师' }));
      const ins = db.prepare('INSERT INTO agent_profiles(run_id,agent_id,kind,name,role,seat,group_id,avatar,traits) VALUES(?,?,?,?,?,?,?,?,?)');
      for (const st of students) ins.run(run_id, st.agent_id, 'student_agent', st.name, 'student', st.seat, st.group_id, st.avatar, JSON.stringify(st.traits));
    }
    audit(db, { actor: user, action: 'run_created', target_type: 'run', target_id: run_id, detail: { module, exec_mode } });
    return getRunRow(db, user, run_id);
  });
}

export function getRunRow(db, user, runId) {
  const r = one(db, 'SELECT * FROM runs WHERE run_id=?', runId);
  if (!r || r.owner_id !== user.user_id) fail(404, 'not_found', '运行不存在或无权访问');
  return r;
}

// ---------- lifecycle ----------
export function startRun(db, user, runId, { idempotency_key } = {}) {
  return tx(db, () => {
    const r = getRunRow(db, user, runId);
    if (r.status === 'running') return r;
    check(r.status === 'ready', 409, 'bad_state', '该运行无法开始');
    check(!one(db, "SELECT 1 FROM runs WHERE owner_id=? AND module=? AND status IN ('running','awaiting_human') AND run_id<>?", user.user_id, r.module, runId), 409, 'already_running', '本模块已有进行中的运行，请先暂停或结束');
    let reservation_id = null;
    if (r.exec_mode === 'model') {
      const p = resolveProvider(db, r.provider_id);
      if (p.error) fail(409, p.error.code, p.error.message);
      const resv = reserve(db, { user_id: user.user_id, run_id: runId, amount: r.budget_calls * r.rate, rate: r.rate, pricing_version: r.pricing_version, key: `run-start:${runId}` });
      reservation_id = resv.reservation_id;
    }
    run(db, "UPDATE runs SET status='running', started_at=?, last_activity_at=?, reservation_id=? WHERE run_id=?", now(), now(), reservation_id, runId);
    audit(db, { actor: user, action: 'run_started', target_type: 'run', target_id: runId });
    return getRunRow(db, user, runId);
  });
}

export function pauseRun(db, user, runId, reason = 'teacher_pause') {
  return tx(db, () => {
    const r = getRunRow(db, user, runId);
    if (r.status === 'paused') return r;
    check(['running', 'awaiting_human'].includes(r.status), 409, 'bad_state', '当前状态不能暂停');
    run(db, "UPDATE runs SET status='paused', paused_at=?, stop_reason=? WHERE run_id=?", now(), reason, runId);
    audit(db, { actor: user, action: 'run_paused', target_type: 'run', target_id: runId, detail: { reason } });
    return getRunRow(db, user, runId);
  });
}

export function resumeRun(db, user, runId) {
  return tx(db, () => {
    const r = getRunRow(db, user, runId);
    if (r.status === 'running') return r;
    check(['paused', 'awaiting_human'].includes(r.status), 409, 'bad_state', '当前状态不能继续');
    check(!one(db, "SELECT 1 FROM runs WHERE owner_id=? AND module=? AND status IN ('running','awaiting_human') AND run_id<>?", user.user_id, r.module, runId), 409, 'already_running', '本模块已有进行中的运行');
    if (r.exec_mode === 'model') {
      const resv = r.reservation_id ? one(db, 'SELECT * FROM reservations WHERE reservation_id=?', r.reservation_id) : null;
      check(resv && resv.status === 'open', 409, 'reservation_closed', '该运行的积分预占已释放（长时间未活动）。请结束本次运行并新建');
    }
    const add = r.paused_at ? Math.max(0, Date.now() - Date.parse(r.paused_at)) : 0;
    run(db, "UPDATE runs SET status='running', paused_ms=paused_ms+?, paused_at=NULL, stop_reason=NULL, last_activity_at=? WHERE run_id=?", add, now(), runId);
    audit(db, { actor: user, action: 'run_resumed', target_type: 'run', target_id: runId });
    return getRunRow(db, user, runId);
  });
}

// An open composer pauses the run for at most COMPOSER_LEASE_MS; a tab closed with the box open must not stall the run (or a job) forever.
export const COMPOSER_LEASE_MS = 120000;
export function releaseStaleComposer(db, runId) {
  const r = one(db, 'SELECT status, last_activity_at FROM runs WHERE run_id=?', runId);
  if (r?.status === 'awaiting_human' && (!r.last_activity_at || Date.now() - Date.parse(r.last_activity_at) > COMPOSER_LEASE_MS)) {
    run(db, "UPDATE runs SET status='running' WHERE run_id=? AND status='awaiting_human'", runId);
    return true;
  }
  return false;
}

export function composer(db, user, runId, open) {
  const r = getRunRow(db, user, runId);
  if (open && ['running', 'awaiting_human'].includes(r.status)) run(db, "UPDATE runs SET status='awaiting_human', last_activity_at=? WHERE run_id=?", now(), runId);
  if (!open && r.status === 'awaiting_human') run(db, "UPDATE runs SET status='running' WHERE run_id=?", runId);
  return getRunRow(db, user, runId);
}

export function endRun(db, userOrNull, runId, status = 'completed', reason = null) {
  return tx(db, () => {
    const r = userOrNull ? getRunRow(db, userOrNull, runId) : one(db, 'SELECT * FROM runs WHERE run_id=?', runId);
    if (['completed', 'cancelled', 'failed'].includes(r.status)) return r;
    check(['completed', 'cancelled', 'failed'].includes(status), 400, 'bad_status', '无效状态');
    const add = r.paused_at ? Math.max(0, Date.now() - Date.parse(r.paused_at)) : 0;
    run(db, 'UPDATE runs SET status=?, ended_at=?, paused_ms=paused_ms+?, paused_at=NULL, stop_reason=COALESCE(?,stop_reason) WHERE run_id=?', status, now(), add, reason, runId);
    if (r.reservation_id) releaseReservation(db, r.reservation_id, `运行${status}`);
    audit(db, { actor: userOrNull, action: `run_${status}`, target_type: 'run', target_id: runId, detail: { reason } });
    return one(db, 'SELECT * FROM runs WHERE run_id=?', runId);
  });
}

// ---------- events ----------
function insertEvent(db, r, e) {
  const prior = one(db, 'SELECT * FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT 1', r.run_id);
  const t = now();
  const start = Date.parse(r.started_at || r.created_at);
  let reply_latency = null;
  if (e.reply_to) {
    const target = one(db, 'SELECT time FROM events WHERE event_id=? AND run_id=?', e.reply_to, r.run_id);
    if (!target) e.reply_to = null; else reply_latency = Math.max(0, Date.parse(t) - Date.parse(target.time));
  }
  const ev = { event_id: id('ev'), run_id: r.run_id, owner_id: r.owner_id, sequence: (prior?.sequence || 0) + 1, time: t,
    elapsed_ms: Math.max(0, Date.parse(t) - start), inter_event_ms: prior ? Math.max(0, Date.parse(t) - Date.parse(prior.time)) : null,
    actor_id: e.actor_id, actor_type: e.actor_type, source: e.source, human_role: e.human_role || null, kind: e.kind, text: String(e.text).slice(0, 20000),
    reply_to: e.reply_to || null, reply_latency_ms: reply_latency, target_actor: e.target_actor || null, target_ref: e.target_ref || null, group_id: e.group_id || null,
    stage: e.stage || null, composer_opened_at: e.composer_opened_at || null, submitted_at: e.submitted_at || null, input_dwell_ms: e.input_dwell_ms ?? null,
    model_call_id: e.model_call_id || null, decision_id: e.decision_id || null,
    class_clock_ms: e.class_clock_ms ?? null, sim_duration_ms: e.sim_duration_ms ?? null, ideology_terms: e.ideology_terms ?? null };
  run(db, `INSERT INTO events(${Object.keys(ev).join(',')}) VALUES(${Object.keys(ev).map(() => '?').join(',')})`, ...Object.values(ev));
  run(db, 'UPDATE runs SET last_activity_at=? WHERE run_id=?', t, r.run_id);
  return ev;
}

export function humanInput(db, user, runId, input) {
  return tx(db, () => {
    const r = getRunRow(db, user, runId);
    check(['running', 'paused', 'awaiting_human'].includes(r.status), 409, 'bad_state', '运行未进行中');
    const text = String(input.text || '').trim();
    check(text.length >= 1 && text.length <= 4000, 400, 'bad_text', '发言内容为空或过长');
    if (input.idempotency_key) {
      const done = one(db, 'SELECT response FROM idempotency WHERE key=?', `human:${input.idempotency_key}`);
      if (done) return json(done.response);
    }
    const role = r.module === 'classroom' ? (input.human_role === 'student' ? 'student' : 'teacher') : 'teacher';
    const kinds = ['question', 'challenge', 'response', 'supplement', 'observation', 'revision', 'lecture'];
    const kind = kinds.includes(input.kind) ? input.kind : (role === 'student' ? 'question' : 'question');
    const opened = input.composer_opened_at && Date.parse(input.composer_opened_at) ? new Date(input.composer_opened_at).toISOString() : null;
    const submitted = now();
    const ev = insertEvent(db, r, { actor_id: `H-${user.pseudonym}`, actor_type: 'human', source: 'human_input', human_role: role, kind, text,
      reply_to: input.reply_to || null, target_actor: input.target_actor || null, composer_opened_at: opened, submitted_at: submitted,
      input_dwell_ms: opened ? Math.max(0, Date.parse(submitted) - Date.parse(opened)) : null, stage: currentStageKey(r),
      class_clock_ms: r.module === 'classroom' ? json(r.state)?.sched?.clock_ms ?? null : null,
      ideology_terms: JSON.stringify(matchTerms(text, ideologyTerms(r.module === 'seminar' ? json(r.state)?.body?.course : json(r.input_snapshot)?.body?.course)).slice(0, 12)) });
    run(db, "UPDATE runs SET has_human=1, status=CASE WHEN status='awaiting_human' THEN 'running' ELSE status END WHERE run_id=?", runId);
    if (r.module === 'seminar') {
      // Human interjection → queue a reply from the addressed seat (or the leader), bounded by budget.
      const st = json(r.state);
      const plan = json(r.plan);
      const seat = input.target_actor && /^M\d+$/.test(input.target_actor) ? Number(input.target_actor.slice(1)) : 0;
      st.extra = st.extra || [];
      st.extra.push({ kind: 'response', seat, reply_to: ev.event_id, section: null, human: true });
      run(db, 'UPDATE runs SET state=? WHERE run_id=?', JSON.stringify(st), runId);
      void plan;
    }
    if (input.idempotency_key) run(db, 'INSERT INTO idempotency(key,user_id,scope,response,created_at) VALUES(?,?,?,?,?)', `human:${input.idempotency_key}`, user.user_id, 'human', JSON.stringify(ev), now());
    return ev;
  });
}

function currentStageKey(r) {
  if (r.module !== 'classroom') return null;
  const st = json(r.state), plan = json(r.plan);
  return plan.stages[Math.min(st.sched.stage_idx, plan.stages.length - 1)]?.key || null;
}

// ---------- step execution ----------
/**
 * Execute exactly one step. `emit(type, data)` streams delta/final/error to the client.
 * Model failures never fall back to scripted text.
 */
export async function stepRun(db, user, runId, { idempotency_key, emit = () => {} } = {}) {
  if (idempotency_key) {
    const done = one(db, 'SELECT response FROM idempotency WHERE key=?', `step:${idempotency_key}`);
    if (done) { const res = json(done.response); emit('final', res); return res; }
  }
  if (busy.has(runId)) fail(409, 'step_in_progress', '上一步仍在进行中');
  busy.add(runId);
  try {
    releaseStaleComposer(db, runId);
    let r = getRunRow(db, user, runId);
    check(r.status === 'running', 409, 'not_running', r.status === 'awaiting_human' ? '真人正在输入，提交或关闭输入框后继续' : '运行未在进行中');
    if (r.module === 'classroom') {
      const plan = json(r.plan), cfg = json(r.config);
      const activeMs = Date.now() - Date.parse(r.started_at) - r.paused_ms;
      if (activeMs > cfg.max_minutes * 60e3) { endRun(db, user, runId, 'completed', 'time_limit'); const res = { ended: true, reason: 'time_limit' }; emit('end', res); return res; }
      const nonHuman = one(db, "SELECT COUNT(*) n FROM events WHERE run_id=? AND actor_type<>'human'", runId).n;
      if (nonHuman >= cfg.max_turns) { endRun(db, user, runId, 'completed', 'turn_limit'); const res = { ended: true, reason: 'turn_limit' }; emit('end', res); return res; }
      void plan;
    }
    const prepared = r.module === 'seminar' ? prepareSeminarStep(db, r) : prepareClassroomStep(db, r);
    if (prepared.end) { endRun(db, user, runId, 'completed', prepared.reason); const res = { ended: true, reason: prepared.reason }; emit('end', res); return res; }
    let text, call = null, modelOut = null;
    if (prepared.needsModel && r.exec_mode === 'model') {
      const p = resolveProvider(db, r.provider_id);
      if (p.error) fail(409, p.error.code, p.error.message);
      if (!beginCall(db, r.reservation_id)) {
        pauseRun(db, user, runId, 'budget_exhausted');
        fail(409, 'budget_exhausted', '本次运行的积分预算已用完，已暂停。已有记录可继续查看和导出。', { paused: true });
      }
      const st = json(r.state);
      const call_id = id('call');
      run(db, `INSERT INTO model_calls(call_id,run_id,user_id,provider_id,model_id,key_version,purpose,actor_id,status,request_at,reservation_id,retry_of,idempotency_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, call_id, runId, user.user_id, p.config.provider_id, p.config.model_id, p.config.key_version, prepared.purpose, prepared.actor_id, 'pending', now(), r.reservation_id, st.failed_call || null, idempotency_key ? `call:${idempotency_key}` : null);
      emit('start', { actor_id: prepared.actor_id, kind: prepared.kind, call_id });
      const t0 = Date.now();
      try {
        modelOut = await chat(p.config, { system: prepared.prompt.system, messages: prepared.prompt.messages, onDelta: (d) => emit('delta', { actor_id: prepared.actor_id, delta: d }) });
        text = modelOut.text.trim();
        if (prepared.parse) prepared.parsed = prepared.parse(text);
      } catch (e) {
        const code = e.code || 'provider_error';
        run(db, "UPDATE model_calls SET status='failed', error_code=?, error_message=?, completed_at=?, latency_ms=? WHERE call_id=?", code, String(e.message).slice(0, 300), now(), Date.now() - t0, call_id);
        failCall(db, r.reservation_id, call_id);
        const st2 = json(one(db, 'SELECT state FROM runs WHERE run_id=?', runId).state); st2.failed_call = call_id;
        run(db, 'UPDATE runs SET state=? WHERE run_id=?', JSON.stringify(st2), runId);
        fail(502, code, e instanceof ModelError || e.code === 'bad_format' ? e.message : '模型调用失败', { retryable: true, call_id });
      }
      call = { call_id, t0, p };
    } else {
      text = prepared.demoText();
      if (prepared.demoApply) prepared.parsed = prepared.demoApply();
      emit('start', { actor_id: prepared.actor_id, kind: prepared.kind });
    }
    // Persist output + state + settlement atomically.
    const result = tx(db, () => {
      r = one(db, 'SELECT * FROM runs WHERE run_id=?', runId);
      const ev = insertEvent(db, r, { ...prepared.event, ...(prepared.eventExtra ? prepared.eventExtra(text) : {}), text, source: call ? 'model' : (prepared.needsModel ? 'demo' : 'system'), actor_type: call ? 'model_agent' : prepared.event.actor_type, model_call_id: call?.call_id });
      const decisionId = prepared.decision ? saveDecision(db, r, prepared.decision, ev) : null;
      if (decisionId) run(db, 'UPDATE events SET decision_id=? WHERE event_id=?', decisionId, ev.event_id);
      prepared.commit(ev, prepared.parsed);
      if (prepared.challenge) recordChallenge(db, r, prepared.challenge, ev);
      if (call) {
        run(db, `UPDATE model_calls SET status='succeeded', first_token_at=?, completed_at=?, latency_ms=?, input_tokens=?, output_tokens=?, request_id=?, credits=?, event_id=? WHERE call_id=?`,
          modelOut.first_token_at, now(), Date.now() - call.t0, modelOut.input_tokens, modelOut.output_tokens, modelOut.request_id, r.rate, ev.event_id, call.call_id);
        settleCall(db, r.reservation_id, call.call_id, runId);
        run(db, 'UPDATE runs SET model_calls=model_calls+1 WHERE run_id=?', runId);
      }
      const after = one(db, 'SELECT output_artifact_id, model_calls, state FROM runs WHERE run_id=?', runId);
      const out = { event: { ...ev, decision_id: decisionId }, output_artifact_id: after.output_artifact_id, model_calls: after.model_calls };
      if (r.module === 'classroom') {
        const st = json(after.state);
        out.classroom = { pending_hands: (st.sched?.pending || []).map((p) => p.agent_id), stage_idx: st.sched?.stage_idx ?? 0, clock_ms: st.sched?.clock_ms ?? 0, stage_start_ms: st.sched?.stage_start_ms ?? 0,
          thinking: ev.kind === 'silence' && prepared.decision ? prepared.decision.top_weights.slice(0, 5).map((x) => x[0]) : [],
          phase: st.sched?.phase || 'teach', groups_active: ['group', 'debate', 'report'].includes(st.sched?.phase) ? st.sched?.groups_this_round || [] : [] };
      }
      if (idempotency_key) run(db, 'INSERT OR IGNORE INTO idempotency(key,user_id,scope,response,created_at) VALUES(?,?,?,?,?)', `step:${idempotency_key}`, user.user_id, 'step', JSON.stringify(out), now());
      return out;
    });
    emit('final', result);
    return result;
  } finally {
    busy.delete(runId);
  }
}

function saveDecision(db, r, d, ev) {
  const decision_id = id('dec');
  const step = one(db, 'SELECT COUNT(*) n FROM scheduler_decisions WHERE run_id=?', r.run_id).n + 1;
  run(db, `INSERT INTO scheduler_decisions(decision_id,run_id,step,time,trigger,trigger_event_id,seed,n_candidates,n_eligible,speak_probability,draw,hands,selected_agent,action,target_actor,target_event_id,group_id,cooldown,top_weights,distribution_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, decision_id, r.run_id, step, now(), d.trigger, d.trigger_event_id, r.seed, d.n_candidates, d.n_eligible, d.speak_probability, d.draw,
    JSON.stringify(d.hands), d.selected_agent, d.action, d.target_actor, d.target_event_id, d.group_id, d.cooldown, JSON.stringify(d.top_weights), d.distribution_version);
  return decision_id;
}

function recordChallenge(db, r, c, ev) {
  if (c.open) run(db, 'INSERT INTO challenges(challenge_id,run_id,challenger,target_actor,target_ref,challenge_event_id,opened_at) VALUES(?,?,?,?,?,?,?)', id('chal'), r.run_id, ev.actor_id, c.target_actor, c.target_ref, ev.event_id, ev.time);
  if (c.respond) { const ch = one(db, 'SELECT * FROM challenges WHERE run_id=? AND target_ref=? AND response_event_id IS NULL ORDER BY opened_at DESC LIMIT 1', r.run_id, c.target_ref); if (ch) run(db, 'UPDATE challenges SET response_event_id=? WHERE challenge_id=?', ev.event_id, ch.challenge_id); }
  if (c.revise) { const ch = one(db, 'SELECT * FROM challenges WHERE run_id=? AND target_ref=? AND revision_event_id IS NULL ORDER BY opened_at DESC LIMIT 1', r.run_id, c.target_ref); if (ch) run(db, 'UPDATE challenges SET revision_event_id=? WHERE challenge_id=?', ev.event_id, ch.challenge_id); }
}

export function resolveChallenge(db, user, challengeId, resolution) {
  const c = one(db, 'SELECT c.* FROM challenges c JOIN runs r ON r.run_id=c.run_id WHERE c.challenge_id=? AND r.owner_id=?', challengeId, user.user_id);
  check(c, 404, 'not_found', '质询不存在');
  check(['resolved', 'unresolved', 'partially_resolved'].includes(resolution), 400, 'bad_resolution', '无效标记');
  run(db, 'UPDATE challenges SET human_resolution=?, closed_at=? WHERE challenge_id=?', resolution, resolution === 'unresolved' ? null : now(), challengeId);
}

// ---------- seminar step ----------
function prepareSeminarStep(db, r) {
  const cfg = json(r.config), plan = json(r.plan), st = json(r.state);
  const seats = cfg.seats;
  const extra = (st.extra || [])[0];
  const step = extra ? { ...extra, extra: true } : plan.steps[st.cursor];
  if (!step) return { end: true, reason: 'plan_completed' };
  const body = st.body;
  const sec = step.section ? body.sections.find((s) => s.key === step.section) : null;
  const roleKey = seats[step.seat] || 'leader';
  const ROLES = { ...SEMINAR_ROLES, ...(cfg.role_defs || {}) };
  const history = all(db, 'SELECT e.*, p.name actor_name FROM events e LEFT JOIN agent_profiles p ON p.run_id=e.run_id AND p.agent_id=e.actor_id WHERE e.run_id=? ORDER BY sequence', r.run_id)
    .map((e) => ({ ...e, actor_name: e.actor_name || (e.actor_type === 'human' ? '真人教师' : e.actor_id) }));
  const last = history.at(-1);
  const issues = sec ? validateBody(body.template?.key || cfg.type, body).filter((i) => i.section === sec.key) : validateBody(body.template?.key || cfg.type, body);
  const reference = r.input_snapshot ? json(r.input_snapshot) : null;
  const feedbackText = reference && reference.type === 'classroom_feedback' ? reference.body.sections.map((s) => s.kind === 'text' ? s.content : JSON.stringify(s.rows)).join('\n') : null;
  const assignments = body.sections.map((s) => ({ section: s.title, role: seats[plan.owners[s.key]] }));
  const progress = body.sections.map((s) => ({ section: s.title, done: s.revision > 0, issues: validateBody(body.template?.key || cfg.type, body).filter((i) => i.section === s.key).length }));
  const mats = cfg.material_ids?.length ? loadMaterials(db, { user_id: r.owner_id }, cfg.material_ids) : [];
  const terms = ideologyTerms(body.course);
  const digests = mats.map((m) => ({ ...m, ...readMaterial(m, terms) }));
  const kps = body.knowledge || [];
  const kp = step.kp ? kps.find((k) => k.id === step.kp) : null;
  const humanText = step.human && step.reply_to ? one(db, 'SELECT text FROM events WHERE event_id=?', step.reply_to)?.text : null;
  const kindMap = { kp_explain: 'explain', kp_difficulty: 'difficulty', kp_ideology: 'ideology_link', kp_item: 'item', kp_check: 'source_check', kp_decide: 'decision', kp_view: 'viewpoint', discuss: 'discuss', vote: 'vote', finalize: 'finalize', review: 'review', assign: 'assign', poll: 'poll', draft: 'draft', challenge: 'challenge', response: 'response', revision: 'revision', question: 'question', answer: 'response', report: 'report', reflect: 'revision', integrate: 'integrate' };
  const needsModel = MODEL_KINDS.has(step.kind);
  const producesSection = ['draft', 'revision', 'reflect'].includes(step.kind) && sec;
  const actor_id = `M${step.seat}`;
  const replyTo = step.reply_to || (step.reply === 'prev' ? last?.event_id : null);
  // 训练资料：按当前话题检索该教师自己的资料片段（没有资料时为空）
  const corpusQuery = kp ? `${kp.term} ${kp.definition}` : sec ? `${sec.title} ${body.course?.unit || ''}` : `${body.course?.name || ''} ${body.course?.unit || ''}`;
  const corpus = needsModel && hasCorpus(db, r.owner_id, roleKey) ? retrieve(db, r.owner_id, roleKey, corpusQuery, 2) : [];
  const cite = corpus[0] ? `（结合我以往的教学资料《${corpus[0].filename}》：“${corpus[0].text.replace(/\s+/g, ' ').slice(0, 60)}…”）` : '';
  const finalizes = step.kind === 'finalize' || (step.kind === 'integrate' && !plan.phases?.includes('finalize'));
  const out = {
    needsModel, actor_id, kind: kindMap[step.kind], purpose: `seminar_${step.kind}`,
    event: { stage: step.phase || null, actor_id, actor_type: needsModel ? 'scripted_agent' : 'orchestrator', kind: kindMap[step.kind], reply_to: replyTo, target_actor: step.target_seat != null ? `M${step.target_seat}` : (step.human ? last?.actor_id : null), target_ref: sec ? `section:${sec.key}` : null, group_id: step.group != null ? `G${step.group + 1}` : null, stage: step.phase || null },
    prompt: needsModel ? seminarPrompt(step, { roles: ROLES, corpus, seatRole: roleKey, body, section: sec, history, modeName: plan.mode_name, feedbackText, materials: mats, kp, notes: st.kp_notes?.[step.kp] }) : null,
    parse: producesSection ? (text) => parseSectionOutput(sec, text) : null,
    eventExtra: (text) => ({ ideology_terms: JSON.stringify(matchTerms(text, terms).slice(0, 12)) }),
    demoText: () => {
      if (step.human) {
        // answer the teacher's question from the imported materials / knowledge points; say so when there is no basis
        const a = answerFromMaterials(humanText || '', mats, kps);
        return `${a.text}${a.grounded ? '' : '（已记录为待核查事项）'}`;
      }
      if (kp) return `${demoKnowledgeLine(step.kind, kp, st.kp_notes?.[kp.id] || {}, ROLES[roleKey])}${cite}`;
      if (['discuss', 'vote'].includes(step.kind)) return `${demoSeminarLine(step, { roles: ROLES, seatRole: roleKey, issues, progress, body, digests })}${cite}`;
      return demoSeminarLine(step, { later: plan.phases?.includes('finalize'), roles: ROLES, seatRole: roleKey, body, sectionTitle: sec?.title, ownerRole: seats[plan.owners[sec?.key]], issues, assignments, progress, feedback: feedbackText ? '已导入课堂反馈' : null, digests });
    },
    demoApply: producesSection ? () => {
      if (step.kind === 'reflect') return reviseWithFeedback(sec, body, reference?.type === 'classroom_feedback' ? reference : null) || demoRevise(sec);
      if (step.kind !== 'draft') return demoRevise(sec);
      const hasContent = sec.kind === 'text' ? !!String(sec.content || '').trim() : (sec.rows || []).length > 0;
      // Revising an existing artifact keeps the teacher's content; otherwise build from the discussed knowledge points.
      return hasContent && (cfg.base_artifact_id || (cfg.task === 'generate' && reference?.type === body.template?.key)) ? { content: sec.content, rows: sec.rows } : skeletonSection(sec, { ...body, kp_notes: st.kp_notes || body.kp_notes }, digests);
    } : null,
    challenge: step.kind === 'challenge' || step.kind === 'question' ? { open: true, target_actor: `M${step.target_seat}`, target_ref: `section:${sec?.key}` } : step.kind === 'response' || step.kind === 'answer' ? { respond: true, target_ref: `section:${sec?.key}` } : step.kind === 'revision' && sec ? { revise: true, target_ref: `section:${sec.key}` } : null,
    commit: (ev, parsed) => {
      const s2 = json(one(db, 'SELECT state FROM runs WHERE run_id=?', r.run_id).state);
      if (parsed && sec) {
        const target = s2.body.sections.find((x) => x.key === sec.key);
        if (target.kind === 'text') target.content = parsed.content; else target.rows = parsed.rows;
        target.author = `${ROLES[roleKey].name}（${actor_id}）`; target.revision = (target.revision || 0) + 1; target.last_event_id = ev.event_id;
        if (ev.source === 'model') s2.body.ai_assisted = true;
      }
      if (kp) { s2.kp_notes = s2.kp_notes || {}; s2.kp_notes[kp.id] = { ...(s2.kp_notes[kp.id] || {}), [step.kind]: ev.text, source: ev.source }; }
      if (step.extra) s2.extra.shift(); else s2.cursor++;
      delete s2.failed_call;
      if (finalizes) {
        s2.body.notice = s2.body.ai_assisted ? 'AI 辅助草案，须经教师审核后使用。' : (s2.body.knowledge?.length ? '本地规则生成：内容依据导入材料抽取与组织（未调用大模型），出处已标注，须教师审核。' : '本地规则生成（未调用大模型，未导入材料，含待补充项），须教师补充与审核。');
        if (s2.kp_notes) s2.body.kp_notes = s2.kp_notes;
        if (cfg.task === 'regen') {
          // not reached: regen plans have no integrate step
        }
        const a = createArtifact(db, { user_id: r.owner_id }, { module: 'seminar', type: body.template?.key || cfg.type, title: cfg.title || `${getTemplate(db, 'artifact', body.template?.key || cfg.type).name}·${body.course?.unit || ''}`,
          body: s2.body, parent_id: cfg.base_artifact_id || (reference && reference.type === (body.template?.key || cfg.type) ? reference.artifact_id : null), source_run_id: r.run_id, origin: r.exec_mode === 'model' ? 'model_generated_draft' : 'demo_skeleton_draft' });
        run(db, 'UPDATE runs SET output_artifact_id=? WHERE run_id=?', a.artifact_id, r.run_id);
      }
      if (cfg.task === 'regen' && s2.cursor >= plan.steps.length && !s2.extra.length) {
        // Partial regeneration: apply only the regenerated section to the target artifact (saved → new draft version).
        const target = rowToArtifact(one(db, 'SELECT * FROM artifacts WHERE artifact_id=?', cfg.target_artifact_id));
        const newBody = { ...target.body, sections: target.body.sections.map((x) => (x.key === sec.key ? s2.body.sections.find((y) => y.key === sec.key) : x)), ai_assisted: target.body.ai_assisted || s2.body.ai_assisted };
        const a = updateArtifact(db, { user_id: r.owner_id }, target.artifact_id, { body: newBody });
        run(db, 'UPDATE runs SET output_artifact_id=? WHERE run_id=?', a.artifact_id, r.run_id);
      }
      run(db, 'UPDATE runs SET state=? WHERE run_id=?', JSON.stringify(s2), r.run_id);
    },
  };
  return out;
}

// ---------- classroom step ----------
function prepareClassroomStep(db, r) {
  const cfg = json(r.config), plan = json(r.plan), st = json(r.state);
  const profiles = all(db, 'SELECT * FROM agent_profiles WHERE run_id=?', r.run_id);
  const students = profiles.filter((p) => p.kind === 'student_agent').map((p) => ({ agent_id: p.agent_id, name: p.name, group_id: p.group_id, seat: p.seat, traits: json(p.traits) }));
  const names = Object.fromEntries(profiles.map((p) => [p.agent_id, p.name]));
  const lastEv = one(db, 'SELECT * FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT 1', r.run_id);
  // A failed model call leaves the chosen act pending: retry the same act (same scheduler decision).
  let act, decision, schedState;
  if (st.pending_act) { act = st.pending_act.act; decision = st.pending_act.decision; schedState = st.sched; }
  else {
    schedState = st.sched;
    const res = sched.step(schedState, { students, stages: plan.stages, config: cfg, last: lastEv ? { event_id: lastEv.event_id, actor_id: lastEv.actor_id, actor_type: lastEv.actor_type, kind: lastEv.kind, human_role: lastEv.human_role, target_actor: lastEv.target_actor } : null });
    act = res.act; decision = res.decision;
    if (act.who === 'end') { st.sched = schedState; run(db, 'UPDATE runs SET state=? WHERE run_id=?', JSON.stringify(st), r.run_id); return { end: true, reason: act.reason }; }
    st.pending_act = { act, decision }; st.sched = schedState;
    run(db, 'UPDATE runs SET state=? WHERE run_id=?', JSON.stringify(st), r.run_id);
  }
  const stage = plan.stages.find((s) => s.key === act.stage) || plan.stages[0];
  act.target_name = act.target_actor ? (names[act.target_actor] || (String(act.target_actor).startsWith('H-') ? '这位同学' : '')) : '';
  const isStudent = act.who === 'student', isSilence = act.who === 'system';
  const actor_id = isStudent ? act.agent_id : isSilence ? 'SYS' : 'T';
  const student = isStudent ? students.find((s) => s.agent_id === act.agent_id) : null;
  const memory = (st.memory || {})[actor_id] || [];
  const publicHistory = all(db, 'SELECT actor_id, text FROM events WHERE run_id=? ORDER BY sequence DESC LIMIT 6', r.run_id).reverse();
  const u = sched.rngNext({ rng: (schedState.rng ^ 0x9e3779b9) >>> 0 });
  const kind = KIND_OF[act.action] || 'observation';
  const terms = ideologyTerms(json(r.input_snapshot)?.body?.course);
  const durationOf = (text) => (act.who === 'student' ? Math.min(60000, Math.max(6000, sched.speechMs(text))) : isSilence ? act.sim_ms : Math.max(act.sim_ms || 0, sched.speechMs(text)));
  return {
    needsModel: !isSilence, actor_id, kind, purpose: `classroom_${act.who}_${act.action}`,
    decision: decision ? { ...decision } : null,
    event: { actor_id, actor_type: isSilence ? 'system' : 'scripted_agent', kind, reply_to: act.target_event_id || null, target_actor: act.target_actor || null, group_id: act.group_id || null, stage: stage.key },
    prompt: isSilence ? null : classroomPrompt(act, { stage, student, memory, publicHistory, unitLabel: plan.unit_label, names, segment: stage.segments?.[act.segment] }),
    eventExtra: (text) => ({ class_clock_ms: act.class_clock_ms ?? null, sim_duration_ms: act.sim_ms == null ? null : durationOf(text), ideology_terms: JSON.stringify(matchTerms(text, terms).slice(0, 12)) }),
    demoText: () => demoClassLine(act, stage, names, u, { lastText: lastEv?.text, knowledge: plan.knowledge || [] }),
    challenge: act.action === 'challenge' ? { open: true, target_actor: act.target_actor, target_ref: act.target_event_id ? `event:${act.target_event_id}` : `stage:${stage.key}` } : null,
    commit: (ev) => {
      const s2 = json(one(db, 'SELECT state FROM runs WHERE run_id=?', r.run_id).state);
      delete s2.pending_act; delete s2.failed_call;
      // the simulated clock advanced by the nominal time at decision; correct it to the actual utterance length
      if (ev.sim_duration_ms != null && act.sim_ms != null && s2.sched?.clock_ms != null) s2.sched.clock_ms += ev.sim_duration_ms - act.sim_ms;
      s2.memory = s2.memory || {};
      if (!isSilence) { const m = s2.memory[actor_id] || []; m.push(ev.text.slice(0, 120)); s2.memory[actor_id] = m.slice(-3); } // local memory only
      run(db, 'UPDATE runs SET state=? WHERE run_id=?', JSON.stringify(s2), r.run_id);
    },
  };
}

// ---------- read models ----------
export function runView(db, user, runId, { after = 0 } = {}) {
  const r = getRunRow(db, user, runId);
  const events = all(db, 'SELECT * FROM events WHERE run_id=? AND sequence>? ORDER BY sequence', runId, Number(after) || 0);
  const profiles = all(db, 'SELECT agent_id, kind, name, role, seat, group_id, avatar, traits FROM agent_profiles WHERE run_id=? ORDER BY seat', runId).map((p) => ({ ...p, traits: json(p.traits) }));
  const st = json(r.state) || {};
  const out = { run: publicRun(db, r), profiles, events, stats: runStats(db, r) };
  if (r.module === 'seminar') { const plan = json(r.plan); out.plan = { steps: plan.steps, mode_name: plan.mode_name, cursor: st.cursor, pending_extra: (st.extra || []).length }; out.working_body = st.body; }
  else {
    const plan = json(r.plan), cfg = json(r.config);
    out.stages = plan.stages; out.unit_label = plan.unit_label; out.stage_idx = st.sched?.stage_idx ?? 0; out.pending_hands = (st.sched?.pending || []).map((p) => p.agent_id);
    out.phase = st.sched?.phase || 'teach'; out.groups_active = ['group', 'debate', 'report'].includes(st.sched?.phase) ? st.sched?.groups_this_round || [] : [];
    out.clock = { class_minutes: cfg.class_minutes || 45, clock_ms: st.sched?.clock_ms ?? 0, stage_start_ms: st.sched?.stage_start_ms ?? 0, budgets_ms: sched.stageBudgets(plan.stages, cfg), segment_idx: st.sched?.seg || {} };
  }
  out.ideology_terms = ideologyTerms(r.module === 'seminar' ? st.body?.course : json(r.input_snapshot)?.body?.course);
  out.challenges = all(db, 'SELECT * FROM challenges WHERE run_id=? ORDER BY opened_at', runId);
  return out;
}

export function publicRun(db, r) {
  const resv = r.reservation_id ? one(db, 'SELECT amount, used, inflight, status FROM reservations WHERE reservation_id=?', r.reservation_id) : null;
  const cfg = json(r.config);
  return { run_id: r.run_id, module: r.module, exec_mode: r.exec_mode, status: r.status, input_artifact_id: r.input_artifact_id, output_artifact_id: r.output_artifact_id,
    config: cfg, seed: r.seed, budget_calls: r.budget_calls, rate: r.rate, pricing_version: r.pricing_version, model_calls: r.model_calls, reservation: resv,
    created_at: r.created_at, started_at: r.started_at, ended_at: r.ended_at, paused_ms: r.paused_ms, paused_at: r.paused_at, has_human: !!r.has_human, stop_reason: r.stop_reason,
    wall_duration_ms: r.started_at ? (r.ended_at ? Date.parse(r.ended_at) : Date.now()) - Date.parse(r.started_at) : null };
}

export function runStats(db, r) {
  const ev = all(db, 'SELECT actor_id, actor_type, kind, group_id, target_actor, reply_to FROM events WHERE run_id=?', r.run_id);
  const speakers = {};
  for (const e of ev) if (e.actor_type !== 'system') speakers[e.actor_id] = (speakers[e.actor_id] || 0) + 1;
  const studentSpeakers = Object.keys(speakers).filter((k) => /^S\d+/.test(k));
  const groups = Object.fromEntries(all(db, 'SELECT agent_id, group_id FROM agent_profiles WHERE run_id=?', r.run_id).map((p) => [p.agent_id, p.group_id]));
  let crossGroup = 0;
  for (const e of ev) if (e.target_actor && groups[e.actor_id] && groups[e.target_actor] && groups[e.actor_id] !== groups[e.target_actor]) crossGroup++;
  const count = (k) => ev.filter((e) => e.kind === k).length;
  const active = r.started_at ? ((r.ended_at ? Date.parse(r.ended_at) : r.paused_at ? Date.parse(r.paused_at) : Date.now()) - Date.parse(r.started_at) - r.paused_ms) : 0;
  return { n_events: ev.length, n_participants: studentSpeakers.length, speakers, questions: count('question'), challenges: count('challenge'), revisions: count('revision'),
    responses: count('response'), silences: count('silence'), human_turns: ev.filter((e) => e.actor_type === 'human').length, cross_group_interactions: crossGroup, active_ms: Math.max(0, active) };
}

export function listRuns(db, user, module) {
  return all(db, `SELECT * FROM runs WHERE owner_id=? ${module ? 'AND module=?' : ''} ORDER BY created_at DESC LIMIT 100`, ...(module ? [user.user_id, module] : [user.user_id])).map((r) => publicRun(db, r));
}

/** Classroom → feedback artifact (compiled from actual events; no model call; labelled as simulation). */
export function classroomFeedback(db, user, runId) {
  const r = getRunRow(db, user, runId);
  check(r.module === 'classroom', 400, 'bad_module', '仅演课场可生成课堂反馈');
  check(['completed', 'paused', 'cancelled'].includes(r.status), 409, 'bad_state', '请先暂停或结束课堂');
  const ev = all(db, 'SELECT * FROM events WHERE run_id=? ORDER BY sequence', runId);
  const stats = runStats(db, r);
  const names = Object.fromEntries(all(db, 'SELECT agent_id, name FROM agent_profiles WHERE run_id=?', runId).map((p) => [p.agent_id, p.name]));
  const answered = new Set(ev.filter((e) => e.reply_to && e.actor_id === 'T' && e.kind === 'response').map((e) => e.reply_to));
  const open = ev.filter((e) => ['question', 'challenge', 'clarify'].includes(e.kind) && e.actor_id !== 'T' && !answered.has(e.event_id)).slice(0, 20);
  const deferred = ev.filter((e) => e.kind === 'defer');
  const input = json(r.input_snapshot);
  const body = emptyBody(db, { type: 'classroom_feedback' });
  const set = (k, v) => { const s = body.sections.find((x) => x.key === k); if (s.kind === 'text') s.content = v; else s.rows = v; };
  set('summary', `输入方案：${input.title}（v${input.version}，${input.artifact_id}）。执行模式：${r.exec_mode === 'model' ? '真实模型' : '预设演示'}。共 ${stats.n_events} 条事件，${stats.n_participants} 名模拟学生发言，提问 ${stats.questions}、质疑 ${stats.challenges}、沉默 ${stats.silences}、真人发言 ${stats.human_turns}。`);
  const vt0 = valueTalk(ev);
  body.sections.find((x) => x.key === 'summary').content += vt0.total ? `思政相关发言 ${vt0.total} 条（学生 ${vt0.students} 条）：说理式 ${vt0.reasoned} 条、口号式 ${vt0.slogan} 条（按是否给出依据、后果或取舍理由做启发式判断，需人工复核）。` : '';
  set('open_issues', open.map((e) => ({ issue: `${names[e.actor_id] || '真人'}：${e.text.slice(0, 200)}`, event_id: e.event_id })));
  set('suggestions', [...deferred.map((e) => ({ suggestion: `课中暂存的问题需要在教案中安排回应时机：${e.text.slice(0, 120)}`, basis_event_id: e.event_id })),
    ...(stats.challenges ? [{ suggestion: '质疑集中出现的环节，考虑补充依据材料或案例来源。', basis_event_id: ev.find((e) => e.kind === 'challenge')?.event_id || '' }] : [])].slice(0, 20));
  const plan = json(r.plan), segDone = json(r.state)?.sched?.seg || {};
  set('timing', plan.stages.map((s, i) => {
    const es = ev.filter((e) => e.stage === s.key && e.class_clock_ms != null);
    const sim = es.length ? (Math.max(...es.map((e) => e.class_clock_ms + (e.sim_duration_ms || 0))) - Math.min(...es.map((e) => e.class_clock_ms))) / 60000 : 0;
    return { stage: s.label, planned: String(s.minutes ?? ''), simulated: String(Math.round(sim * 10) / 10), lecture: `${Math.min(segDone[i] || 0, s.segments?.length || 0)}/${s.segments?.length || 0}`, ideology: String(es.filter((e) => e.ideology_terms && e.ideology_terms !== '[]').length) };
  }));
  const over = plan.stages.filter((s, i) => { const t = body.sections.find((x) => x.key === 'timing').rows[i]; return s.minutes && Number(t.simulated) > s.minutes * 1.3; });
  const reached = plan.stages.map((s) => ev.some((e) => e.stage === s.key));
  const firstMissing = reached.indexOf(false);
  const unfinished = plan.stages.filter((s, i) => reached[i] && (segDone[i] || 0) < (s.segments?.length || 0));
  const sug = body.sections.find((x) => x.key === 'suggestions').rows;
  for (const s of over) sug.push({ suggestion: `「${s.label}」模拟用时明显超过计划（${s.minutes} 分钟），可精简讲解或把讨论移到课后`, basis_event_id: '' });
  for (const s of unfinished) sug.push({ suggestion: `「${s.label}」的讲解内容未讲完，建议压缩要点或调整课时分配`, basis_event_id: '' });
  if (firstMissing >= 0) sug.push({ suggestion: `课堂在进行到「${plan.stages[firstMissing].label}」之前结束（共 ${plan.stages.length - firstMissing} 个环节未进行），以下环节的用时为 0 不代表设计问题`, basis_event_id: '' });
  const vt = valueTalk(ev);
  if (!ev.some((e) => e.ideology_terms && e.ideology_terms !== '[]')) sug.push({ suggestion: '整节课没有出现课程思政相关表述，建议在教案中设计具体的价值冲突情境与提问', basis_event_id: '' });
  else if (vt.slogan > vt.reasoned) sug.push({ suggestion: `思政相关发言以口号式为主（口号式 ${vt.slogan} 条、说理式 ${vt.reasoned} 条）：建议把价值要求落到一次专业判断上，追问“依据是什么、会影响谁、代价是什么”`, basis_event_id: vt.firstSlogan || '' });
  else if (vt.students === 0) sug.push({ suggestion: '思政相关表述都来自教师，学生没有就价值问题发表看法；建议设计需要学生表态并说明理由的任务', basis_event_id: '' });
  set('boundary', '本反馈由演课场事件自动汇编，未调用模型、未评估真实学习效果；模拟学生不是真实样本，发言分布不代表真实学情。');
  body.course = input.body?.course || {};
  const a = createArtifact(db, user, { module: 'classroom', type: 'classroom_feedback', title: `课堂反馈·${input.title}`, body, source_run_id: runId, origin: 'compiled_from_events', parent_id: null });
  return a;
}

/** 价值表达的启发式分类：含思政词且给出依据/后果/取舍的为“说理式”，否则为“口号式”。 */
export function valueTalk(ev) {
  const REASON = /因为|所以|如果|否则|依据|根据|标准|规范要求|数据|后果|影响|例如|比如|权衡|取舍|代价|风险|会导致|意味着|GB|条款|案例/;
  const vs = ev.filter((e) => e.ideology_terms && e.ideology_terms !== '[]' && e.actor_type !== 'system');
  const reasoned = vs.filter((e) => REASON.test(e.text) && e.text.length >= 20);
  const slogan = vs.filter((e) => !reasoned.includes(e));
  return { total: vs.length, reasoned: reasoned.length, slogan: slogan.length, students: vs.filter((e) => e.actor_id !== 'T' && e.actor_type !== 'human').length, firstSlogan: slogan[0]?.event_id };
}

/** Periodic reconciliation: orphaned calls, stale runs, ended runs with open reservations. */
export function reconcile(db, { startup = false } = {}) {
  const report = { failed_calls: 0, released: 0, stale_paused: 0 };
  const cutoff = new Date(Date.now() - (startup ? 0 : 10 * 60e3)).toISOString();
  for (const c of all(db, "SELECT * FROM model_calls WHERE status='pending' AND request_at < ?", cutoff)) {
    run(db, "UPDATE model_calls SET status='failed', error_code='interrupted', error_message='服务重启或调用中断，未产生有效输出，未扣分', completed_at=? WHERE call_id=?", now(), c.call_id);
    if (c.reservation_id) failCall(db, c.reservation_id, c.call_id);
    const r = one(db, 'SELECT state FROM runs WHERE run_id=?', c.run_id);
    if (r) { const st = json(r.state) || {}; st.failed_call = c.call_id; run(db, 'UPDATE runs SET state=? WHERE run_id=?', JSON.stringify(st), c.run_id); }
    report.failed_calls++;
  }
  for (const r of all(db, "SELECT r.* FROM runs r JOIN reservations v ON v.reservation_id=r.reservation_id WHERE v.status='open' AND r.status IN ('completed','cancelled','failed')")) {
    releaseReservation(db, r.reservation_id, '对账释放'); report.released++;
  }
  const staleMin = Number(getSetting(db, 'stale_run_minutes'));
  const staleCut = new Date(Date.now() - staleMin * 60e3).toISOString();
  for (const r of all(db, "SELECT * FROM runs WHERE status IN ('running','awaiting_human','paused') AND COALESCE(last_activity_at, started_at) < ? AND reservation_id IS NOT NULL", staleCut)) {
    const v = one(db, 'SELECT status FROM reservations WHERE reservation_id=?', r.reservation_id);
    if (v?.status === 'open') {
      if (r.status !== 'paused') run(db, "UPDATE runs SET status='paused', paused_at=?, stop_reason='stale_released' WHERE run_id=?", now(), r.run_id);
      releaseReservation(db, r.reservation_id, '长时间未活动释放'); report.stale_paused++;
    }
  }
  if (startup) for (const r of all(db, "SELECT run_id FROM runs WHERE status IN ('running','awaiting_human')")) run(db, "UPDATE runs SET status='paused', paused_at=?, stop_reason='server_restart' WHERE run_id=?", now(), r.run_id);
  return report;
}

/** Pause all active runs of a (disabled) user and release their reservations. */
export function stopUserRuns(db, admin, userId) {
  for (const r of all(db, "SELECT * FROM runs WHERE owner_id=? AND status IN ('running','awaiting_human','paused','ready')", userId)) endRun(db, null, r.run_id, 'cancelled', 'account_disabled');
  audit(db, { actor: admin, action: 'user_runs_stopped', target_type: 'user', target_id: userId });
}

export { ACTION_LABEL };


/** Rule-based knowledge discussion lines (no model): everything is taken from the knowledge point and its source. */
function demoKnowledgeLine(kind, kp, notes, role = {}) {
  switch (kind) {
    case 'kp_view': {
      const t = role.title || role.name || '';
      if (/行业/.test(t)) return `从岗位现场看，「${kp.term}」${kp.example ? `就像${kp.example.replace(/^例如[，,]?/, '')}` : '是检验、装配时每天都要用到的判断依据'}。建议在课上给出一份真实的检验记录或作业指导书片段，让学生按岗位规范完成一次判定，并说明依据。`;
      if (/青年/.test(t)) return `我刚教这部分时发现，学生能背出「${kp.term}」的定义，但换个场景就不会用。建议讲完后立刻安排 2 分钟的小练习，当场暴露误区；${kp.difficulty?.includes('混淆') ? '把容易混淆的概念并排比较效果最好。' : '练习题尽量来自材料中的例子。'}`;
      return `从${t}的角度（${role.duty || '本人职责'}）补充：「${kp.term}」${kp.definition ? `的关键在“${kp.definition.slice(0, 24)}${kp.definition.length > 24 ? '…' : ''}”` : ''}，建议在教学中${role.prompt ? '按照我的教学习惯' : ''}先讲清适用条件，再用一个本专业的真实任务检验学生是否会用。`;
    }
    case 'kp_explain': return `「${kp.term}」：${kp.definition}。${kp.key_sentences?.[0] ? `${kp.key_sentences[0]}` : ''}${kp.example ? ` ${kp.example}` : ''}（出处：${kp.source}）`;
    case 'kp_difficulty': return `从学生角度看，${kp.difficulty}。建议${kp.example ? '先用材料中的例子引入' : '先给一个具体的专业场景'}，再让学生自己说出定义中的关键条件，最后做对比辨析。`;
    case 'kp_ideology': return `「${kp.term}」可以这样融入（${kp.ideology.category_name}）：${kp.ideology.suggestion}。关键是让学生在专业判断中给出理由，而不是记口号。`;
    case 'kp_item': return `检测题（${kp.question.qtype}）：${kp.question.stem}${kp.question.options ? `\n${kp.question.options}` : ''}\n参考答案：${kp.question.answer}。配套案例题：${kp.case_question.stem.slice(0, 70)}……评分：${kp.case_question.rubric}`;
    case 'kp_check': return `核查：定义出自${kp.source}${kp.kind === 'heading' ? '，但材料中没有明确的定义句，建议教师补充规范定义' : '，与讲解一致'}；思政融入中的${['mission', 'law', 'culture'].includes(kp.ideology.category) ? '事实、数据和法规出处需要核实后再使用' : '情境是设计性内容，不引用未经核实的真实案例数据'}；检测题答案可由材料原文直接支持。`;
    case 'kp_decide': return `定稿「${kp.term}」：讲解抓住“${kp.definition.slice(0, 28)}${kp.definition.length > 28 ? '…' : ''}”；难点对策：${kp.difficulty.includes('混淆') ? '对比辨析' : '配合实例'}；思政以“${kp.ideology.category_name}”切入；检测采用上面的${kp.question.qtype}题。已写入知识点图谱。`;
    default: return '';
  }
}
