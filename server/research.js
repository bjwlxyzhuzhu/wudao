// Ratings, rubrics, custom seminar modes, research export (ZIP), teacher backup/restore and legacy migration.
import { createHash } from 'node:crypto';
import { one, all, run, id, now, tx, check, fail, audit, json } from './db.js';
import { RUBRIC_V1, SPECIAL_SCORES, validateRubric, PHASES } from './templates.js';
import { DISTRIBUTION_VERSION } from './scheduler.js';
import { zip } from './zip.js';
import { brandText } from './brand.js';

export const APP_VERSION = '5.3.0';
export const SCHEMA_VERSION = '5.1';

// ---------- rubrics & ratings ----------
export function listRubrics(db, user) {
  return all(db, 'SELECT * FROM rubrics WHERE owner_id IS NULL OR owner_id=? ORDER BY owner_id IS NOT NULL, key, version', user.user_id)
    .map((r) => ({ rubric_id: r.rubric_id, key: r.key, version: r.version, name: r.name, builtin: !r.owner_id, body: json(r.body), created_at: r.created_at }));
}
export function importRubric(db, user, input, { preview = false } = {}) {
  const r = validateRubric(input);
  const prev = one(db, 'SELECT MAX(version) v FROM rubrics WHERE owner_id=? AND key=?', user.user_id, r.key).v || 0;
  r.version = prev + 1;
  if (preview) return { preview: r };
  const rubric_id = id('rubric');
  run(db, 'INSERT INTO rubrics(rubric_id,owner_id,key,version,name,body,created_at) VALUES(?,?,?,?,?,?,?)', rubric_id, user.user_id, r.key, r.version, r.name, JSON.stringify(r), now());
  audit(db, { actor: user, action: 'rubric_imported', target_type: 'rubric', target_id: rubric_id, detail: { key: r.key, version: r.version } });
  return { rubric_id, ...r };
}

