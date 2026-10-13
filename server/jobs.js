// Task pipeline: after the teacher imports course content, the server executes the follow-up tasks in order and
// keeps every result — analyse → knowledge-point seminar → knowledge map → other outputs → simulated class →
// classroom feedback → revision. Runs server-side (continues if the page is closed); supports pause / resume / cancel.
import { one, all, run, id, now, tx, check, fail, audit, json, getSetting, HttpError } from './db.js';
import { getTemplate } from './templates.js';
import * as runs from './runs.js';
import * as art from './artifacts.js';
import { loadMaterials, MATERIAL_KINDS } from './materials.js';
import { analyzeMaterials } from './knowledge.js';
import { knowledgeSection } from './kgen.js';
import { balance } from './credits.js';
import { normalizeConfig } from './scheduler.js';

export const OUTPUT_TYPES = ['lesson_plan', 'courseware', 'syllabus', 'course_design', 'semester_plan', 'teaching_schedule', 'exercises', 'exam', 'talent_plan'];
const RUNNABLE = ['lesson_plan', 'courseware', 'exercises', 'exam'];
const active = new Map(); // job_id → { stop }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS jobs(
    job_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, config TEXT NOT NULL, steps TEXT NOT NULL,
    cursor INTEGER NOT NULL DEFAULT 0, current_run_id TEXT, analysis TEXT, error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT)`);
  // a server restart interrupts the worker: running jobs become paused and can be resumed
  run(db, "UPDATE jobs SET status='paused', error='服务重启后已暂停，可继续执行' WHERE status='running'");
}

function normalize(db, user, input) {
  const outputs = [...new Set((Array.isArray(input.outputs) && input.outputs.length ? input.outputs : ['lesson_plan']).filter((t) => OUTPUT_TYPES.includes(t)))];
  check(outputs.length, 400, 'bad_outputs', '请选择至少一项要生成的成果');
  const mats = loadMaterials(db, user, input.material_ids);
  check(mats.length, 400, 'no_materials', '请先导入课程内容（上传讲义、大纲等文件，或粘贴文字）');
  const class_minutes = [15, 25, 45, 50, 90].includes(Number(input.class_minutes)) ? Number(input.class_minutes) : 45;
  return {
    material_ids: mats.map((m) => m.material_id), outputs, primary: outputs[0], class_minutes,
    kp_ids: Array.isArray(input.kp_ids) ? input.kp_ids.slice(0, 8) : null, kp_limit: Math.min(Math.max(Number(input.kp_limit) || 4, 1), 8),
    classroom: input.classroom !== false && RUNNABLE.includes(outputs[0]), revise: input.revise !== false && input.classroom !== false && RUNNABLE.includes(outputs[0]),
    exec_mode: input.exec_mode === 'model' ? 'model' : 'demo', framework_key: input.framework_key === undefined ? 'boppps' : input.framework_key || null,
    course: Object.fromEntries(Object.entries(input.course || {}).filter(([, v]) => v !== '' && v != null)), class_size: [24, 40, 120, 300].includes(Number(input.class_size)) ? Number(input.class_size) : 40,
    pace: input.pace === 'watch' ? 'watch' : 'fast', title: String(input.title || '').slice(0, 80), seats: input.seats,
    class_profile_id: typeof input.class_profile_id === 'string' && one(db, 'SELECT 1 FROM class_profiles WHERE profile_id=? AND owner_id=?', input.class_profile_id, user.user_id) ? input.class_profile_id : null,
  };
}

function buildSteps(db, cfg) {
  const name = (t) => getTemplate(db, 'artifact', t)?.name || t;
  const steps = [{ key: 'analyze', label: '解析课程内容：课程信息与知识点' },
    { key: 'discuss', type: cfg.primary, label: `知识点研讨，生成「${name(cfg.primary)}」` },
    { key: 'map', label: '整理「课程知识点与思政融入图谱」' },
    ...cfg.outputs.slice(1).map((t) => ({ key: 'generate', type: t, label: `生成「${name(t)}」` }))];
  if (cfg.classroom) steps.push({ key: 'classroom', label: `模拟上课（${cfg.class_minutes} 分钟）` }, { key: 'feedback', label: '生成课堂反馈' });
  if (cfg.revise) steps.push({ key: 'revise', type: cfg.primary, label: `依据课堂反馈修订「${name(cfg.primary)}」` });
  return steps.map((s) => ({ ...s, status: 'pending', run_id: null, artifact_ids: [], message: '' }));
}

function seminarInput(cfg, job, extra) {
  return { module: 'seminar', exec_mode: cfg.exec_mode, material_ids: cfg.material_ids, kp_ids: cfg.kp_ids || undefined, kp_limit: cfg.kp_limit,
    framework_key: cfg.framework_key, course: { ...cfg.course, lesson_minutes: cfg.class_minutes }, seats: cfg.seats, human_reply_budget: 0, class_profile_id: cfg.class_profile_id || undefined, ...extra };
}

/** Upper bound of model calls/credits for the whole pipeline (0 in local mode). */
export function estimateJob(db, user, input) {
  const cfg = normalize(db, user, input);
  const steps = buildSteps(db, cfg);
  const cap = Number(getSetting(db, 'max_calls_per_task'));
  let calls = 0, rate = 0;
  if (cfg.exec_mode === 'model') {
    for (const s of steps) {
      if (s.key === 'discuss') { const e = runs.estimate(db, user, seminarInput(cfg, null, { type: s.type, mode: 'full', human_reply_budget: 3 })); calls += e.max_calls; rate = e.rate; }
      if (s.key === 'generate') calls += runs.estimate(db, user, seminarInput(cfg, null, { type: s.type, mode: 'cooperate' })).max_calls;
      if (s.key === 'classroom') calls += Math.min(normalizeConfig({ class_minutes: cfg.class_minutes }).max_turns, cap);
      if (s.key === 'revise') calls += (getTemplate(db, 'artifact', s.type)?.body.sections.length || 6) + 2;
    }
  }
  const mats = loadMaterials(db, user, cfg.material_ids);
  const a = analyzeMaterials(mats);
  return { steps: steps.map((s) => s.label), exec_mode: cfg.exec_mode, max_calls: calls, max_credits: calls * rate, rate, balance: balance(db, user.user_id),
    analysis: { course: a.course, stats: a.stats, knowledge_points: a.knowledge_points.map((k) => ({ id: k.id, term: k.term, definition: k.definition, kind: k.kind, source: k.source, ideology: k.ideology.category_name })) } };
}

export function createJob(db, user, input) {
  const e = estimateJob(db, user, input);
  if (e.exec_mode === 'model') check(e.balance.available >= e.max_credits, 409, 'insufficient_credits', `可用积分 ${e.balance.available}，本次任务预计最多需要 ${e.max_credits} 积分`);
  const cfg = normalize(db, user, input);
  const job_id = id('job');
  run(db, 'INSERT INTO jobs(job_id,owner_id,status,config,steps,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', job_id, user.user_id, 'running', JSON.stringify(cfg), JSON.stringify(buildSteps(db, cfg)), now(), now());
  audit(db, { actor: user, action: 'job_created', target_type: 'job', target_id: job_id, detail: { outputs: cfg.outputs, exec_mode: cfg.exec_mode } });
  startWorker(db, job_id);
  return jobView(db, user, job_id);
}

export function jobView(db, user, jobId) {
  const j = one(db, 'SELECT * FROM jobs WHERE job_id=? AND owner_id=?', jobId, user.user_id);
  if (!j) fail(404, 'not_found', '任务不存在');
  const steps = json(j.steps);
  const ids = steps.flatMap((s) => s.artifact_ids);
  const arts = Object.fromEntries(ids.map((aid) => { const a = one(db, 'SELECT artifact_id,title,type,version,module,status FROM artifacts WHERE artifact_id=?', aid); return [aid, a]; }));
  return { job_id: j.job_id, status: j.status, config: json(j.config), steps: steps.map((s) => ({ ...s, artifacts: s.artifact_ids.map((x) => arts[x]).filter(Boolean) })),
    cursor: j.cursor, current_run_id: j.current_run_id, analysis: json(j.analysis), error: j.error, created_at: j.created_at, updated_at: j.updated_at, ended_at: j.ended_at };
}
export const listJobs = (db, user) => all(db, 'SELECT job_id FROM jobs WHERE owner_id=? ORDER BY created_at DESC LIMIT 20', user.user_id).map((r) => jobView(db, user, r.job_id));

export function setJobStatus(db, user, jobId, action) {
  const j = one(db, 'SELECT * FROM jobs WHERE job_id=? AND owner_id=?', jobId, user.user_id);
  check(j, 404, 'not_found', '任务不存在');
  if (action === 'pause') {
    check(j.status === 'running', 409, 'bad_state', '任务未在执行');
    run(db, "UPDATE jobs SET status='paused', updated_at=? WHERE job_id=?", now(), jobId);
    if (j.current_run_id) { try { runs.pauseRun(db, { user_id: user.user_id }, j.current_run_id, 'job_paused'); } catch { /* run may be between states */ } }
  } else if (action === 'resume') {
    check(['paused', 'failed'].includes(j.status), 409, 'bad_state', '任务不能继续');
    run(db, "UPDATE jobs SET status='running', error=NULL, updated_at=? WHERE job_id=?", now(), jobId);
    startWorker(db, jobId);
  } else if (action === 'cancel') {
    check(!['completed', 'cancelled'].includes(j.status), 409, 'bad_state', '任务已结束');
    run(db, "UPDATE jobs SET status='cancelled', ended_at=?, updated_at=? WHERE job_id=?", now(), now(), jobId);
    if (j.current_run_id) { try { runs.endRun(db, { user_id: user.user_id }, j.current_run_id, 'cancelled', 'job_cancelled'); } catch { /* already ended */ } }
  } else fail(400, 'bad_action', '无效操作');
  audit(db, { actor: user, action: `job_${action}`, target_type: 'job', target_id: jobId });
  return jobView(db, user, jobId);
}

// ---------------- worker ----------------
function startWorker(db, jobId) {
  if (active.has(jobId)) return;
  const handle = { stopped: false };
  active.set(jobId, handle);
  work(db, jobId).catch((e) => { console.error('job', jobId, e); try { run(db, "UPDATE jobs SET status='failed', error=?, updated_at=? WHERE job_id=?", String(e.message || e).slice(0, 300), now(), jobId); } catch { /* db closed */ } })
    .finally(() => active.delete(jobId));
}
export const stopAllWorkers = (db) => { if (db) db._closing = true; for (const h of active.values()) h.stopped = true; };

async function work(db, jobId) {
  for (;;) {
    if (db._closing) return;
    const j = one(db, 'SELECT * FROM jobs WHERE job_id=?', jobId);
    if (!j || j.status !== 'running') return;
    const steps = json(j.steps), cfg = json(j.config);
    if (j.cursor >= steps.length) { run(db, "UPDATE jobs SET status='completed', ended_at=?, updated_at=?, current_run_id=NULL WHERE job_id=?", now(), now(), jobId); return; }
    const user = one(db, 'SELECT * FROM users WHERE user_id=?', j.owner_id);
    if (!user || user.status !== 'active') { run(db, "UPDATE jobs SET status='paused', error='账号不可用' WHERE job_id=?", jobId); return; }
    const step = steps[j.cursor];
    step.status = 'running'; save(db, jobId, steps);
    let result;
    try { result = await execStep(db, user, j, cfg, steps, step); }
    catch (e) {
      const msg = e instanceof HttpError ? e.message : `执行出错：${e.message}`;
      step.status = 'error'; step.message = msg; save(db, jobId, steps);
      // model/budget problems pause the job (resumable); results already produced are kept
      run(db, `UPDATE jobs SET status=?, error=?, updated_at=? WHERE job_id=?`, e instanceof HttpError && [409, 502].includes(e.status) ? 'paused' : 'failed', msg, now(), jobId);
      return;
    }
    if (result === 'interrupted') return; // paused or cancelled mid-step; resume continues this step
    step.status = 'done'; save(db, jobId, steps);
    run(db, 'UPDATE jobs SET cursor=cursor+1, current_run_id=NULL, updated_at=? WHERE job_id=?', now(), jobId);
  }
}
const save = (db, jobId, steps) => run(db, 'UPDATE jobs SET steps=?, updated_at=? WHERE job_id=?', JSON.stringify(steps), now(), jobId);
const jobStatus = (db, jobId) => one(db, 'SELECT status FROM jobs WHERE job_id=?', jobId)?.status;

/** Drive one run to completion server-side; honours pause/cancel and waits while a human is typing. */
async function driveRun(db, user, jobId, runId, pace) {
  run(db, 'UPDATE jobs SET current_run_id=? WHERE job_id=?', runId, jobId);
  let r = one(db, 'SELECT * FROM runs WHERE run_id=?', runId);
  if (r.status === 'ready') runs.startRun(db, user, runId);
  else if (r.status === 'paused') runs.resumeRun(db, user, runId);
  let retries = 0;
  for (;;) {
    if (db._closing || jobStatus(db, jobId) !== 'running') return 'interrupted';
    r = one(db, 'SELECT * FROM runs WHERE run_id=?', runId);
    if (['completed', 'cancelled', 'failed'].includes(r.status)) return r.status;
    if (r.status === 'awaiting_human') { if (!runs.releaseStaleComposer(db, runId)) await sleep(500); continue; }
    if (r.status === 'paused') { runs.resumeRun(db, user, runId); continue; }
    try {
      const out = await runs.stepRun(db, user, runId, {});
      retries = 0;
      if (out.ended) return 'completed';
    } catch (e) {
      if (e.code === 'step_in_progress' || e.code === 'not_running') { await sleep(300); continue; }
      if (e.status === 502 && retries++ < 2) { await sleep(1500); continue; } // model hiccup: retry the same step (not charged)
      throw e;
    }
    await sleep(pace === 'watch' ? 1400 : 40);
  }
}

async function execStep(db, user, j, cfg, steps, step) {
  const jobId = j.job_id, done = (k) => steps.find((s) => s.key === k);
  switch (step.key) {
    case 'analyze': {
      const a = analyzeMaterials(loadMaterials(db, user, cfg.material_ids));
      run(db, 'UPDATE jobs SET analysis=? WHERE job_id=?', JSON.stringify({ course: a.course, stats: a.stats, sections: a.sections.slice(0, 30), knowledge_points: a.knowledge_points.map((k) => ({ id: k.id, term: k.term, definition: k.definition, kind: k.kind, source: k.source, ideology: k.ideology.category_name })) }), jobId);
      step.message = `识别课程「${a.course.name || '（未识别名称）'}」，${a.stats.sections} 个章节，${a.stats.knowledge_points} 个知识点（其中 ${a.stats.definitions} 个有明确定义），${a.stats.ideology_sentences} 处已有思政表述`;
      return 'ok';
    }
    case 'discuss': case 'generate': {
      if (!step.run_id) {
        const notes = step.key === 'generate' ? json(one(db, 'SELECT state FROM runs WHERE run_id=?', done('discuss').run_id)?.state)?.kp_notes : undefined;
        const r = runs.createRun(db, user, seminarInput(cfg, j, { type: step.type, mode: step.key === 'discuss' ? 'full' : 'cooperate', human_reply_budget: step.key === 'discuss' ? 3 : 0, kp_notes: notes,
          title: `${cfg.title || cfg.course.name || ''}${cfg.title || cfg.course.name ? '·' : ''}${getTemplate(db, 'artifact', step.type).name}` }));
        step.run_id = r.run_id; save(db, jobId, steps);
      }
      const res = await driveRun(db, user, jobId, step.run_id, cfg.pace);
      if (res === 'interrupted') return res;
      const out = one(db, 'SELECT output_artifact_id FROM runs WHERE run_id=?', step.run_id).output_artifact_id;
      check(out, 409, 'no_output', '研讨未产出结果');
      art.saveVersion(db, user, out, { reviewed: false });
      if (step.key === 'discuss') art.setCurrent(db, user, 'seminar', out);
      step.artifact_ids = [out];
      step.message = step.key === 'discuss' ? '已完成知识点研讨并整合为结果（已设为研课场当前产物，待教师审阅）' : '已生成（待教师审阅）';
      return 'ok';
    }
    case 'map': {
      const discussRun = one(db, 'SELECT state FROM runs WHERE run_id=?', done('discuss').run_id);
      const st = json(discussRun.state);
      const body = art.emptyBody(db, { type: 'knowledge_map', course: st.body.course });
      body.knowledge = st.body.knowledge; body.kp_notes = st.kp_notes || {};
      body.sections = body.sections.map((s) => ({ ...s, ...(knowledgeSection(s, body) || {}), author: '教研组（知识点研讨）' }));
      body.notice = cfg.exec_mode === 'model' ? 'AI 辅助草案（依据导入材料），须经教师审核。' : '本地规则生成：依据导入材料抽取与组织（未调用大模型），出处已标注，须教师审核。';
      const a = art.createArtifact(db, user, { module: 'seminar', type: 'knowledge_map', title: `${st.body.course?.name || '课程'}·知识点与思政融入图谱`, body, source_run_id: done('discuss').run_id, origin: 'knowledge_seminar', status: 'saved' });
      step.artifact_ids = [a.artifact_id];
      step.message = `${(body.knowledge || []).length} 个知识点，${Object.keys(body.kp_notes).length} 个已研讨定稿`;
      return 'ok';
    }
    case 'classroom': {
      if (!step.run_id) {
        const primary = done('discuss').artifact_ids[0];
        art.setCurrent(db, user, 'seminar', primary);
        const x = art.transfer(db, user, { from: 'seminar', idempotency_key: `job-${jobId}-in`.slice(0, 80) });
        const r = runs.createRun(db, user, { module: 'classroom', exec_mode: cfg.exec_mode, config: { class_profile_id: cfg.class_profile_id || undefined, class_minutes: cfg.class_minutes, class_size: cfg.class_size, seed: `job-${jobId.slice(-8)}`, speed: 60, ...(cfg.exec_mode === 'model' ? { max_turns: Number(getSetting(db, 'max_calls_per_task')) } : {}) } });
        step.run_id = r.run_id; step.artifact_ids = [x.target.artifact_id]; save(db, jobId, steps);
      }
      const res = await driveRun(db, user, jobId, step.run_id, cfg.pace);
      if (res === 'interrupted') return res;
      const v = runs.runView(db, user, step.run_id);
      step.message = `共 ${v.stats.n_events} 条课堂事件，${v.stats.n_participants} 名学生发言，提问 ${v.stats.questions}、质疑 ${v.stats.challenges}`;
      return 'ok';
    }
    case 'feedback': {
      const runId = done('classroom').run_id;
      const r = one(db, 'SELECT status FROM runs WHERE run_id=?', runId);
      if (!['completed', 'cancelled'].includes(r.status)) runs.endRun(db, user, runId, 'completed', 'job_class_over');
      const fb = runs.classroomFeedback(db, user, runId);
      art.saveVersion(db, user, fb.artifact_id);
      art.setCurrent(db, user, 'classroom', fb.artifact_id);
      step.artifact_ids = [fb.artifact_id];
      const sug = fb.body.sections.find((s) => s.key === 'suggestions')?.rows.length || 0;
      step.message = `${fb.body.sections.find((s) => s.key === 'open_issues')?.rows.length || 0} 个未解决问题，${sug} 条修订建议`;
      return 'ok';
    }
    case 'revise': {
      if (!step.run_id) {
        const x = art.transfer(db, user, { from: 'classroom', idempotency_key: `job-${jobId}-back`.slice(0, 80) }); // ← feedback back to 研课场
        const r = runs.createRun(db, user, seminarInput(cfg, j, { base_artifact_id: done('discuss').artifact_ids[0], reference_artifact_id: x.target.artifact_id, material_ids: [], human_reply_budget: 0, title: '' }));
        step.run_id = r.run_id; save(db, jobId, steps);
      }
      const res = await driveRun(db, user, jobId, step.run_id, cfg.pace);
      if (res === 'interrupted') return res;
      const out = one(db, 'SELECT output_artifact_id FROM runs WHERE run_id=?', step.run_id).output_artifact_id;
      art.saveVersion(db, user, out, { reviewed: false });
      art.setCurrent(db, user, 'seminar', out);
      step.artifact_ids = [out];
      step.message = '已依据课堂反馈形成修订版（设为研课场当前产物，待教师审阅）';
      return 'ok';
    }
    default: fail(500, 'bad_step', `未知步骤 ${step.key}`);
  }
}

export { MATERIAL_KINDS };
