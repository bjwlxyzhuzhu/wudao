// HTTP server: static front-ends + JSON API. Access control is enforced here (server side), never by page routing.
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, normalize, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDb, one, all, run, now, tx, fail, check, getSetting, setSetting, audit, json, HttpError, id } from './db.js';
import * as auth from './auth.js';
import * as credits from './credits.js';
import * as models from './models.js';
import * as tpl from './templates.js';
import * as art from './artifacts.js';
import * as runs from './runs.js';
import * as research from './research.js';
import * as sched from './scheduler.js';
import { toDocx, toHtml, DOCX_TYPES } from './render.js';
import { zip } from './zip.js';
import * as materials from './materials.js';
import * as jobs from './jobs.js';
import * as agents from './agents.js';
import * as study from './study.js';
import * as assistant from './assistant.js';
import { BRAND, brandText, brandImage } from './brand.js';
import { analyzeMaterials } from './knowledge.js';
import { createDanceService } from './dance/service.js';
import { bootstrapDanceDeployment } from './dance/bootstrap.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const TEACHER_PAGES = ['/', '/login', '/seminar', '/classroom', '/library', '/rating', '/export', '/account', '/agents', '/research'];
const MANUAL = '/manual';
const COOKIE = { teacher: 'yz_t', admin: 'yz_a', dance: 'dance_session' };