export function rate(db, user, input) {
  const rub = one(db, 'SELECT * FROM rubrics WHERE rubric_id=? AND (owner_id IS NULL OR owner_id=?)', input.rubric_id, user.user_id);
  check(rub, 404, 'not_found', '量规不存在');
  const def = json(rub.body);
  let runId = null;
  if (input.target_type === 'event') {
    const e = one(db, 'SELECT run_id FROM events WHERE event_id=? AND owner_id=?', input.target_id, user.user_id);
    check(e, 404, 'not_found', '被评价事件不存在或无权访问'); runId = e.run_id;
  } else if (input.target_type === 'artifact') {
    const a = one(db, 'SELECT source_run_id FROM artifacts WHERE artifact_id=? AND owner_id=?', input.target_id, user.user_id);
    check(a, 404, 'not_found', '被评价产物不存在或无权访问'); runId = a.source_run_id;
  } else fail(400, 'bad_target', '评分对象须为事件或产物版本');
  const rater = String(input.rater_code || '').trim();
  check(/^[\w一-龥-]{1,20}$/.test(rater), 400, 'bad_rater', '请填写评价者假名编码（1—20 字）');
  const scores = {};
  for (const d of def.dimensions) {
    const v = input.scores?.[d.key];
    if (v == null || v === '' || v === 'not_rated') { scores[d.key] = 'not_rated'; continue; }
    if (SPECIAL_SCORES.includes(v)) { scores[d.key] = v; continue; }
    const n = Number(v);
    check(Number.isInteger(n) && n >= def.scale[0] && n <= def.scale[1], 400, 'bad_score', `「${d.label}」须为 ${def.scale[0]}—${def.scale[1]} 的整数，或标记未评/不适用/证据不足`);
    scores[d.key] = n;
  }
  for (const k of Object.keys(input.scores || {})) check(def.dimensions.some((d) => d.key === k), 400, 'bad_dimension', `未知维度 ${k}`);
  return tx(db, () => {
    const prev = one(db, 'SELECT rating_id FROM ratings WHERE owner_id=? AND target_type=? AND target_id=? AND rater_code=? AND rubric_id=? AND rating_id NOT IN (SELECT supersedes_rating_id FROM ratings WHERE supersedes_rating_id IS NOT NULL) ORDER BY created_at DESC LIMIT 1',
      user.user_id, input.target_type, input.target_id, rater, rub.rubric_id);
    const rating_id = id('rating');
    run(db, 'INSERT INTO ratings(rating_id,owner_id,target_type,target_id,run_id,rater_code,rubric_id,rubric_version,scores,note,supersedes_rating_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      rating_id, user.user_id, input.target_type, input.target_id, runId, rater, rub.rubric_id, rub.version, JSON.stringify(scores), String(input.note || '').slice(0, 2000), prev?.rating_id || null, now());
    audit(db, { actor: user, action: 'rating_added', target_type: 'rating', target_id: rating_id });
    return one(db, 'SELECT * FROM ratings WHERE rating_id=?', rating_id);
  });
}
export const listRatings = (db, user, { target_id, run_id } = {}) =>
  all(db, `SELECT * FROM ratings WHERE owner_id=? ${target_id ? 'AND target_id=?' : ''} ${run_id ? 'AND run_id=?' : ''} ORDER BY created_at`, user.user_id, ...[target_id, run_id].filter(Boolean)).map((r) => ({ ...r, scores: json(r.scores) }));

// ---------- custom seminar modes ----------
export function saveCustomMode(db, user, { name, phases }) {
  name = String(name || '').trim().slice(0, 30);
  check(name, 400, 'bad_name', '请填写模式名称');
  check(Array.isArray(phases) && phases.length >= 2 && phases.length <= 12 && phases.every((p) => Object.hasOwn(PHASES, p)), 400, 'bad_phases', '阶段需 2—12 个且为有效阶段');
  check(one(db, 'SELECT COUNT(*) n FROM custom_modes WHERE owner_id=?', user.user_id).n < 20, 400, 'too_many', '最多保存 20 个自定义模式');
  const mode_id = id('mode');
  run(db, 'INSERT INTO custom_modes(mode_id,owner_id,name,body,created_at) VALUES(?,?,?,?,?)', mode_id, user.user_id, name, JSON.stringify({ phases }), now());
  return { mode_id, name, phases };
}
export const listCustomModes = (db, user) => all(db, 'SELECT * FROM custom_modes WHERE owner_id=? ORDER BY created_at', user.user_id).map((m) => ({ mode_id: m.mode_id, name: m.name, phases: json(m.body).phases }));
export function deleteCustomMode(db, user, modeId) { run(db, 'DELETE FROM custom_modes WHERE mode_id=? AND owner_id=?', modeId, user.user_id); }

// ---------- CSV ----------
export function csv(rows, columns) {
  const cell = (v) => {
    let t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`; // formula-injection guard (not for plain negative numbers)
    return `"${t.replace(/"/g, '""')}"`;
  };
  return '﻿' + [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

// ---------- research export ----------
export const CATEGORIES = {
  runs: '运行/配置/时间', events: '逐条对话', participants: '人物与分组', scheduler: '随机调度与交互关系',
  artifacts: '产物/模板版本', transfers: '模块流转', ratings: '评分/量规', metrics: '过程指标', agents: '智能体训练与班级画像（元数据）', audit: '审计/字典',
};
const TABLES = {
  'runs.csv': ['runs', ['run_id', 'module', 'exec_mode', 'status', 'input_artifact_id', 'output_artifact_id', 'seed', 'created_at', 'started_at', 'ended_at', 'wall_duration_ms', 'paused_ms', 'active_session_ms', 'model_calls', 'has_human_intervention', 'pricing_version', 'stop_reason', 'config']],
  'events.csv': ['events', ['event_id', 'run_id', 'sequence', 'time', 'elapsed_ms', 'inter_event_ms', 'actor_code', 'actor_type', 'source', 'data_provenance', 'human_role', 'kind', 'text', 'reply_to', 'reply_latency_ms', 'target_actor', 'target_ref', 'group_id', 'stage', 'composer_opened_at', 'submitted_at', 'input_dwell_ms', 'model_call_id', 'decision_id', 'class_clock_ms', 'sim_duration_ms', 'ideology_terms', 'is_real_classroom_evidence']],
  'participants.csv': ['participants', ['run_id', 'actor_code', 'kind', 'display_name', 'role', 'seat', 'group_id', 'avatar_index', 'traits', 'is_real_person']],
  'scheduler_decisions.csv': ['scheduler', ['decision_id', 'run_id', 'step', 'time', 'trigger', 'trigger_event_id', 'seed', 'n_candidates', 'n_eligible', 'speak_probability', 'draw', 'hands', 'selected_agent', 'action', 'target_actor', 'target_event_id', 'group_id', 'cooldown', 'top_weights', 'distribution_version']],
  'interaction_edges.csv': ['scheduler', ['run_id', 'event_id', 'from_actor', 'to_actor', 'edge_type', 'from_group', 'to_group', 'reply_latency_ms']],
  'challenges.csv': ['scheduler', ['challenge_id', 'run_id', 'challenger', 'target_actor', 'target_ref', 'challenge_event_id', 'response_event_id', 'revision_event_id', 'human_resolution', 'opened_at', 'closed_at']],
  'timing_spans.csv': ['runs', ['run_id', 'span_type', 'ref_id', 'start', 'end', 'duration_ms', 'clock_source', 'model_id', 'request_id', 'input_tokens', 'output_tokens', 'first_token_at', 'status', 'error_code']],
  'artifacts.csv': ['artifacts', ['artifact_id', 'lineage_id', 'module', 'type', 'title', 'version', 'status', 'parent_id', 'source_run_id', 'origin', 'framework_key', 'framework_version', 'template_version', 'reviewed_by_teacher', 'ai_assisted', 'created_at', 'saved_at']],
  'artifact_sections.csv': ['artifacts', ['artifact_id', 'section_key', 'title', 'kind', 'author', 'revision', 'last_event_id', 'n_rows', 'content']],
  'transfers.csv': ['transfers', ['transfer_id', 'from_module', 'to_module', 'source_artifact_id', 'source_version', 'target_artifact_id', 'source_run_id', 'evidence_event_ids', 'saved_draft_first', 'confirmed_by', 'idempotency_key', 'created_at']],
  'ratings.csv': ['ratings', ['rating_id', 'target_type', 'target_id', 'run_id', 'rater_code', 'rubric_key', 'rubric_version', 'dimension', 'score', 'score_status', 'note', 'supersedes_rating_id', 'created_at']],
  'agent_trainings.csv': ['agents', ['train_id', 'agent_key', 'status', 'n_docs', 'n_chunks', 'n_chars', 'stages_done', 'created_at', 'finished_at', 'method']],
  'class_profiles.csv': ['agents', ['profile_id', 'name_code', 'n', 'group_size', 'n_groups', 'fields_used', 'columns_dropped', 'created_at', 'is_real_student_data']],
  'metrics.csv': ['metrics', ['run_id', 'module', 'exec_mode', 'n_events', 'n_unique_actors', 'n_human_turns', 'n_model_events', 'n_demo_events', 'n_questions', 'n_challenges', 'n_responses', 'n_revisions', 'n_silences', 'n_ideology_events', 'simulated_class_ms', 'mean_reply_latency_ms', 'active_session_ms', 'is_real_student_learning_time']],
};

function gather(db, user, f) {
  const where = ['owner_id=?'], args = [user.user_id];
  if (f.module) { where.push('module=?'); args.push(f.module); }
  if (f.status) { where.push('status=?'); args.push(f.status); }
  if (f.from) { where.push('created_at>=?'); args.push(new Date(f.from).toISOString()); }
  if (f.to) { where.push('created_at<=?'); args.push(new Date(Date.parse(f.to) + 86399999).toISOString()); }
  let runs = all(db, `SELECT * FROM runs WHERE ${where.join(' AND ')} ORDER BY created_at`, ...args);
  if (Array.isArray(f.run_ids) && f.run_ids.length) runs = runs.filter((r) => f.run_ids.includes(r.run_id));
  const runIds = new Set(runs.map((r) => r.run_id));
  const inRuns = (table) => all(db, `SELECT * FROM ${table} WHERE run_id IN (SELECT run_id FROM runs WHERE owner_id=?)`, user.user_id).filter((x) => runIds.has(x.run_id));
  let events = inRuns('events');
  if (Array.isArray(f.sources) && f.sources.length) events = events.filter((e) => f.sources.includes(e.source));
  const aw = ['owner_id=?'], aa = [user.user_id];
  if (f.module) { aw.push('module=?'); aa.push(f.module); }
  if (f.from) { aw.push('created_at>=?'); aa.push(new Date(f.from).toISOString()); }
  if (f.to) { aw.push('created_at<=?'); aa.push(new Date(Date.parse(f.to) + 86399999).toISOString()); }
  const artifacts = all(db, `SELECT * FROM artifacts WHERE ${aw.join(' AND ')} ORDER BY created_at`, ...aa);
  const transfers = all(db, 'SELECT * FROM transfers WHERE owner_id=? ORDER BY created_at', user.user_id).filter((t) => (!f.module || t.from_module === f.module || t.to_module === f.module) && (!f.from || t.created_at >= new Date(f.from).toISOString()));
  const ratings = all(db, 'SELECT * FROM ratings WHERE owner_id=? ORDER BY created_at', user.user_id).filter((r) => !r.run_id || runIds.has(r.run_id) || artifacts.some((a) => a.artifact_id === r.target_id));
  const trainings = all(db, 'SELECT * FROM agent_trainings WHERE owner_id=? ORDER BY created_at', user.user_id);
  const classProfiles = all(db, 'SELECT profile_id, name, n, group_size, stats, created_at FROM class_profiles WHERE owner_id=? ORDER BY created_at', user.user_id);
  return { trainings, classProfiles, runs, events, profiles: inRuns('agent_profiles'), decisions: inRuns('scheduler_decisions'), challenges: inRuns('challenges'), calls: inRuns('model_calls'), artifacts, transfers, ratings };
}

export function buildPackage(db, user, f = {}) {
  const shared = f.package !== 'full';
  const inc = { artifact_text: !shared && !!f.include_artifact_text, event_text: !shared && !!f.include_event_text, rating_notes: !shared && !!f.include_rating_notes };
  const cats = new Set(Array.isArray(f.categories) && f.categories.length ? f.categories : Object.keys(CATEGORIES));
  const d = gather(db, user, f);
  // Consistent pseudonyms for humans and raters across every table.
  const alias = new Map(); const pseudo = (v, prefix) => { if (!v) return v; const k = `${prefix}:${v}`; if (!alias.has(k)) alias.set(k, `${prefix}${String([...alias.keys()].filter((x) => x.startsWith(prefix + ':')).length + 1).padStart(3, '0')}`); return alias.get(k); };
  const actor = (a) => (a && String(a).startsWith('H-') ? pseudo(a, 'H') : a);
  const OMIT = '[省略]';
  const provenance = { demo: 'synthetic_script', model: 'model_output', human_input: 'human_in_simulation', system: 'system_orchestration', manual_observation: 'manual_unverified' };
  const rows = {};
  rows['runs.csv'] = d.runs.map((r) => ({ ...r, wall_duration_ms: r.started_at && r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : null,
    active_session_ms: r.started_at && r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) - r.paused_ms : null, has_human_intervention: !!r.has_human, config: json(r.config) }));
  rows['events.csv'] = d.events.map((e) => ({ ...e, ideology_terms: json(e.ideology_terms, null), actor_code: actor(e.actor_id), target_actor: actor(e.target_actor), text: inc.event_text ? e.text : OMIT, data_provenance: provenance[e.source] || e.source, is_real_classroom_evidence: false }));
  const humans = [...new Set(d.events.filter((e) => e.actor_type === 'human').map((e) => `${e.run_id}|${e.actor_id}|${e.human_role}`))];
  rows['participants.csv'] = [...d.profiles.map((p) => ({ run_id: p.run_id, actor_code: p.agent_id, kind: p.kind, display_name: p.name, role: p.role, seat: p.seat, group_id: p.group_id, avatar_index: p.avatar, traits: json(p.traits), is_real_person: false })),
    ...humans.map((h) => { const [run_id, a, role] = h.split('|'); return { run_id, actor_code: actor(a), kind: 'human_teacher_user', display_name: '', role: `human_as_${role}`, seat: '', group_id: '', avatar_index: '', traits: '', is_real_person: true }; })];
  rows['scheduler_decisions.csv'] = d.decisions.map((x) => ({ ...x, hands: json(x.hands), top_weights: json(x.top_weights), target_actor: actor(x.target_actor) }));
  const groupOf = Object.fromEntries(d.profiles.map((p) => [`${p.run_id}|${p.agent_id}`, p.group_id]));
  const byId = Object.fromEntries(d.events.map((e) => [e.event_id, e]));
  rows['interaction_edges.csv'] = d.events.flatMap((e) => {
    const out = [];
    if (e.reply_to && byId[e.reply_to]) out.push({ to: byId[e.reply_to].actor_id, type: 'reply_to' });
    if (e.target_actor && !(e.reply_to && byId[e.reply_to]?.actor_id === e.target_actor)) out.push({ to: e.target_actor, type: 'addressed' });
    return out.map((o) => ({ run_id: e.run_id, event_id: e.event_id, from_actor: actor(e.actor_id), to_actor: actor(o.to), edge_type: o.type, from_group: groupOf[`${e.run_id}|${e.actor_id}`] || '', to_group: groupOf[`${e.run_id}|${o.to}`] || '', reply_latency_ms: o.type === 'reply_to' ? e.reply_latency_ms : '' }));
  });
  rows['challenges.csv'] = d.challenges.map((c) => ({ ...c, challenger: actor(c.challenger), target_actor: actor(c.target_actor) }));
  rows['timing_spans.csv'] = [
    ...d.runs.filter((r) => r.started_at).map((r) => ({ run_id: r.run_id, span_type: 'run_wall', ref_id: r.run_id, start: r.started_at, end: r.ended_at, duration_ms: r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) : null, clock_source: 'server_utc' })),
    ...d.runs.filter((r) => r.paused_ms).map((r) => ({ run_id: r.run_id, span_type: 'paused_total', ref_id: r.run_id, duration_ms: r.paused_ms, clock_source: 'server_utc' })),
    ...d.events.filter((e) => e.input_dwell_ms != null).map((e) => ({ run_id: e.run_id, span_type: 'composer_dwell', ref_id: e.event_id, start: e.composer_opened_at, end: e.submitted_at, duration_ms: e.input_dwell_ms, clock_source: 'client_open_server_submit' })),
    ...d.calls.map((c) => ({ run_id: c.run_id, span_type: 'model_call', ref_id: c.call_id, start: c.request_at, end: c.completed_at, duration_ms: c.latency_ms, clock_source: 'server_utc', model_id: c.model_id, request_id: c.request_id, input_tokens: c.input_tokens, output_tokens: c.output_tokens, first_token_at: c.first_token_at, status: c.status, error_code: c.error_code })),
  ];
  rows['artifacts.csv'] = d.artifacts.map((a) => ({ ...a, title: inc.artifact_text ? a.title : OMIT, ai_assisted: !!json(a.body)?.ai_assisted, reviewed_by_teacher: !!a.reviewed_by_teacher }));
  rows['artifact_sections.csv'] = d.artifacts.flatMap((a) => (json(a.body)?.sections || []).map((s) => ({ artifact_id: a.artifact_id, section_key: s.key, title: s.title, kind: s.kind, author: s.author, revision: s.revision || 0, last_event_id: s.last_event_id || '', n_rows: s.kind === 'table' ? s.rows.length : '', content: inc.artifact_text ? (s.kind === 'text' ? s.content : s.rows) : OMIT })));
  rows['transfers.csv'] = d.transfers.map((t) => ({ ...t, evidence_event_ids: json(t.evidence_event_ids), confirmed_by: pseudo(t.confirmed_by, 'H') }));
  const rubrics = Object.fromEntries(all(db, 'SELECT * FROM rubrics WHERE owner_id IS NULL OR owner_id=?', user.user_id).map((r) => [r.rubric_id, r]));
  rows['ratings.csv'] = d.ratings.flatMap((r) => Object.entries(json(r.scores)).map(([dim, v]) => ({ rating_id: r.rating_id, target_type: r.target_type, target_id: r.target_id, run_id: r.run_id, rater_code: pseudo(r.rater_code, 'R'),
    rubric_key: rubrics[r.rubric_id]?.key, rubric_version: r.rubric_version, dimension: dim, score: Number.isInteger(v) ? v : '', score_status: Number.isInteger(v) ? 'scored' : v, note: inc.rating_notes ? r.note : (r.note ? OMIT : ''), supersedes_rating_id: r.supersedes_rating_id, created_at: r.created_at })));
  rows['metrics.csv'] = d.runs.map((r) => {
    const es = d.events.filter((e) => e.run_id === r.run_id), lat = es.filter((e) => e.reply_latency_ms != null);
    const c = (k) => es.filter((e) => e.kind === k).length;
    return { run_id: r.run_id, module: r.module, exec_mode: r.exec_mode, n_events: es.length, n_unique_actors: new Set(es.filter((e) => e.actor_type !== 'system').map((e) => e.actor_id)).size, n_human_turns: es.filter((e) => e.actor_type === 'human').length,
      n_model_events: es.filter((e) => e.source === 'model').length, n_demo_events: es.filter((e) => e.source === 'demo').length, n_questions: c('question'), n_challenges: c('challenge'), n_responses: c('response'), n_revisions: c('revision'), n_silences: c('silence'), n_ideology_events: es.filter((e) => e.ideology_terms && e.ideology_terms !== '[]').length, simulated_class_ms: es.reduce((a, e) => Math.max(a, (e.class_clock_ms ?? 0) + (e.sim_duration_ms ?? 0)), 0) || null,
      mean_reply_latency_ms: lat.length ? Math.round(lat.reduce((a, e) => a + e.reply_latency_ms, 0) / lat.length) : null, active_session_ms: r.started_at && r.ended_at ? Date.parse(r.ended_at) - Date.parse(r.started_at) - r.paused_ms : null, is_real_student_learning_time: false };
  });
  rows['agent_trainings.csv'] = d.trainings.map((t) => { const st = json(t.stats, {}) || {}; return { train_id: t.train_id, agent_key: t.agent_key, status: t.status, n_docs: st.per_file?.length ?? '', n_chunks: st.chunks ?? '', n_chars: st.clean_chars ?? st.chars ?? '', stages_done: (json(t.stages, []) || []).filter((s) => s.status === 'done').length, created_at: t.created_at, finished_at: t.finished_at, method: 'retrieval_and_style_injection_not_fine_tuning' }; });
  const cpAlias = new Map();
  rows['class_profiles.csv'] = d.classProfiles.map((c) => { const st = json(c.stats, {}) || {}; if (!cpAlias.has(c.profile_id)) cpAlias.set(c.profile_id, `CP${String(cpAlias.size + 1).padStart(3, '0')}`); return { profile_id: c.profile_id, name_code: shared ? cpAlias.get(c.profile_id) : c.name, n: c.n, group_size: c.group_size, n_groups: st.groups ?? '', fields_used: st.fields || [], columns_dropped: st.dropped || [], created_at: c.created_at, is_real_student_data: 'anonymous_aggregate_input_teacher_declared' }; });
  const files = {};
  for (const [name, [cat, cols]] of Object.entries(TABLES)) if (cats.has(cat)) files[name] = { rows: rows[name], cols };
  const rubricDefs = all(db, 'SELECT * FROM rubrics WHERE owner_id IS NULL OR owner_id=?', user.user_id).map((r) => ({ rubric_id: r.rubric_id, ...json(r.body), version: r.version }));
  const text = {};
  if (cats.has('ratings')) {
    text['rubric.json'] = JSON.stringify(rubricDefs, null, 2);
    text['rubric.csv'] = csv(rubricDefs.flatMap((r) => r.dimensions.map((dm) => ({ rubric_id: r.rubric_id, rubric_key: r.key, version: r.version, dimension: dm.key, label: dm.label, anchors: dm.anchors.map((a, i) => `${r.scale[0] + i}=${a}`).join('；'), status: r.status }))), ['rubric_id', 'rubric_key', 'version', 'dimension', 'label', 'anchors', 'status']);
  }
  return { files, text, shared, inc, filters: f, counts: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.rows.length])), n_runs: d.runs.length };
}

