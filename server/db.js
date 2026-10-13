// SQLite storage (node:sqlite). Single source of truth for accounts, credits and research data.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export const id = (p) => `${p}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
export const now = () => new Date().toISOString();

const SCHEMA = [
  // ---- accounts ----
  `CREATE TABLE IF NOT EXISTS users(
    user_id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
    is_teacher INTEGER NOT NULL DEFAULT 1, is_admin INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active', password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1,
    pseudonym TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, created_by TEXT, last_login_at TEXT, password_changed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions(
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), scope TEXT NOT NULL,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS system_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)`,
  // ---- credits ----
  `CREATE TABLE IF NOT EXISTS credit_accounts(
    user_id TEXT PRIMARY KEY REFERENCES users(user_id), total_balance INTEGER NOT NULL DEFAULT 0,
    reserved_balance INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    CHECK(total_balance >= 0), CHECK(reserved_balance >= 0), CHECK(reserved_balance <= total_balance))`,
  `CREATE TABLE IF NOT EXISTS credit_ledger(
    entry_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), type TEXT NOT NULL,
    amount INTEGER NOT NULL, reserved_delta INTEGER NOT NULL DEFAULT 0, total_after INTEGER NOT NULL, reserved_after INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE, reservation_id TEXT, run_id TEXT, call_id TEXT, batch_id TEXT,
    reason TEXT, actor_id TEXT, related_entry_id TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS reservations(
    reservation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id), run_id TEXT,
    amount INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, inflight INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open', rate INTEGER NOT NULL, pricing_version INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, closed_at TEXT, close_reason TEXT)`,
  // ---- models ----
  `CREATE TABLE IF NOT EXISTS model_configs(
    provider_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL, model_id TEXT NOT NULL,
    capability TEXT NOT NULL DEFAULT 'chat', enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
    concurrency INTEGER NOT NULL DEFAULT 2, timeout_ms INTEGER NOT NULL DEFAULT 60000, max_tokens INTEGER NOT NULL DEFAULT 1200,
    credit_rate INTEGER NOT NULL DEFAULT 1, cost_info TEXT, key_ciphertext TEXT, key_iv TEXT, key_tag TEXT, key_last4 TEXT,
    key_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS model_calls(
    call_id TEXT PRIMARY KEY, run_id TEXT, user_id TEXT NOT NULL, provider_id TEXT, model_id TEXT, key_version INTEGER,
    purpose TEXT, actor_id TEXT, status TEXT NOT NULL, error_code TEXT, error_message TEXT,
    request_at TEXT, first_token_at TEXT, completed_at TEXT, latency_ms INTEGER,
    input_tokens INTEGER, output_tokens INTEGER, request_id TEXT, credits INTEGER NOT NULL DEFAULT 0,
    reservation_id TEXT, retry_of TEXT, idempotency_key TEXT UNIQUE, event_id TEXT)`,
  // ---- templates ----
  `CREATE TABLE IF NOT EXISTS template_versions(
    template_version_id TEXT PRIMARY KEY, kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL,
    name TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published', owner_id TEXT,
    created_at TEXT NOT NULL, created_by TEXT, UNIQUE(kind, key, version, owner_id))`,
  // ---- teaching data ----
  `CREATE TABLE IF NOT EXISTS artifacts(
    artifact_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), lineage_id TEXT NOT NULL,
    module TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
    framework_key TEXT, framework_version INTEGER, template_version INTEGER,
    status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL, parent_id TEXT, source_run_id TEXT,
    origin TEXT NOT NULL, reviewed_by_teacher INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, saved_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS module_state(
    owner_id TEXT NOT NULL, module TEXT NOT NULL, current_artifact_id TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id, module))`,
  `CREATE TABLE IF NOT EXISTS transfers(
    transfer_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, from_module TEXT NOT NULL, to_module TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL, source_version INTEGER, target_artifact_id TEXT NOT NULL, source_run_id TEXT,
    evidence_event_ids TEXT NOT NULL DEFAULT '[]', saved_draft_first INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT NOT NULL UNIQUE, confirmed_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS runs(
    run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, module TEXT NOT NULL, exec_mode TEXT NOT NULL, status TEXT NOT NULL,
    input_artifact_id TEXT, input_snapshot TEXT, config TEXT NOT NULL, plan TEXT, state TEXT, seed TEXT,
    budget_calls INTEGER NOT NULL DEFAULT 0, reservation_id TEXT, provider_id TEXT, rate INTEGER, pricing_version INTEGER,
    output_artifact_id TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, paused_at TEXT,
    paused_ms INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT, model_calls INTEGER NOT NULL DEFAULT 0,
    has_human INTEGER NOT NULL DEFAULT 0, stop_reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS agent_profiles(
    run_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, role TEXT, seat INTEGER,
    group_id TEXT, avatar INTEGER, traits TEXT, PRIMARY KEY(run_id, agent_id))`,
  `CREATE TABLE IF NOT EXISTS events(
    event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, owner_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    time TEXT NOT NULL, elapsed_ms INTEGER, inter_event_ms INTEGER, actor_id TEXT NOT NULL, actor_type TEXT NOT NULL,
    source TEXT NOT NULL, human_role TEXT, kind TEXT NOT NULL, text TEXT NOT NULL, reply_to TEXT, reply_latency_ms INTEGER,
    target_actor TEXT, target_ref TEXT, group_id TEXT, stage TEXT, composer_opened_at TEXT, submitted_at TEXT,
    input_dwell_ms INTEGER, model_call_id TEXT, decision_id TEXT, UNIQUE(run_id, sequence))`,
  `CREATE TABLE IF NOT EXISTS scheduler_decisions(
    decision_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step INTEGER NOT NULL, time TEXT NOT NULL, trigger TEXT NOT NULL,
    trigger_event_id TEXT, seed TEXT, n_candidates INTEGER, n_eligible INTEGER, speak_probability REAL, draw REAL,
    hands TEXT, selected_agent TEXT, action TEXT, target_actor TEXT, target_event_id TEXT, group_id TEXT,
    cooldown INTEGER, top_weights TEXT, distribution_version TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS challenges(
    challenge_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, challenger TEXT NOT NULL, target_actor TEXT, target_ref TEXT,
    challenge_event_id TEXT NOT NULL, response_event_id TEXT, revision_event_id TEXT, human_resolution TEXT,
    opened_at TEXT NOT NULL, closed_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS custom_modes(
    mode_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rubrics(
    rubric_id TEXT PRIMARY KEY, owner_id TEXT, key TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL,
    body TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(owner_id, key, version))`,
  `CREATE TABLE IF NOT EXISTS ratings(
    rating_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, run_id TEXT,
    rater_code TEXT NOT NULL, rubric_id TEXT NOT NULL, rubric_version INTEGER NOT NULL, scores TEXT NOT NULL,
    note TEXT, supersedes_rating_id TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log(
    audit_id TEXT PRIMARY KEY, time TEXT NOT NULL, actor_id TEXT, actor_role TEXT, action TEXT NOT NULL,
    target_type TEXT, target_id TEXT, detail TEXT, ip TEXT, request_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS idempotency(
    key TEXT PRIMARY KEY, user_id TEXT NOT NULL, scope TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS materials(
    material_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(user_id), kind TEXT NOT NULL, filename TEXT NOT NULL,
    ext TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, text TEXT NOT NULL, n_chars INTEGER NOT NULL,
    pii_flags TEXT, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ix_events_run ON events(run_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS ix_ledger_user ON credit_ledger(user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS ix_artifacts_owner ON artifacts(owner_id, module)`,
  `CREATE INDEX IF NOT EXISTS ix_runs_owner ON runs(owner_id, module)`,
];