export function createApp({ dataDir = process.env.YANZHI_DATA_DIR || join(ROOT, 'data'), dbFile } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(dbFile || join(dataDir, 'yanzhi.db'));
  const keySource = models.loadMasterKey(dataDir);
  tpl.seedTemplates(db);
  credits.migrateInitialGrants(db, Number(getSetting(db, 'signup_bonus')));
  runs.reconcile(db, { startup: true });
  jobs.ensureTable(db);
  agents.ensureTables(db);
  study.ensureTables(db);
  const dance = createDanceService(db, dataDir);
  const danceBootstrap = bootstrapDanceDeployment(db);
  if (danceBootstrap.accounts.created.length) console.log(`舞蹈平台已初始化 ${danceBootstrap.accounts.created.length} 个部署账号`);
  if (danceBootstrap.qwen.enabled) console.log(`千问视觉模型已就绪：${danceBootstrap.qwen.model_id}`);
  try { assistant.train(db, null); } catch (e) { console.error('assistant index', e); } // 启动时建立思思的知识索引
  const routes = [];
  const route = (method, path, scope, handler, opts = {}) => {
    const keys = []; const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, scope, handler, opts });
  };
  const secure = process.env.YANZHI_SECURE_COOKIE === '1';

  // ---------- auth ----------
  const setCookie = (res, name, value, maxAge) => res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}${maxAge != null ? `; Max-Age=${maxAge}` : ''}`);
  for (const scope of ['teacher', 'admin', 'dance']) {
    const base = scope === 'dance' ? '/api/dance/auth' : scope === 'admin' ? '/api/admin/auth' : '/api/auth';
    route('POST', `${base}/login`, 'public', ({ body, req, res }) => {
      const { token, user } = auth.login(db, { login: body.login, password: body.password, scope, ip: req.socket.remoteAddress });
      if (scope === 'dance') dance.me(user);
      setCookie(res, COOKIE[scope], token, 7 * 24 * 3600);
      return { user: auth.publicUser(user) };
    });
    route('POST', `${base}/logout`, 'public', ({ cookies, res }) => { auth.logout(db, cookies[COOKIE[scope]]); setCookie(res, COOKIE[scope], '', 0); return { ok: true }; });
    route('POST', `${base}/password`, scope, ({ user, body }) => { auth.changePassword(db, user, body.old_password, body.new_password); return { ok: true }; });
  }
  route('GET', '/api/dance/me', 'dance', ({ user }) => dance.me(user));
  route('GET', '/api/dance/catalog', 'dance', ({ user }) => dance.catalog(user));
  route('POST', '/api/dance/standards', 'dance', ({ user, body }) => dance.publishStandard(user, body));
  route('GET', '/api/dance/sessions', 'dance', ({ user }) => ({ sessions: dance.sessions(user) }));
  route('POST', '/api/dance/sessions', 'dance', ({ user, body }) => dance.createTraining(user, body));
  route('GET', '/api/dance/sessions/:id', 'dance', ({ user, params }) => dance.view(user, params.id));
  route('POST', '/api/dance/sessions/:id/pose', 'dance', ({ user, params, body }) => dance.pose(user, params.id, body), { limit: 5e6 });
  route('POST', '/api/dance/sessions/:id/analyze', 'dance', ({ user, params, body }) => dance.analyze(user, params.id, body), { limit: 4e6 });
  route('POST', '/api/dance/sessions/:id/video', 'dance', ({ user, params, body }) => dance.uploadVideo(user, params.id, body), { limit: 29e6 });
  route('GET', '/api/dance/sessions/:id/video', 'dance', ({ user, params, req, res }) => {
    const video = dance.video(user, params.id);
    const range = req.headers.range;
    if (!range) return raw(res, video.bytes, video.type);
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    check(match, 416, 'bad_range', '视频请求范围无效');
    const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), video.bytes.length - 1) : video.bytes.length - 1;
    check(start <= end && start < video.bytes.length, 416, 'bad_range', '视频请求范围无效');
    res.writeHead(206, { 'content-type': video.type, 'content-range': `bytes ${start}-${end}/${video.bytes.length}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'cache-control': 'no-store' });
    res.end(video.bytes.subarray(start, end + 1));
    return STREAMED;
  });
  route('POST', '/api/dance/sessions/:id/reviews', 'dance', ({ user, params, body }) => dance.review(user, params.id, body));
  route('POST', '/api/dance/sessions/:id/withdraw', 'dance', ({ user, params }) => dance.withdraw(user, params.id));
  route('GET', '/api/dance/health', 'dance', ({ user }) => dance.health(user));
  route('POST', '/api/dance/checkins', 'dance', ({ user, body }) => dance.checkin(user, body));
  route('POST', '/api/dance/loads', 'dance', ({ user, body }) => dance.load(user, body));
  route('POST', '/api/dance/health/withdraw', 'dance', ({ user }) => dance.withdrawHealth(user));
  route('POST', '/api/auth/register', 'public', ({ body }) => {
    check(getSetting(db, 'self_register') === '1', 403, 'register_closed', '教师自助注册未开放，请联系管理员开通账号');
    const u = auth.createUser(db, { login: body.login, display_name: body.display_name, password: body.password, is_teacher: true, must_change_password: false, avatar_key: body.avatar_key || null }, null);
    if (body.avatar_key) auth.setAvatar(db, u, body.avatar_key);
    return { user: auth.publicUser(one(db, 'SELECT * FROM users WHERE user_id=?', u.user_id)) };
  });
  // 健康检查：供容器编排与运维探针使用。不返回任何业务数据。
  route('GET', '/api/health', 'public', () => ({ ok: true, version: research.APP_VERSION, schema: research.SCHEMA_VERSION, time: now() }));
  route('GET', '/api/public-config', 'public', () => ({ self_register: getSetting(db, 'self_register') === '1' }));
  // ---------- 数字客服思思 ----------
  route('POST', '/api/assistant/public-ask', 'public', ({ body, req }) => assistant.ask(db, null, body, { publicMode: true, ip: req.socket.remoteAddress }));
  route('GET', '/api/assistant/status', 'teacher', () => assistant.status(db));
  route('POST', '/api/assistant/ask', 'teacher', ({ user, body }) => assistant.ask(db, user, body));
  route('POST', '/api/assistant/train', 'teacher', ({ user }) => assistant.train(db, user));
  route('PUT', '/api/me/avatar', 'teacher', ({ user, body }) => { auth.setAvatar(db, user, body.avatar_key); return { ok: true, avatar_key: body.avatar_key }; });

  // ---------- teacher ----------
  route('GET', '/api/me', 'teacher', ({ user }) => ({ user: auth.publicUser(user), balance: credits.balance(db, user.user_id) }));
  route('GET', '/api/credits', 'teacher', ({ user }) => ({ balance: credits.balance(db, user.user_id), ledger: credits.ledger(db, user.user_id).map(publicLedger) }));
  route('GET', '/api/catalog', 'teacher', ({ user }) => ({
    agent_roles: agents.rolesFor(db, user), fixed_teachers: agents.FIXED_TEACHERS, custom_slots: agents.CUSTOM_SLOTS, student_avatars: agents.studentAvatars(db, user), class_profiles: agents.listClassProfiles(db, user),
    frameworks: tpl.listTemplates(db).filter((t) => t.kind === 'framework').map((t) => ({ key: t.key, version: t.version, name: t.name, ...t.body })),
    artifact_types: tpl.listTemplates(db).filter((t) => t.kind === 'artifact').map((t) => ({ key: t.key, version: t.version, name: t.name, system_only: !!t.body.system_only, sections: t.body.sections })),
    course_fields: tpl.COURSE_FIELDS, lesson_minutes: tpl.LESSON_MINUTES, material_kinds: materials.MATERIAL_KINDS, ideology_library: tpl.IDEOLOGY_LIBRARY, base_ideology_terms: materials.BASE_IDEOLOGY_TERMS, roles: tpl.SEMINAR_ROLES, default_seats: tpl.DEFAULT_SEATS, modes: tpl.SEMINAR_MODES, phases: tpl.PHASES,
    scheduler: sched.CONFIG_OPTIONS, docx_types: DOCX_TYPES, model_available: !models.resolveProvider(db).error, model_status: models.resolveProvider(db).error || { code: 'ok', message: '真实模型可用' },
    ...(() => { const p = models.resolveProvider(db); return p.config ? { model_name: p.config.name, model_id: p.config.model_id } : {}; })(),
  }));
  route('GET', '/api/home', 'teacher', ({ user }) => {
    const cur = (m) => { const a = art.getCurrent(db, user, m); return a ? { artifact_id: a.artifact_id, title: a.title, type: a.type, version: a.version, status: a.status, summary: art.summary(a) } : null; };
    const active = (m) => one(db, "SELECT run_id, status FROM runs WHERE owner_id=? AND module=? AND status IN ('running','awaiting_human','paused','ready') ORDER BY created_at DESC LIMIT 1", user.user_id, m) || null;
    return { current: { seminar: cur('seminar'), classroom: cur('classroom') }, active: { seminar: active('seminar'), classroom: active('classroom') } };
  });
  route('GET', '/api/artifacts', 'teacher', ({ user, query }) => ({ artifacts: all(db, `SELECT * FROM artifacts WHERE owner_id=? ${query.module ? 'AND module=?' : ''} ORDER BY created_at DESC LIMIT 2000`, ...[user.user_id, query.module].filter(Boolean)).map((r) => { const c = json(r.body)?.course || {}; return { ...art.rowToArtifact(r, false), course_name: String(c.name || '').slice(0, 60), unit: String(c.unit || '').slice(0, 60) }; }) }));
  route('POST', '/api/artifacts', 'teacher', ({ user, body }) => {
    const t = tpl.getTemplate(db, 'artifact', body.type); check(t && !t.body.system_only, 400, 'bad_type', '请选择产物类型');
    return art.createArtifact(db, user, { module: body.module, type: body.type, title: body.title, framework_key: body.framework_key, with_pdca: body.with_pdca, course: body.course, framework_fields: body.framework_fields });
  });
  const detail = (user, a) => {
    const eventExists = (eid) => !!one(db, 'SELECT 1 FROM events WHERE event_id=? AND owner_id=?', eid, user.user_id);
    const issues = art.validateBody(a.type, a.body, { eventExists });
    return { artifact: a, issues, ideology_check: art.ideologyCheck(a.body, issues), derived: art.derivedViews(a.type, a.body), provenance: art.provenance(db, user, a.artifact_id),
      is_current: art.getCurrent(db, user, a.module)?.artifact_id === a.artifact_id, versions: all(db, 'SELECT artifact_id, version, status, module, created_at, origin FROM artifacts WHERE lineage_id=? AND owner_id=? ORDER BY version', a.lineage_id, user.user_id) };
  };
  route('GET', '/api/artifacts/:id', 'teacher', ({ user, params }) => detail(user, art.rowToArtifact(art.getOwned(db, user, params.id))));
  route('PUT', '/api/artifacts/:id', 'teacher', ({ user, params, body }) => detail(user, art.updateArtifact(db, user, params.id, body)));
  route('POST', '/api/artifacts/:id/save', 'teacher', ({ user, params, body }) => detail(user, art.saveVersion(db, user, params.id, { reviewed: !!body.reviewed })));
  route('POST', '/api/artifacts/:id/current', 'teacher', ({ user, params }) => { const a = art.getOwned(db, user, params.id); art.setCurrent(db, user, a.module, a.artifact_id); return detail(user, art.rowToArtifact(a)); });
  route('GET', '/api/artifacts/:id/export', 'teacher', ({ user, params, query, res }) => {
    const a = art.rowToArtifact(art.getOwned(db, user, params.id));
    const variant = ['teacher', 'student', 'answers'].includes(query.variant) ? query.variant : 'teacher';
    if (variant === 'answers') check(a.type === 'exam', 400, 'bad_variant', '仅试卷有教师答案卷');
    const base = `${a.title.replace(/[\\/:*?"<>|]/g, '_')}_v${a.version}${variant === 'student' ? (a.type === 'exam' ? '_学生卷' : '_学生版') : variant === 'answers' ? '_教师答案卷' : ''}`;
    audit(db, { actor: user, action: 'artifact_exported', target_type: 'artifact', target_id: a.artifact_id, detail: { format: query.format, variant } });
    if (query.format === 'docx') { check(DOCX_TYPES.includes(a.type), 400, 'docx_unsupported', '该类型暂提供可编辑页面结构与 HTML 预览，DOCX 另行验收'); return raw(res, toDocx(a, variant), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', `${base}.docx`); }
    if (query.format === 'json') return raw(res, Buffer.from(JSON.stringify(variant === 'student' ? { ...a, body: art.studentView(a.body) } : a, null, 2)), 'application/json; charset=utf-8', `${base}.json`);
    return raw(res, Buffer.from(toHtml(a, variant)), 'text/html; charset=utf-8', query.download ? `${base}.html` : null);
  });
  // ---------- 智能体中心 ----------
  route('GET', '/api/agents', 'teacher', ({ user }) => ({ roles: agents.rolesFor(db, user), fixed: agents.FIXED_TEACHERS, custom: agents.CUSTOM_SLOTS, presets: agents.CUSTOM_PRESETS,
    principles: agents.COLLECTION_PRINCIPLES, student_principles: agents.STUDENT_DATA_PRINCIPLES, stages: agents.TRAIN_STAGES, class_profiles: agents.listClassProfiles(db, user),
    students: Array.from({ length: 40 }, (_, i) => agents.studentIdentity(i)), student_avatars: agents.studentAvatars(db, user) }));
  route('GET', '/api/agents/:key', 'teacher', ({ user, params }) => agents.agentDetail(db, user, params.key));
  route('PUT', '/api/agents/:key', 'teacher', ({ user, params, body }) => agents.saveTeacherAgent(db, user, params.key, body), { limit: 1e6 });
  route('POST', '/api/agents/:key/train', 'teacher', ({ user, params, body }) => agents.startTraining(db, user, params.key, body), { limit: 60e6 });
  route('GET', '/api/agents/:key/trainings/:tid', 'teacher', ({ user, params }) => agents.trainingView(db, user, params.tid));
  route('DELETE', '/api/agents/:key/docs/:doc', 'teacher', ({ user, params }) => { agents.deleteDoc(db, user, params.key, params.doc); return { ok: true }; });
  route('POST', '/api/class-profiles', 'teacher', ({ user, body }) => agents.importClassProfile(db, user, body), { limit: 22e6 });
  route('GET', '/api/class-profiles/:id', 'teacher', ({ user, params }) => agents.classProfileView(db, user, params.id));
  route('DELETE', '/api/class-profiles/:id', 'teacher', ({ user, params }) => { agents.deleteClassProfile(db, user, params.id); return { ok: true }; });
  route('PUT', '/api/student-avatars/:seat', 'teacher', ({ user, params, body }) => { agents.setStudentAvatar(db, user, Number(params.seat), body.avatar); return { ok: true }; }, { limit: 1e6 });
  route('GET', '/api/materials', 'teacher', ({ user }) => ({ materials: materials.listMaterials(db, user), kinds: materials.MATERIAL_KINDS }));
  route('POST', '/api/materials', 'teacher', ({ user, body }) => materials.uploadMaterial(db, user, body), { limit: 22e6 });
  route('DELETE', '/api/materials/:id', 'teacher', ({ user, params }) => { materials.deleteMaterial(db, user, params.id); return { ok: true }; });
  route('POST', '/api/knowledge/analyze', 'teacher', ({ user, body }) => { const a = analyzeMaterials(materials.loadMaterials(db, user, body.material_ids)); return { ...a, knowledge_points: a.knowledge_points.map((k) => ({ id: k.id, term: k.term, definition: k.definition, kind: k.kind, source: k.source, ideology: k.ideology.category_name, difficulty: k.difficulty })) }; });
  route('POST', '/api/jobs/estimate', 'teacher', ({ user, body }) => jobs.estimateJob(db, user, body));
  route('POST', '/api/jobs', 'teacher', ({ user, body }) => jobs.createJob(db, user, body));
  route('GET', '/api/jobs', 'teacher', ({ user }) => ({ jobs: jobs.listJobs(db, user) }));
  route('GET', '/api/jobs/:id', 'teacher', ({ user, params }) => jobs.jobView(db, user, params.id));
  route('POST', '/api/jobs/:id/:action', 'teacher', ({ user, params }) => jobs.setJobStatus(db, user, params.id, params.action));
  route('POST', '/api/transfers', 'teacher', ({ user, body }) => art.transfer(db, user, body));
  // 一步完成“课堂反馈 → 回研课场 → 依据反馈修订原产物”：必要时先把反馈带回研课场，再以上课所用产物的研课场版本为底稿发起修订研讨。
  route('POST', '/api/revise-from-feedback', 'teacher', ({ user, body }) => {
    let fb = body.feedback_artifact_id ? art.rowToArtifact(art.getOwned(db, user, body.feedback_artifact_id)) : art.getCurrent(db, user, 'seminar');
    check(fb && fb.type === 'classroom_feedback', 409, 'no_feedback', '没有可用的课堂反馈：请先在演课场下课并生成课堂反馈');
    if (fb.module === 'classroom') { art.setCurrent(db, user, 'classroom', fb.artifact_id); fb = art.transfer(db, user, { from: 'classroom', idempotency_key: `rev-${fb.artifact_id}`.slice(0, 80), save_draft: true }).target; }
    const cr = one(db, "SELECT input_artifact_id FROM runs WHERE run_id=? AND owner_id=? AND module='classroom'", fb.source_run_id, user.user_id);
    check(cr?.input_artifact_id, 409, 'no_source', '找不到这份反馈对应的课堂与产物');
    const used = one(db, 'SELECT lineage_id, type FROM artifacts WHERE artifact_id=?', cr.input_artifact_id);
    const base = one(db, "SELECT artifact_id, title, version FROM artifacts WHERE owner_id=? AND lineage_id=? AND type=? AND module='seminar' ORDER BY version DESC, created_at DESC LIMIT 1", user.user_id, used.lineage_id, used.type)
      || one(db, 'SELECT artifact_id, title, version FROM artifacts WHERE artifact_id=?', cr.input_artifact_id);
    const r = runs.createRun(db, user, { module: 'seminar', exec_mode: body.exec_mode === 'model' ? 'model' : 'demo', base_artifact_id: base.artifact_id, reference_artifact_id: fb.artifact_id, material_ids: [], human_reply_budget: 0, title: '' });
    return { ...runs.publicRun(db, r), base: { artifact_id: base.artifact_id, title: base.title, version: base.version }, feedback: { artifact_id: fb.artifact_id, title: fb.title } };
  });
  route('GET', '/api/transfers', 'teacher', ({ user }) => ({ transfers: all(db, 'SELECT * FROM transfers WHERE owner_id=? ORDER BY created_at DESC', user.user_id) }));

  route('POST', '/api/runs/estimate', 'teacher', ({ user, body }) => ({ ...runs.estimate(db, user, body), balance: credits.balance(db, user.user_id) }));
  route('POST', '/api/runs', 'teacher', ({ user, body }) => runs.publicRun(db, runs.createRun(db, user, body)));
  route('GET', '/api/runs', 'teacher', ({ user, query }) => ({ runs: runs.listRuns(db, user, query.module) }));
  route('GET', '/api/runs/:id', 'teacher', ({ user, params, query }) => runs.runView(db, user, params.id, { after: query.after }));
  route('POST', '/api/runs/:id/start', 'teacher', ({ user, params }) => runs.publicRun(db, runs.startRun(db, user, params.id)));
  route('POST', '/api/runs/:id/pause', 'teacher', ({ user, params }) => runs.publicRun(db, runs.pauseRun(db, user, params.id)));
  route('POST', '/api/runs/:id/resume', 'teacher', ({ user, params }) => runs.publicRun(db, runs.resumeRun(db, user, params.id)));
  route('POST', '/api/runs/:id/finish', 'teacher', ({ user, params }) => runs.publicRun(db, runs.endRun(db, user, params.id, 'completed', 'teacher_finish')));
  route('POST', '/api/runs/:id/cancel', 'teacher', ({ user, params }) => runs.publicRun(db, runs.endRun(db, user, params.id, 'cancelled', 'teacher_cancel')));
  route('POST', '/api/runs/:id/composer', 'teacher', ({ user, params, body }) => runs.publicRun(db, runs.composer(db, user, params.id, !!body.open)));
  route('POST', '/api/runs/:id/human', 'teacher', ({ user, params, body }) => runs.humanInput(db, user, params.id, body));
  route('POST', '/api/runs/:id/feedback', 'teacher', ({ user, params }) => runs.classroomFeedback(db, user, params.id));
  route('POST', '/api/runs/:id/accept', 'teacher', ({ user, params }) => {
    const r = runs.getRunRow(db, user, params.id);
    check(r.output_artifact_id, 409, 'no_output', '本次研讨尚未产出草稿');
    const a = art.saveVersion(db, user, r.output_artifact_id, { reviewed: true });
    art.setCurrent(db, user, a.module, a.artifact_id);
    return detail(user, a);
  });
  route('POST', '/api/runs/:id/step', 'teacher', async ({ user, params, body, req, res }) => {
    const stream = String(req.headers.accept || '').includes('text/event-stream');
    if (!stream) return runs.stepRun(db, user, params.id, { idempotency_key: body.idempotency_key });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    let seq = 0;
    const emit = (type, data) => { res.write(`id: ${++seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    try { await runs.stepRun(db, user, params.id, { idempotency_key: body.idempotency_key, emit }); }
    catch (e) { if (!(e instanceof HttpError)) console.error(e); emit('error', e instanceof HttpError ? { code: e.code, message: e.message, ...(e.extra || {}) } : { code: 'internal', message: '服务器内部错误' }); }
    res.end();
    return STREAMED;
  });
  route('POST', '/api/challenges/:id/resolve', 'teacher', ({ user, params, body }) => { runs.resolveChallenge(db, user, params.id, body.resolution); return { ok: true }; });
  route('GET', '/api/rubrics', 'teacher', ({ user }) => ({ rubrics: research.listRubrics(db, user) }));
  route('POST', '/api/rubrics/preview', 'teacher', ({ user, body }) => research.importRubric(db, user, body, { preview: true }));
  route('POST', '/api/rubrics', 'teacher', ({ user, body }) => research.importRubric(db, user, body));
  route('GET', '/api/ratings', 'teacher', ({ user, query }) => ({ ratings: research.listRatings(db, user, query) }));
  route('POST', '/api/ratings', 'teacher', ({ user, body }) => research.rate(db, user, body));
  route('GET', '/api/custom-modes', 'teacher', ({ user }) => ({ modes: research.listCustomModes(db, user) }));
  route('POST', '/api/custom-modes', 'teacher', ({ user, body }) => research.saveCustomMode(db, user, body));
  route('DELETE', '/api/custom-modes/:id', 'teacher', ({ user, params }) => { research.deleteCustomMode(db, user, params.id); return { ok: true }; });
  route('GET', '/api/export/options', 'teacher', ({ user }) => ({ categories: research.CATEGORIES, runs: runs.listRuns(db, user) }));
  route('POST', '/api/export/preview', 'teacher', ({ user, body }) => research.previewPackage(db, user, body));
  route('POST', '/api/export/zip', 'teacher', ({ user, body, res }) => raw(res, research.exportZip(db, user, body), 'application/zip', `yanzhi-research-${new Date().toISOString().slice(0, 10)}.zip`));
  route('GET', '/api/backup', 'teacher', ({ user, res }) => raw(res, Buffer.from(JSON.stringify(research.backup(db, user), null, 1)), 'application/json; charset=utf-8', `yanzhi-backup-${user.pseudonym}-${new Date().toISOString().slice(0, 10)}.json`));
  route('POST', '/api/restore/preview', 'teacher', ({ user, body }) => research.planRestore(db, user, body.data), { limit: 40e6 });
  route('POST', '/api/restore', 'teacher', ({ user, body }) => research.restore(db, user, body.data, { confirm_ownership: body.confirm_ownership === true }), { limit: 40e6 });

  // ---------- 科研数据中心 ----------
  route('GET', '/api/research/meta', 'teacher', () => ({ designs: study.DESIGNS, fields: study.FIELDS_OF_STUDY, skeletons: Object.fromEntries(Object.entries(study.SCALE_SKELETONS).map(([k, v]) => [k, { name: v.name, citation: v.citation, self_developed: !!v.selfDeveloped, dims: v.dims.map(([c, l, n]) => ({ code: c, label: l, n })) }])),
    datasets: Object.fromEntries(Object.entries(study.DATASETS).map(([k, v]) => [k, { label: v.label, ctx: v.ctx }])), consent_names: study.CONSENT_NAME }));
  route('GET', '/api/research/projects', 'teacher', ({ user }) => ({ projects: study.listProjects(db, user) }));
  route('POST', '/api/research/projects', 'teacher', ({ user, body }) => study.saveProject(db, user, null, body));
  route('GET', '/api/research/projects/:id', 'teacher', ({ user, params }) => study.projectView(db, user, params.id));
  route('PUT', '/api/research/projects/:id', 'teacher', ({ user, params, body }) => study.saveProject(db, user, params.id, body));
  route('DELETE', '/api/research/projects/:id', 'teacher', ({ user, params }) => { study.deleteProject(db, user, params.id); return { ok: true }; });
  route('POST', '/api/research/projects/:id/package', 'teacher', ({ user, params, body, res }) => { const p = study.getProject(db, user, params.id); return raw(res, study.projectPackage(db, user, params.id, { include_text: !!body.include_text, include_platform: body.include_platform !== false }), 'application/zip', `研究数据包_${p.code}_${new Date().toISOString().slice(0, 10)}.zip`); });
  route('POST', '/api/research/projects/:id/units-from-runs', 'teacher', ({ user, params, body }) => study.unitsFromRuns(db, user, params.id, body.run_ids));
  route('POST', '/api/research/projects/:id/units-delete', 'teacher', ({ user, params, body }) => study.deleteUnits(db, user, params.id, { session: body.session }));
  route('PUT', '/api/research/participants/:id', 'teacher', ({ user, params, body }) => study.updateParticipant(db, user, params.id, body));
  route('POST', '/api/research/participants/:id/purge', 'teacher', ({ user, params, body }) => { check(body.confirm === true, 400, 'confirm_required', '请确认删除'); return study.purgeParticipantData(db, user, params.id); });
  route('POST', '/api/research/instruments', 'teacher', ({ user, body }) => (body.skeleton ? study.instrumentFromSkeleton(db, user, body.project_id, body.skeleton) : body.artifact_id ? study.instrumentFromArtifact(db, user, body.project_id, body.artifact_id) : study.saveInstrument(db, user, null, body)));
  route('GET', '/api/research/instruments/:id', 'teacher', ({ user, params }) => study.instrumentView(db, user, params.id));
  route('PUT', '/api/research/instruments/:id', 'teacher', ({ user, params, body }) => study.saveInstrument(db, user, params.id, body));
  route('DELETE', '/api/research/instruments/:id', 'teacher', ({ user, params }) => { study.deleteInstrument(db, user, params.id); return { ok: true }; });
  route('GET', '/api/research/instruments/:id/analysis', 'teacher', ({ user, params }) => study.analyzeInstrument(db, user, params.id));
  route('POST', '/api/research/instruments/:id/rescore', 'teacher', ({ user, params }) => study.rescore(db, user, params.id));
  route('DELETE', '/api/research/items/:id', 'teacher', ({ user, params }) => { study.deleteItem(db, user, params.id); return { ok: true }; });
  route('POST', '/api/research/codebooks', 'teacher', ({ user, body }) => study.saveCodebook(db, user, body));
  route('GET', '/api/research/codebooks/:id', 'teacher', ({ user, params }) => study.codebookView(db, user, params.id));
  route('DELETE', '/api/research/codebooks/:id', 'teacher', ({ user, params }) => { study.deleteCodebook(db, user, params.id); return { ok: true }; });
  route('POST', '/api/research/codebooks/:id/codes', 'teacher', ({ user, params, body }) => ({ result: study.putCode(db, user, params.id, body) }));
  route('DELETE', '/api/research/codebooks/:id/codes/:code', 'teacher', ({ user, params }) => { study.deleteCode(db, user, params.id, params.code); return { ok: true }; });
  route('GET', '/api/research/codebooks/:id/coding', 'teacher', ({ user, params, query }) => study.codingView(db, user, params.id, query));
  route('GET', '/api/research/codebooks/:id/irr', 'teacher', ({ user, params }) => study.codingIrr(db, user, params.id));
  route('GET', '/api/research/codebooks/:id/sequence', 'teacher', ({ user, params, query }) => { const s = study.sequenceData(db, user, params.id, query.coder); return { basis: s.basis, codes: s.codes, n_units: s.ena.length, lag: s.lag }; });
  route('POST', '/api/research/codings', 'teacher', ({ user, body }) => study.setCoding(db, user, body));
  route('GET', '/api/research/rating-irr', 'teacher', ({ user, query }) => study.ratingIrr(db, user, query.rubric_id));
  // 通用智能导入 / 导出（所有表格数据）
  route('POST', '/api/io/preview', 'teacher', ({ user, body }) => study.importPreview(db, user, body), { limit: 30e6 });
  route('POST', '/api/io/commit', 'teacher', ({ user, body }) => study.importCommit(db, user, body), { limit: 30e6 });
  route('GET', '/api/io/export', 'teacher', ({ user, query, res }) => { const { dataset, format, include_all, ...ctx } = query; const e = study.exportDataset(db, user, dataset, ctx, format || 'xlsx', { include_all: include_all === '1' }); return raw(res, e.buf, e.type, e.filename); });

  // ---------- admin ----------
  route('GET', '/api/admin/me', 'admin', ({ user }) => ({ user: auth.publicUser(user) }));
  route('GET', '/api/admin/overview', 'admin', () => {
    const sum = (sql) => one(db, sql).n || 0;
    const calls = one(db, "SELECT COUNT(*) n, SUM(status='succeeded') ok, SUM(status='failed') bad FROM model_calls");
    return {
      teachers: sum('SELECT COUNT(*) n FROM users WHERE is_teacher=1'), active_teachers: sum("SELECT COUNT(*) n FROM users WHERE is_teacher=1 AND status='active'"),
      runs: sum('SELECT COUNT(*) n FROM runs'), running: sum("SELECT COUNT(*) n FROM runs WHERE status IN ('running','awaiting_human')"),
      credits_granted: sum("SELECT SUM(amount) n FROM credit_ledger WHERE type IN ('initial_grant','admin_grant')"), credits_deducted: -sum("SELECT SUM(amount) n FROM credit_ledger WHERE type='admin_deduct'"),
      credits_consumed: -sum("SELECT SUM(amount) n FROM credit_ledger WHERE type='settle'") - sum("SELECT SUM(amount) n FROM credit_ledger WHERE type='reversal' AND related_entry_id IN (SELECT entry_id FROM credit_ledger WHERE type='settle')"),
      credits_reserved: sum('SELECT SUM(reserved_balance) n FROM credit_accounts'),
      model_calls: { total: calls.n || 0, succeeded: calls.ok || 0, failed: calls.bad || 0, success_rate: calls.n ? Math.round(((calls.ok || 0) / calls.n) * 1000) / 10 : null },
      cost_info: '供应商费用未接入实际账单来源，不展示估算费用',
      model_status: models.resolveProvider(db).error || { code: 'ok' }, master_key_source: keySource,
    };
  });
  route('GET', '/api/admin/users', 'admin', ({ query }) => ({ users: auth.listUsers(db, query.q) }));
  route('POST', '/api/admin/users', 'admin', ({ user, body }) => {
    const temp = body.password || `Yz${randomUUID().replace(/-/g, '').slice(0, 8)}7`;
    const u = auth.createUser(db, { login: body.login, display_name: body.display_name, password: temp, is_teacher: body.is_teacher !== false, is_admin: !!body.is_admin, must_change_password: true }, user);
    return { user: auth.publicUser(u), temporary_password: body.password ? null : temp, balance: credits.balance(db, u.user_id) };
  });
  route('POST', '/api/admin/users/:id/status', 'admin', ({ user, params, body }) => { auth.setUserStatus(db, user, params.id, body.status); if (body.status === 'disabled') runs.stopUserRuns(db, user, params.id); return { ok: true }; });
  route('POST', '/api/admin/users/:id/roles', 'admin', ({ user, params, body }) => { auth.setUserRoles(db, user, params.id, body); return { ok: true, balance: credits.balance(db, params.id) }; });
  route('POST', '/api/admin/users/:id/reset-password', 'admin', ({ user, params }) => ({ temporary_password: auth.resetPassword(db, user, params.id) }));
  route('GET', '/api/admin/users/:id/ledger', 'admin', ({ params }) => ({ balance: credits.balance(db, params.id), ledger: credits.ledger(db, params.id, 500), reconcile: credits.reconcileAccount(db, params.id) }));
  route('POST', '/api/admin/credits/preview', 'admin', ({ body }) => ({ preview: credits.previewAdjust(db, body.items, body.reason) }));
  route('POST', '/api/admin/credits/commit', 'admin', ({ user, body }) => credits.commitAdjust(db, user, body));
  route('POST', '/api/admin/ledger/:id/reverse', 'admin', ({ user, params, body }) => credits.reverseEntry(db, user, params.id, body.reason));
  const SETTINGS = { signup_bonus: [0, 100000], self_register: [0, 1], max_calls_per_task: [1, 1000], stale_run_minutes: [10, 10080], session_idle_minutes: [10, 10080], assistant_model: [0, 1], assistant_hourly_limit: [0, 1000] };
  route('GET', '/api/admin/settings', 'admin', () => Object.fromEntries(Object.keys(SETTINGS).map((k) => [k, Number(getSetting(db, k))]).concat([['pricing_version', Number(getSetting(db, 'pricing_version'))]])));
  route('PUT', '/api/admin/settings', 'admin', ({ user, body }) => {
    tx(db, () => { for (const [k, [lo, hi]] of Object.entries(SETTINGS)) if (body[k] != null) { const n = Number(body[k]); check(Number.isInteger(n) && n >= lo && n <= hi, 400, 'bad_setting', `${k} 取值需在 ${lo}—${hi}`); setSetting(db, k, n, user.user_id); }
      audit(db, { actor: user, action: 'settings_changed', target_type: 'settings', detail: body }); });
    return { ok: true };
  });
  route('GET', '/api/admin/models', 'admin', () => ({ models: models.listConfigs(db), kinds: models.KINDS }));
  route('POST', '/api/admin/models', 'admin', ({ user, body }) => models.saveConfig(db, user, body));
  route('POST', '/api/admin/models/:id/key', 'admin', ({ user, params, body }) => { check(one(db, 'SELECT 1 FROM model_configs WHERE provider_id=?', params.id), 404, 'not_found', '配置不存在'); models.setKey(db, user, params.id, body.api_key); return models.publicConfig(one(db, 'SELECT * FROM model_configs WHERE provider_id=?', params.id)); });
  route('DELETE', '/api/admin/models/:id/key', 'admin', ({ user, params }) => { models.removeKey(db, user, params.id); return { ok: true }; });
  route('GET', '/api/admin/models/:id/remote', 'admin', ({ user, params }) => models.listRemoteModels(db, user, params.id));
  route('POST', '/api/admin/models/:id/test', 'admin', ({ user, params }) => models.testConnection(db, user, params.id));
  route('GET', '/api/admin/templates', 'admin', () => ({ templates: tpl.listTemplates(db, { includeRetired: true }) }));
  route('POST', '/api/admin/templates', 'admin', ({ user, body }) => tpl.publishTemplateVersion(db, user, body));
  route('POST', '/api/admin/templates/:id/status', 'admin', ({ user, params, body }) => { tpl.setTemplateStatus(db, user, params.id, body.status); return { ok: true }; });
  route('GET', '/api/admin/runs', 'admin', ({ query }) => ({
    runs: all(db, `SELECT r.run_id, r.module, r.exec_mode, r.status, r.stop_reason, r.created_at, r.started_at, r.ended_at, r.model_calls, r.budget_calls, r.rate, u.pseudonym owner FROM runs r JOIN users u ON u.user_id=r.owner_id ${query.status ? 'WHERE r.status=?' : ''} ORDER BY r.created_at DESC LIMIT 200`, ...(query.status ? [query.status] : [])),
    calls: all(db, "SELECT c.call_id, c.run_id, c.provider_id, c.model_id, c.key_version, c.purpose, c.status, c.error_code, c.request_id, c.request_at, c.latency_ms, c.input_tokens, c.output_tokens, c.credits, c.retry_of, u.pseudonym owner FROM model_calls c JOIN users u ON u.user_id=c.user_id ORDER BY c.request_at DESC LIMIT 200"),
    reservations: all(db, "SELECT v.*, u.pseudonym owner FROM reservations v JOIN users u ON u.user_id=v.user_id WHERE v.status<>'closed' ORDER BY v.created_at DESC"),
  }));
  route('POST', '/api/admin/runs/:id/stop', 'admin', ({ user, params }) => { const r = runs.endRun(db, null, params.id, 'cancelled', 'admin_stop'); audit(db, { actor: user, action: 'admin_run_stop', target_type: 'run', target_id: params.id }); return { status: r.status }; });
  route('POST', '/api/admin/reconcile', 'admin', ({ user }) => { const r = runs.reconcile(db); audit(db, { actor: user, action: 'reconcile', detail: r }); return r; });
  route('GET', '/api/admin/audit', 'admin', ({ query }) => ({ audit: all(db, `SELECT a.*, u.login actor_login FROM audit_log a LEFT JOIN users u ON u.user_id=a.actor_id ${query.action ? 'WHERE a.action=?' : ''} ORDER BY a.time DESC LIMIT 300`, ...(query.action ? [query.action] : [])) }));
  route('GET', '/api/admin/export/finance', 'admin', ({ user, res }) => {
    audit(db, { actor: user, action: 'finance_export' });
    const ledger = all(db, 'SELECT l.*, u.login FROM credit_ledger l JOIN users u ON u.user_id=l.user_id ORDER BY l.created_at');
    const calls = all(db, 'SELECT c.*, u.login FROM model_calls c JOIN users u ON u.user_id=c.user_id ORDER BY c.request_at');
    return raw(res, zip([{ name: 'credit_ledger.csv', data: research.csv(ledger, ['entry_id', 'login', 'type', 'amount', 'reserved_delta', 'total_after', 'reserved_after', 'reservation_id', 'run_id', 'call_id', 'batch_id', 'reason', 'actor_id', 'related_entry_id', 'idempotency_key', 'created_at']) },
      { name: 'model_calls.csv', data: research.csv(calls, ['call_id', 'login', 'run_id', 'provider_id', 'model_id', 'key_version', 'purpose', 'status', 'error_code', 'request_id', 'request_at', 'first_token_at', 'completed_at', 'latency_ms', 'input_tokens', 'output_tokens', 'credits', 'retry_of']) },
      { name: 'README.md', data: '# 管理员财务与模型使用导出\n\n与研究数据包分开。不含 API Key、密码或会话令牌。\n' }]), 'application/zip', `yanzhi-admin-finance-${new Date().toISOString().slice(0, 10)}.zip`);
  });

  // ---------- dispatcher ----------
  const server = createServer(async (req, res) => {
    const reqId = randomUUID();
    res.setHeader('x-request-id', reqId);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    const dancePage = /^\/(wujing|wuan)(\/|\?|$)/.test(req.url) || (process.env.DANCE_HOME === '1' && req.url === '/');
    res.setHeader('content-security-policy', dancePage ? "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" : "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(req.url, 'http://local');
    try {
      if (!url.pathname.startsWith('/api/')) { let pth = url.pathname; try { pth = decodeURIComponent(pth); } catch { /* keep raw */ } return serveStatic(pth, res); }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) fail(404, 'not_found', '接口不存在');
      if (req.method !== 'GET') {
        // CSRF: custom header + same-origin check (cookies are also SameSite=Strict).
        check(req.headers['x-yz-csrf'] === '1', 403, 'csrf', '请求来源校验失败');
        const origin = req.headers.origin; if (origin) check(new URL(origin).host === req.headers.host, 403, 'csrf', '跨站请求被拒绝');
      }
      const cookies = Object.fromEntries(String(req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), safeDecode(c.slice(i + 1)) ?? c.slice(i + 1)]; }));
      let user = null;
      if (r.scope !== 'public') {
        user = auth.sessionUser(db, cookies[COOKIE[r.scope]], r.scope);
        if (!user) fail(401, 'unauthenticated', r.scope === 'admin' ? '请以管理员身份登录' : '请先登录');
        if (user.must_change_password && !/\/password$|\/me$|\/logout$/.test(url.pathname)) fail(403, 'must_change_password', '首次登录请先修改密码');
      }
      const m = url.pathname.match(r.re);
      const params = {};
      for (const [i, k] of r.keys.entries()) { const raw = m[i + 1]; const dec = safeDecode(raw); if (dec === null) fail(400, 'bad_encoding', '请求路径包含无效的百分号编码'); params[k] = dec; }
      const body = req.method === 'GET' ? {} : await readJson(req, r.opts.limit || 2e6);
      const out = await r.handler({ req, res, user, body, params, query: Object.fromEntries(url.searchParams), cookies, reqId });
      if (out === STREAMED || res.writableEnded) return;
      send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: { code: e.code, message: e.message, ...(e.extra || {}) }, request_id: reqId });
      if (String(e.message).includes('CHECK constraint') ) return send(res, 409, { error: { code: 'insufficient_credits', message: '可用积分不足' }, request_id: reqId });
      console.error(`[${reqId}]`, e);
      if (!res.headersSent) send(res, 500, { error: { code: 'internal', message: '服务器内部错误' }, request_id: reqId }); else res.end();
    }
  });
  const timer = setInterval(() => { try { runs.reconcile(db); } catch (e) { console.error('reconcile', e); } }, 5 * 60e3);
  timer.unref();
  let closing = null;
  return {
    server, db,
    // Idempotent: signal handlers and tests may both call close().
    close: () => {
      if (closing) return closing;
      closing = (async () => {
        try { await dance.close(); } catch (e) { console.error('dance close', e); }
        return new Promise((r) => {
          clearInterval(timer);
          try { jobs.stopAllWorkers(db); } catch (e) { console.error('stopAllWorkers', e); }
          server.close(() => { try { db.close(); } catch { /* already closed */ } r(); });
          server.closeAllConnections?.();
        });
      })();
      return closing;
    },
  };
}

const STREAMED = Symbol('streamed');

function publicLedger(e) { return { entry_id: e.entry_id, type: e.type, amount: e.amount, reserved_delta: e.reserved_delta, total_after: e.total_after, reserved_after: e.reserved_after, run_id: e.run_id, reason: e.reason, created_at: e.created_at }; }

function send(res, status, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': b.length });
  res.end(b);
}
function raw(res, buf, type, filename) {
  const h = { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' };
  if (filename) h['content-disposition'] = `attachment; filename="download${extnameOf(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  res.writeHead(200, h); res.end(buf); return STREAMED;
}
const extnameOf = (f) => (f.match(/\.[a-z]+$/i) || [''])[0];
function readJson(req, limit) {
  return new Promise((resolveP, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'too_large', '请求内容过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolveP({}); try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolveP(v && typeof v === 'object' ? v : {}); } catch { reject(new HttpError(400, 'bad_json', 'JSON 格式错误')); } });
    req.on('error', reject);
  });
}
/**
 * True when `file` is inside `root`. A plain startsWith() is not enough: a
 * sibling directory whose name merely begins with the root's name would pass.
 */
function insideRoot(root, file) {
  const rel = relative(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** decodeURIComponent that returns null instead of throwing on malformed input. */
function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}

function serveStatic(pathname, res) {
  let file;
  if (['/wujing','/wujing/','/wuan','/wuan/'].includes(pathname) || (pathname === '/' && process.env.DANCE_HOME === '1')) file = join(PUBLIC, 'dance', 'index.html');
  else if (pathname === '/admin' || pathname.startsWith('/admin/')) file = join(PUBLIC, 'admin.html');
  else if (TEACHER_PAGES.includes(pathname)) file = join(PUBLIC, 'index.html');
  else if (pathname === MANUAL || pathname === `${MANUAL}/`) file = join(PUBLIC, 'manual', 'index.html');
  else { file = normalize(join(PUBLIC, pathname)); if (!insideRoot(PUBLIC, file)) return send(res, 403, { error: { code: 'forbidden' } }); }
  // 品牌版本：Logo 等图片优先取 public/img/brand/<品牌>/ 下的同名文件
  if (BRAND && pathname.startsWith('/img/') && !pathname.startsWith('/img/brand/')) { const alt = join(PUBLIC, brandImage(pathname.slice(5))); if (existsSync(alt)) file = alt; }
  if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: { code: 'not_found', message: '页面不存在' } });
  let b = readFileSync(file);
  if (BRAND && ['.html', '.js'].includes(extname(file))) b = Buffer.from(brandText(b.toString('utf8')), 'utf8');
  res.writeHead(200, { 'content-type': extname(file) === '.wasm' ? 'application/wasm' : extname(file) === '.mjs' ? 'text/javascript; charset=utf-8' : MIME[extname(file)] || 'application/octet-stream', 'content-length': b.length, 'cache-control': extname(file) === '.html' ? 'no-store' : 'no-cache' });
  res.end(b);
}

// ---------- entry point ----------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!Number.isInteger(Number(process.env.PORT || 8787)) || Number(process.env.PORT || 8787) < 0 || Number(process.env.PORT || 8787) > 65535) {
    console.error(`PORT 必须是 0—65535 之间的整数，当前为 ${JSON.stringify(process.env.PORT)}`);
    process.exit(1);
  }
  const port = Number(process.env.PORT || 8787), host = process.env.HOST || '127.0.0.1';
  const app = createApp();

  // Graceful shutdown: stop accepting connections, abort in-flight work, close the DB.
  // Without this a Ctrl-C leaves job reservations held and the WAL unflushed.
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n收到 ${signal}，正在安全退出…`);
    const force = setTimeout(() => {
      console.error('安全退出超时（10 秒），强制结束。');
      process.exit(1);
    }, 10000);
    force.unref();
    try {
      await app.close();
      console.log('已安全退出。');
      process.exit(0);
    } catch (e) {
      console.error('退出时发生错误：', e);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  app.server.listen(port, host, () => {
    const admins = one(app.db, 'SELECT COUNT(*) n FROM users WHERE is_admin=1').n;
    console.log(`${BRAND ? BRAND.name : '研思智境'}平台已启动：http://${host}:${port}/  （管理员后台：/admin）`);
    if (!admins) console.log('尚无管理员账号。请运行：npm run init-admin -- --login <登录名>');
  });
}