export function previewPackage(db, user, f) {
  const p = buildPackage(db, user, f);
  const tables = Object.entries(p.files).map(([name, { rows, cols }]) => ({
    name, rows: rows.length, fields: cols,
    missing: Object.fromEntries(cols.map((c) => [c, rows.filter((r) => r[c] == null || r[c] === '').length])),
    sample: rows[0] ? Object.fromEntries(cols.map((c) => [c, typeof rows[0][c] === 'object' && rows[0][c] !== null ? JSON.stringify(rows[0][c]).slice(0, 80) : String(rows[0][c] ?? '').slice(0, 80)])) : null,
  }));
  return { tables, extra_files: Object.keys(p.text), shared: p.shared, includes: p.inc };
}

export function exportZip(db, user, f) {
  const p = buildPackage(db, user, f);
  const out = {};
  for (const [name, { rows, cols }] of Object.entries(p.files)) out[name] = csv(rows, cols);
  Object.assign(out, p.text);
  const dataset = { schema_version: SCHEMA_VERSION, app_version: APP_VERSION, exported_at: now(), package: p.shared ? 'shared_pseudonymized' : 'full_research', tables: Object.fromEntries(Object.entries(p.files).map(([k, v]) => [k.replace('.csv', ''), v.rows])) };
  out['dataset.json'] = JSON.stringify(dataset, null, 2);
  const empty = Object.entries(p.counts).filter(([, n]) => n === 0).map(([k]) => k);
  out['README.md'] = readme(p, empty);
  out['data-dictionary.md'] = DICTIONARY;
  const sha = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
  const manifest = { app_version: APP_VERSION, schema_version: SCHEMA_VERSION, scheduler_distribution_version: DISTRIBUTION_VERSION, rubric_versions: JSON.parse(p.text['rubric.json'] || '[]').map((r) => `${r.key}@${r.version}`),
    exported_at: dataset.exported_at, exporter: 'teacher_self_export', package: dataset.package, filters: p.filters, includes: p.inc,
    files: Object.entries(out).map(([name, content]) => ({ name, rows: p.counts[name] ?? null, bytes: Buffer.byteLength(content, 'utf8'), sha256: sha(content) })),
    note: 'SHA-256 由导出时实际文件内容计算（不含 manifest.json 自身），用于检验文件是否被改动；不是外部时间戳或真实性认证。' };
  out['manifest.json'] = JSON.stringify(manifest, null, 2);
  audit(db, { actor: user, action: 'research_export', target_type: 'export', target_id: null, detail: { package: dataset.package, counts: p.counts } });
  return zip(Object.entries(out).map(([name, data]) => ({ name, data })));
}