export const DEFAULT_SETTINGS = {
  signup_bonus: '100',          // 新教师账号一次性赠送
  self_register: '0',           // 教师自助注册，默认关闭
  pricing_version: '1',         // 费率版本，修改费率时递增
  max_calls_per_task: '60',     // 单任务调用上限
  session_idle_minutes: '720',
  stale_run_minutes: '120',
  assistant_model: '1',         // 数字客服思思使用平台共享的大模型（0 = 只用本地知识库）
  assistant_hourly_limit: '30', // 每位教师每小时的大模型问答次数，超出后用本地知识库回答
};

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db._txDepth = 0;
  for (const sql of SCHEMA) db.exec(sql);
  // additive migrations for databases created by earlier versions
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const addCol = (t, c, type) => { if (!cols(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${type}`); };
  addCol('events', 'class_clock_ms', 'INTEGER');
  addCol('events', 'sim_duration_ms', 'INTEGER');
  addCol('events', 'ideology_terms', 'TEXT');
  addCol('users', 'avatar_key', 'TEXT');
  const put = db.prepare('INSERT OR IGNORE INTO system_settings(key,value,updated_at) VALUES(?,?,?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) put.run(k, v, now());
  return db;
}

/** Run fn inside a transaction; nested calls use savepoints. fn must be synchronous. */
export function tx(db, fn) {
  const depth = db._txDepth++;
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('tx callback must be synchronous');
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  } finally {
    db._txDepth--;
  }
}

export const one = (db, sql, ...a) => db.prepare(sql).get(...a);
export const all = (db, sql, ...a) => db.prepare(sql).all(...a);
export const run = (db, sql, ...a) => db.prepare(sql).run(...a);

export function getSetting(db, key) {
  const r = one(db, 'SELECT value FROM system_settings WHERE key=?', key);
  return r ? r.value : DEFAULT_SETTINGS[key];
}
export function setSetting(db, key, value, actor) {
  run(db, 'INSERT INTO system_settings(key,value,updated_at,updated_by) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by', key, String(value), now(), actor || null);
}

export class HttpError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const fail = (status, code, message, extra) => { throw new HttpError(status, code, message, extra); };
export const check = (cond, status, code, message) => { if (!cond) fail(status, code, message); };

export function audit(db, { actor, action, target_type, target_id, detail, ip, request_id }) {
  run(db, 'INSERT INTO audit_log(audit_id,time,actor_id,actor_role,action,target_type,target_id,detail,ip,request_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id('audit'), now(), actor?.user_id || null, actor ? (actor.is_admin && actor.scope === 'admin' ? 'admin' : 'teacher') : null,
    action, target_type || null, target_id || null, detail ? JSON.stringify(detail) : null, ip || null, request_id || null);
}

export const json = (v, d = null) => { if (v == null) return d; try { return JSON.parse(v); } catch { return d; } };