function readme(p, empty) {
  return brandText(`# 研思智境研究数据包

- 包类型：${p.shared ? '共享包（默认假名化，不含自由文本）' : '完整研究包（教师主动选择）'}
- 包含正文：产物正文 ${p.inc.artifact_text ? '是' : '否'}；发言正文 ${p.inc.event_text ? '是' : '否'}；评分备注 ${p.inc.rating_notes ? '是' : '否'}。省略处记为「[省略]」。
- 真人（教师用户）以 H001… 表示，评价者以 R001… 表示，同一人在所有表中编码一致；模拟角色（M*/S*/T）为虚构智能体，不是真实学生。
- 不包含：API Key、登录名、密码、会话令牌、积分流水、管理员审计。

## 数据来源（data_provenance）

- synthetic_script：预设演示脚本/模板骨架（未调用模型）
- model_output：真实模型输出（model_call_id 可追溯到 timing_spans 中的调用记录）
- human_in_simulation：真人在模拟环境中的输入
- system_orchestration：系统编排消息（组长分派/轮询、沉默事件）

## 研究边界

- 模拟学生数量不是人类样本量；账号在线时长不是学习时长；模型自评不能作为人工独立评审。
- 未测量：真实学习时长、语音时长、前后测、认知负荷、学习成效。本包没有这些字段，也没有用模拟数据推断。
- 量规为草案，未经效度验证；未计算总分、p 值、学习增益或评分者一致性。未评/不适用/证据不足（score_status）不是 0。
- 固定 seed 可复现调度抽样（scheduler_decisions），不代表可复现模型文本。

## 空表

${empty.length ? empty.map((n) => `- ${n}：0 条（本筛选范围内未采集或无记录，未填造示例）`).join('\n') : '- 无'}
`);
}

const DICTIONARY = `# 数据字典（schema ${SCHEMA_VERSION}）

所有时间为 ISO 8601 UTC，服务端时钟（composer_opened_at 来自浏览器时钟并由服务端校验格式）。ID 为随机标识；外键：events.run_id→runs，events.reply_to→events，scheduler_decisions.run_id→runs，artifacts.parent_id→artifacts，transfers.*_artifact_id→artifacts，ratings.target_id→events/artifacts。

| 表 | 字段 | 口径与边界 |
|---|---|---|
| runs | wall_duration_ms | 开始至结束墙钟时间，包含暂停与等待，不等于学习投入 |
| runs | paused_ms / active_session_ms | 暂停累计；active = wall − paused |
| runs | model_calls | 成功的真实模型调用数（演示模式为 0） |
| runs | config | 运行配置快照（含随机 seed、互动自由度等） |
| events | sequence / elapsed_ms / inter_event_ms | 同一运行内序号；距开始毫秒；与上一事件间隔（不是思考时间） |
| events | reply_to / reply_latency_ms | 被回应事件；回应间隔（不代表推理时间） |
| events | composer_opened_at / submitted_at / input_dwell_ms | 真人打开输入框至提交；输入框停留不是思考时长 |
| events | source / data_provenance | demo/model/human_input/system 与其研究含义 |
| events | decision_id | 对应的调度决策（课堂） |
| events | class_clock_ms / sim_duration_ms | **模拟课时时钟**：该发言在设定课时中的开始时刻与占用时长（按字数与动作估算），不是真实学习时长 |
| events | ideology_terms | 发言中命中的课程思政词表（课程思政元素 + 通用词表），仅为词面匹配，不代表思政融入质量 |
| metrics | n_ideology_events / simulated_class_ms | 含思政词的事件数；演课场（课堂试验场）已进行的模拟课时 |
| scheduler_decisions | trigger / n_eligible / speak_probability / draw | 参与机会的触发类型、合格候选数、发言概率、随机抽样值（draw < p 则有人发言） |
| scheduler_decisions | hands / selected_agent / action / top_weights | 举手意图（≤3）、选中者、动作、前 8 名权重；只记录可追踪的选择依据，不保存或要求模型思维链 |
| scheduler_decisions | distribution_version | 调度分布算法版本 |
| interaction_edges | edge_type | reply_to（回应某事件）或 addressed（指向某角色） |
| challenges | human_resolution | 教师人工标记；有回复不等于有效解决 |
| timing_spans | model_call | request_at→completed_at、first_token_at、token 数、request_id，仅记录真实返回值，未知为空 |
| artifacts / artifact_sections | version / parent_id / author / revision | 版本不可覆盖；段落作者与修订次数 |
| transfers | idempotency_key / confirmed_by | 箭头流转的幂等键与确认教师（假名） |
| ratings | score / score_status | 0—4 分；not_rated/not_applicable/insufficient_evidence 不是 0；supersedes_rating_id 为重评链 |
| metrics | is_real_student_learning_time | 恒为 false |
| events | stage | 研课八步阶段键（assign/discuss/draft/debate/revise/integrate/review/finalize）或课堂环节键 |
| agent_trainings | method | 教师资料训练为“检索 + 风格注入”，不是模型微调；只导出元数据，不导出资料正文 |
| class_profiles | name_code / is_real_student_data | 共享包中班级名以 CP001… 代替；画像为教师导入的匿名群体特征，不含姓名学号 |

旧字段缺失保留为空，不用当前时间倒填。
`;

// ---------- teacher backup / restore ----------
// 科研数据中心的表为可选：旧备份没有这些表时照常恢复。
const STUDY_TABLES = ['study_projects', 'study_participants', 'study_instruments', 'study_items', 'study_responses', 'study_codebooks', 'study_codes', 'study_units', 'study_codings'];
const BACKUP_TABLES = ['materials', 'artifacts', 'module_state', 'transfers', 'runs', 'agent_profiles', 'events', 'scheduler_decisions', 'challenges', 'ratings', 'custom_modes', 'rubrics'];
export function backup(db, user) {
  const u = user.user_id;
  const runs = all(db, 'SELECT * FROM runs WHERE owner_id=?', u);
  const rid = new Set(runs.map((r) => r.run_id));
  const byRun = (t) => all(db, `SELECT * FROM ${t}`).filter((x) => rid.has(x.run_id));
  return { format: 'yanzhi-teacher-backup', schema_version: SCHEMA_VERSION, exported_at: now(), owner_pseudonym: user.pseudonym,
    note: '完整个人备份（不含账号凭据、积分与密钥）。恢复时只归属到当前登录账号。',
    data: { materials: all(db, 'SELECT * FROM materials WHERE owner_id=?', u), artifacts: all(db, 'SELECT * FROM artifacts WHERE owner_id=?', u), module_state: all(db, 'SELECT * FROM module_state WHERE owner_id=?', u), transfers: all(db, 'SELECT * FROM transfers WHERE owner_id=?', u),
      runs: runs.map((r) => ({ ...r, reservation_id: null })), agent_profiles: byRun('agent_profiles'), events: all(db, 'SELECT * FROM events WHERE owner_id=?', u), scheduler_decisions: byRun('scheduler_decisions'), challenges: byRun('challenges'),
      ratings: all(db, 'SELECT * FROM ratings WHERE owner_id=?', u), custom_modes: all(db, 'SELECT * FROM custom_modes WHERE owner_id=?', u), rubrics: all(db, 'SELECT * FROM rubrics WHERE owner_id=?', u),
      ...Object.fromEntries(STUDY_TABLES.map((t) => [t, all(db, `SELECT * FROM ${t} WHERE owner_id=?`, u)])) } };
}

const PK = { study_projects: 'project_id', study_participants: 'participant_id', study_instruments: 'instrument_id', study_items: 'item_id', study_responses: 'response_id', study_codebooks: 'codebook_id', study_units: 'unit_id', study_codings: 'coding_id', materials: 'material_id', artifacts: 'artifact_id', transfers: 'transfer_id', runs: 'run_id', events: 'event_id', scheduler_decisions: 'decision_id', challenges: 'challenge_id', ratings: 'rating_id', custom_modes: 'mode_id', rubrics: 'rubric_id' };

/** Validate + plan a restore. Returns {ok, errors, counts, conflicts}. Never writes. */
export function planRestore(db, user, input) {
  const errors = [];
  if (input?.format === 'yanzhi-teacher-backup') {
    const d = input.data || {};
    if (!Array.isArray(d.materials)) d.materials = []; // backups made before materials existed
    for (const t of STUDY_TABLES) if (!Array.isArray(d[t])) d[t] = []; // backups made before the research center existed
    for (const t of BACKUP_TABLES) if (!Array.isArray(d[t])) errors.push(`缺少数据表 ${t}`);
    if (errors.length) return { ok: false, errors };
    const ids = (t) => new Set(d[t].map((x) => x[PK[t]]));
    const art = ids('artifacts'), runs = ids('runs'), evs = ids('events');
    for (const t of Object.keys(PK)) if (ids(t).size !== d[t].length) errors.push(`${t} 存在重复ID`);
    for (const a of d.artifacts) { if (a.parent_id && !art.has(a.parent_id)) errors.push(`产物 ${a.artifact_id} 的父版本缺失`); if (!a.body || !json(a.body)) errors.push(`产物 ${a.artifact_id} 正文结构无效`); }
    for (const e of d.events) { if (!runs.has(e.run_id)) errors.push(`事件 ${e.event_id} 的运行缺失`); if (e.reply_to && !evs.has(e.reply_to)) errors.push(`事件 ${e.event_id} 的回复引用缺失`); }
    for (const t of d.transfers) if (!art.has(t.source_artifact_id) || !art.has(t.target_artifact_id)) errors.push(`流转 ${t.transfer_id} 的产物引用缺失`);
    for (const r of d.ratings) if (r.target_type === 'event' ? !evs.has(r.target_id) : !art.has(r.target_id)) errors.push(`评分 ${r.rating_id} 的对象缺失`);
    const conflicts = [], foreign = [];
    for (const t of Object.keys(PK)) for (const row of d[t]) {
      const ex = one(db, `SELECT * FROM ${t} WHERE ${PK[t]}=?`, row[PK[t]]);
      if (!ex) continue;
      const owner = ex.owner_id ?? one(db, 'SELECT owner_id FROM runs WHERE run_id=?', ex.run_id)?.owner_id;
      if (owner && owner !== user.user_id) foreign.push(`${t}:${row[PK[t]]}`); else conflicts.push(`${t}:${row[PK[t]]}`);
    }
    if (foreign.length) errors.push(`${foreign.length} 条记录ID属于其他账号，已拒绝（不跨账号归属）`);
    return { ok: !errors.length, errors: errors.slice(0, 50), format: 'teacher_backup', counts: Object.fromEntries(Object.keys(PK).map((t) => [t, d[t].length])), conflicts: conflicts.length, conflict_policy: '已存在的相同记录将跳过，不覆盖' };
  }
  if (input?.schema_version === '1.0.0' && Array.isArray(input.artifacts)) {
    // Legacy v2 localStorage study.
    for (const k of ['artifacts', 'runs', 'events', 'ratings', 'transfers']) if (!Array.isArray(input[k])) errors.push(`旧数据缺少 ${k}`);
    if (errors.length) return { ok: false, errors };
    const art = new Set(input.artifacts.map((a) => a.artifact_id)), runs = new Set(input.runs.map((r) => r.run_id)), evs = new Set(input.events.map((e) => e.event_id));
    if (art.size !== input.artifacts.length || runs.size !== input.runs.length || evs.size !== input.events.length) errors.push('旧数据存在重复ID');
    for (const a of input.artifacts) { if (!['seminar', 'classroom'].includes(a.scene)) errors.push(`旧方案 ${a.artifact_id} 场景无效`); if (a.parent_id && !art.has(a.parent_id)) errors.push(`旧方案 ${a.artifact_id} 父方案缺失`); }
    for (const r of input.runs) if (!art.has(r.input_artifact_id)) errors.push(`旧运行 ${r.run_id} 输入方案缺失`);
    for (const e of input.events) { if (!runs.has(e.run_id)) errors.push(`旧事件 ${e.event_id} 运行缺失`); if (e.reply_to && !evs.has(e.reply_to)) errors.push(`旧事件 ${e.event_id} 回复引用缺失`); }
    for (const r of input.ratings) if (!evs.has(r.event_id)) errors.push(`旧评分 ${r.rating_id} 事件缺失`);
    let conflicts = 0;
    for (const a of input.artifacts) if (one(db, 'SELECT owner_id FROM artifacts WHERE artifact_id=?', `legacy_${a.artifact_id}`)) conflicts++;
    return { ok: !errors.length, errors: errors.slice(0, 50), format: 'legacy_v2_local', counts: { artifacts: input.artifacts.length, runs: input.runs.length, events: input.events.length, ratings: input.ratings.length, transfers: input.transfers.length }, conflicts, conflict_policy: '已迁移过的记录将跳过（不重复导入）' };
  }
  return { ok: false, errors: ['无法识别的文件：既不是研思智境（原“研思智境”）v3 个人备份，也不是旧版本地数据'] };
}

/**
 * Column whitelist for restore/migration INSERTs.
 * Backup JSON is user-supplied, so its keys must never reach SQL text directly.
 * We accept only columns that actually exist on the target table, and we build
 * the statement from the schema order rather than from the payload order.
 * Cached per (db, table): the schema is fixed for the life of the connection.
 */
const COLUMN_CACHE = new WeakMap();
function tableInfo(db, table) {
  let byTable = COLUMN_CACHE.get(db);
  if (!byTable) { byTable = new Map(); COLUMN_CACHE.set(db, byTable); }
  let info = byTable.get(table);
  if (!info) {
    const rows = all(db, `PRAGMA table_info("${table}")`);
    info = { all: new Set(rows.map((c) => c.name)), required: rows.filter((c) => c.notnull && c.dflt_value === null && !c.pk).map((c) => c.name) };
    byTable.set(table, info);
  }
  return info;
}
function tableColumns(db, table) { return tableInfo(db, table).all; }

/**
 * Build a parameterised INSERT for `table` from a payload row, keeping only
 * column names that exist on the target table. Returns null when the row has
 * no usable column, so callers can skip rather than emit invalid SQL.
 */
function insertRow(db, table, row) {
  const info = tableInfo(db, table);
  const cols = Object.keys(row).filter((c) => info.all.has(c));
  if (!cols.length) return null;
  const missing = info.required.filter((c) => !cols.includes(c));
  if (missing.length) fail(400, 'invalid_backup', `备份缺少必要字段：${table}.${missing.join('、')}`);
  const sql = `INSERT INTO "${table}"(${cols.map((c) => `"${c}"`).join(',')}) VALUES(${cols.map(() => '?').join(',')})`;
  return { sql, values: cols.map((c) => row[c]) };
}

/** Restore/migrate atomically; any error rolls back everything (no partial overwrite). */
export function restore(db, user, input, { confirm_ownership }) {
  check(confirm_ownership === true, 400, 'confirm_required', '请确认将这些历史数据归属到当前账号');
  const plan = planRestore(db, user, input);
  check(plan.ok, 400, 'invalid_backup', `备份校验失败：${plan.errors.join('；')}`);
  return tx(db, () => {
    let inserted = 0, skipped = 0;
    const dropped = new Set();
    const put = (table, row) => {
      const pk = PK[table];
      if (pk && one(db, `SELECT 1 FROM ${table} WHERE ${pk}=?`, row[pk])) { skipped++; return; }
      const valid = tableColumns(db, table);
      for (const c of Object.keys(row)) if (!valid.has(c)) dropped.add(`${table}.${c}`);
      const stmt = insertRow(db, table, row);
      if (!stmt) { skipped++; return; }
      run(db, stmt.sql, ...stmt.values);
      inserted++;
    };
    if (plan.format === 'teacher_backup') {
      const d = input.data;
      const own = (r) => ({ ...r, owner_id: user.user_id });
      for (const t of ['materials', 'artifacts', 'runs', 'transfers', 'custom_modes', 'rubrics', 'ratings', ...STUDY_TABLES.filter((x) => x !== 'study_codes')]) for (const r of d[t] || []) put(t, own(r));
      for (const r of d.study_codes || []) {
        if (one(db, 'SELECT 1 FROM study_codes WHERE codebook_id=? AND code=?', r.codebook_id, r.code)) { skipped++; continue; }
        const row = own(r);
        const valid = tableColumns(db, 'study_codes');
        for (const c of Object.keys(row)) if (!valid.has(c)) dropped.add(`study_codes.${c}`);
        const stmt = insertRow(db, 'study_codes', row);
        if (!stmt) { skipped++; continue; }
        run(db, stmt.sql, ...stmt.values);
        inserted++;
      }
      for (const t of ['agent_profiles', 'scheduler_decisions', 'challenges']) for (const r of d[t]) {
        if (t === 'agent_profiles') {
          if (one(db, 'SELECT 1 FROM agent_profiles WHERE run_id=? AND agent_id=?', r.run_id, r.agent_id)) { skipped++; continue; }
          const valid = tableColumns(db, 'agent_profiles');
          for (const c of Object.keys(r)) if (!valid.has(c)) dropped.add(`agent_profiles.${c}`);
          const stmt = insertRow(db, 'agent_profiles', r);
          if (!stmt) { skipped++; continue; }
          run(db, stmt.sql, ...stmt.values);
          inserted++;
        }
        else put(t, r);
      }
      for (const r of d.events) put('events', { ...r, owner_id: user.user_id });
      for (const r of d.runs) if (['running', 'awaiting_human'].includes(r.status)) run(db, "UPDATE runs SET status='paused', stop_reason='restored' WHERE run_id=?", r.run_id);
    } else {
      // Legacy v2 → v3 mapping. IDs are prefixed so re-running the migration is idempotent.
      const L = (x) => (x ? `legacy_${x}` : null);
      const artTitle = Object.fromEntries(input.artifacts.map((a) => [a.artifact_id, a]));
      const lineage = {};
      for (const a of input.artifacts) {
        let root = a; const seen = new Set(); while (root.parent_id && artTitle[root.parent_id] && !seen.has(root.artifact_id)) { seen.add(root.artifact_id); root = artTitle[root.parent_id]; }
        lineage[a.artifact_id] = L(root.artifact_id);
      }
      for (const a of input.artifacts) put('artifacts', { artifact_id: L(a.artifact_id), owner_id: user.user_id, lineage_id: lineage[a.artifact_id], module: a.scene, type: 'legacy_plan', title: String(a.title).slice(0, 120),
        body: JSON.stringify({ course: {}, framework: null, with_pdca: false, template: { key: 'legacy_plan', version: 1 }, sections: [{ key: 'content', title: '方案正文', kind: 'text', content: String(a.content || ''), author: null, revision: 0 }], current_unit: null, ai_assisted: false, notice: '由旧版本地原型迁移' }),
        framework_key: null, framework_version: null, template_version: 1, status: 'saved', version: a.version || 1, parent_id: L(a.parent_id), source_run_id: L(a.origin_run_id), origin: 'legacy_v2_migration', reviewed_by_teacher: 0, created_at: a.created_at, updated_at: a.created_at, saved_at: a.created_at });
      for (const r of input.runs) put('runs', { run_id: L(r.run_id), owner_id: user.user_id, module: r.scene, exec_mode: 'legacy_demo', status: r.status === 'running' ? 'paused' : r.status || 'completed', input_artifact_id: L(r.input_artifact_id),
        input_snapshot: JSON.stringify(r.input_snapshot || null), config: JSON.stringify({ legacy_settings: r.settings_snapshot || null, interaction_mode: r.interaction_mode || null }), plan: null, state: null, seed: null, budget_calls: 0, created_at: r.created_at, started_at: r.started_at || r.created_at, ended_at: r.ended_at || null, paused_ms: 0, model_calls: 0, has_human: r.has_human_intervention ? 1 : 0, stop_reason: 'legacy_migration' });
      for (const e of input.events) put('events', { event_id: L(e.event_id), run_id: L(e.run_id), owner_id: user.user_id, sequence: e.sequence, time: e.time, elapsed_ms: e.elapsed_ms ?? null, inter_event_ms: e.interval_from_prev_ms ?? null,
        actor_id: e.actor_type === 'human' ? `H-${user.pseudonym}` : `LEGACY:${String(e.actor_code || '').slice(0, 40)}`, actor_type: e.actor_type === 'human' ? 'human' : 'scripted_agent', source: e.source === 'demo' ? 'demo' : e.source === 'human_input' ? 'human_input' : 'manual_observation',
        human_role: e.actor_type === 'human' ? 'teacher' : null, kind: e.kind, text: e.text, reply_to: L(e.reply_to), reply_latency_ms: e.response_latency_ms ?? null, target_actor: e.target_actor || null, target_ref: e.evidence_reference || null, group_id: e.group_id || null, stage: e.task_role || null,
        composer_opened_at: null, submitted_at: null, input_dwell_ms: e.input_duration_ms ?? null, model_call_id: null, decision_id: null });
      const rub = RUBRIC_V1.dimensions.map((dm) => dm.key);
      for (const r of input.ratings) put('ratings', { rating_id: L(r.rating_id), owner_id: user.user_id, target_type: 'event', target_id: L(r.event_id), run_id: L(r.run_id), rater_code: String(r.rater_code).slice(0, 20), rubric_id: 'rubric_builtin_v1', rubric_version: 1,
        scores: JSON.stringify(Object.fromEntries(rub.map((k) => [k, Number.isInteger(r.rubric_scores?.[k]) ? r.rubric_scores[k] : 'not_rated']))), note: [r.note, r.verdict && `旧版判断：${r.verdict}`, r.score != null && `旧版总评分：${r.score}`].filter(Boolean).join('；'), supersedes_rating_id: L(r.supersedes_rating_id), created_at: r.time });
      for (const t of input.transfers) put('transfers', { transfer_id: L(t.transfer_id), owner_id: user.user_id, from_module: t.from_scene, to_module: t.to_scene, source_artifact_id: L(t.source_artifact_id), source_version: null, target_artifact_id: L(t.target_artifact_id), source_run_id: L(t.from_run_id),
        evidence_event_ids: JSON.stringify((t.selected_event_ids || []).map(L)), saved_draft_first: 0, idempotency_key: `legacy_${t.transfer_id}`, confirmed_by: user.pseudonym, created_at: t.time });
    }
    audit(db, { actor: user, action: plan.format === 'teacher_backup' ? 'backup_restored' : 'legacy_migrated', target_type: 'user', target_id: user.user_id, detail: { inserted, skipped, dropped_columns: [...dropped].slice(0, 50) } });
    return { inserted, skipped, format: plan.format, dropped_columns: [...dropped].slice(0, 50) };
  });
}
