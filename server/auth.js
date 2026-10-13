// Authentication: scrypt password hashes, opaque session tokens (hash stored), login throttling.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { one, all, run, id, now, tx, fail, check, getSetting, audit } from './db.js';
import { grantInitial } from './credits.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const ABSOLUTE_SESSION_MS = 7 * 24 * 3600e3;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  const dk = scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const dk = scryptSync(pw, Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(dk, expected);
}
export function checkPasswordPolicy(pw) {
  check(typeof pw === 'string' && pw.length >= 8 && pw.length <= 128, 400, 'weak_password', '密码需 8—128 位');
  check(/[A-Za-z]/.test(pw) && /\d/.test(pw), 400, 'weak_password', '密码需同时包含字母和数字');
}
const tokenHash = (t) => createHash('sha256').update(t).digest('hex');

// ---- throttling (in-memory; per login and per IP) ----
const attempts = new Map();
const WINDOW = 15 * 60e3, MAX_FAIL = 5;
function throttled(key) {
  const a = attempts.get(key); if (!a) return false;
  if (Date.now() - a.first > WINDOW) { attempts.delete(key); return false; }
  return a.count >= MAX_FAIL;
}
function noteFail(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW) attempts.set(key, { first: Date.now(), count: 1 }); else a.count++;
}
export function resetThrottle() { attempts.clear(); }

// ---- users ----
function newPseudonym(db) {
  for (;;) { const p = 'T' + randomBytes(3).toString('hex').toUpperCase(); if (!one(db, 'SELECT 1 FROM users WHERE pseudonym=?', p)) return p; }
}
export function publicUser(u) {
  if (!u) return null;
  return { user_id: u.user_id, login: u.login, display_name: u.display_name, is_teacher: !!u.is_teacher, is_admin: !!u.is_admin,
    status: u.status, must_change_password: !!u.must_change_password, pseudonym: u.pseudonym, created_at: u.created_at, last_login_at: u.last_login_at, avatar_key: u.avatar_key || null };
}
export const AVATAR_KEYS = Array.from({ length: 12 }, (_, i) => `u${String(i + 1).padStart(2, '0')}`);
export function setAvatar(db, user, key) {
  check(AVATAR_KEYS.includes(key), 400, 'bad_avatar', '请从 12 个头像中选择');
  run(db, 'UPDATE users SET avatar_key=? WHERE user_id=?', key, user.user_id);
}
export function createUser(db, { login, display_name, password, is_teacher = true, is_admin = false, must_change_password = true, avatar_key = null }, actor) {
  login = String(login || '').trim();
  check(/^[A-Za-z0-9_.@-]{3,40}$/.test(login), 400, 'bad_login', '登录名需 3—40 位字母、数字或 _.@-');
  checkPasswordPolicy(password);
  check(!one(db, 'SELECT 1 FROM users WHERE login=?', login), 409, 'login_taken', '登录名已存在');
  return tx(db, () => {
    const user_id = id('user');
    if (avatar_key != null) check(AVATAR_KEYS.includes(avatar_key), 400, 'bad_avatar', '请从 12 个头像中选择');
    run(db, `INSERT INTO users(user_id,login,display_name,is_teacher,is_admin,status,password_hash,must_change_password,pseudonym,created_at,created_by)
      VALUES(?,?,?,?,?,'active',?,?,?,?,?)`, user_id, login, String(display_name || login).slice(0, 40), is_teacher ? 1 : 0, is_admin ? 1 : 0,
      hashPassword(password), must_change_password ? 1 : 0, newPseudonym(db), now(), actor?.user_id || null);
    run(db, 'INSERT INTO credit_accounts(user_id,total_balance,reserved_balance,updated_at) VALUES(?,0,0,?)', user_id, now());
    if (is_teacher) grantInitial(db, user_id, Number(getSetting(db, 'signup_bonus')), actor?.user_id || null);
    audit(db, { actor, action: 'user_created', target_type: 'user', target_id: user_id, detail: { is_teacher, is_admin } });
    return one(db, 'SELECT * FROM users WHERE user_id=?', user_id);
  });
}

export function login(db, { login, password, scope, ip }) {
  const key = `${scope}:${String(login).toLowerCase()}`, ipKey = `ip:${ip}`;
  if (throttled(key) || throttled(ipKey)) fail(429, 'throttled', '尝试次数过多，请 15 分钟后再试');
  const u = one(db, 'SELECT * FROM users WHERE login=?', String(login || '').trim());
  const ok = u && verifyPassword(String(password || ''), u.password_hash);
  if (!ok) { noteFail(key); noteFail(ipKey); audit(db, { action: 'login_failed', target_type: 'login', detail: { scope }, ip }); fail(401, 'bad_credentials', '登录名或密码错误'); }
  if (u.status !== 'active') fail(403, 'disabled', '账号已停用，请联系管理员');
  if (scope === 'admin' && !u.is_admin) fail(403, 'not_admin', '该账号没有管理员权限');
  if (scope === 'teacher' && !u.is_teacher) fail(403, 'not_teacher', '该账号不是教师账号，请从管理员入口登录');
  attempts.delete(key);
  const token = randomBytes(32).toString('base64url');
  const t = now(), idle = Number(getSetting(db, 'session_idle_minutes')) * 60e3;
  tx(db, () => {
    run(db, 'INSERT INTO sessions(token_hash,user_id,scope,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?)',
      tokenHash(token), u.user_id, scope, t, t, new Date(Math.min(Date.now() + idle, Date.now() + ABSOLUTE_SESSION_MS)).toISOString());
    run(db, 'UPDATE users SET last_login_at=? WHERE user_id=?', t, u.user_id);
    audit(db, { actor: { ...u, scope }, action: 'login', target_type: 'user', target_id: u.user_id, detail: { scope }, ip });
  });
  return { token, user: one(db, 'SELECT * FROM users WHERE user_id=?', u.user_id) };
}

export function sessionUser(db, token, scope) {
  if (!token) return null;
  const s = one(db, 'SELECT * FROM sessions WHERE token_hash=? AND scope=?', tokenHash(token), scope);
  if (!s) return null;
  if (Date.parse(s.expires_at) < Date.now()) { run(db, 'DELETE FROM sessions WHERE token_hash=?', s.token_hash); return null; }
  const u = one(db, 'SELECT * FROM users WHERE user_id=?', s.user_id);
  if (!u || u.status !== 'active') return null;
  if (scope === 'admin' && !u.is_admin) return null;
  if (scope === 'teacher' && !u.is_teacher) return null;
  // sliding idle expiry, capped by absolute lifetime
  const idle = Number(getSetting(db, 'session_idle_minutes')) * 60e3;
  const cap = Date.parse(s.created_at) + ABSOLUTE_SESSION_MS;
  run(db, 'UPDATE sessions SET last_seen_at=?, expires_at=? WHERE token_hash=?', now(), new Date(Math.min(Date.now() + idle, cap)).toISOString(), s.token_hash);
  return { ...u, scope };
}
export function logout(db, token) { if (token) run(db, 'DELETE FROM sessions WHERE token_hash=?', tokenHash(token)); }

export function changePassword(db, user, oldPw, newPw) {
  const u = one(db, 'SELECT * FROM users WHERE user_id=?', user.user_id);
  check(verifyPassword(String(oldPw || ''), u.password_hash), 400, 'bad_credentials', '原密码不正确');
  checkPasswordPolicy(newPw);
  check(oldPw !== newPw, 400, 'same_password', '新密码不能与原密码相同');
  tx(db, () => {
    run(db, 'UPDATE users SET password_hash=?, must_change_password=0, password_changed_at=? WHERE user_id=?', hashPassword(newPw), now(), u.user_id);
    audit(db, { actor: user, action: 'password_changed', target_type: 'user', target_id: u.user_id });
  });
}

/** Admin reset: returns a one-time temporary password; all sessions of the user are revoked. */
export function resetPassword(db, admin, userId) {
  const u = one(db, 'SELECT * FROM users WHERE user_id=?', userId);
  check(u, 404, 'not_found', '用户不存在');
  const temp = 'Yz' + randomBytes(6).toString('base64url').replace(/[-_]/g, 'x') + '9';
  tx(db, () => {
    run(db, 'UPDATE users SET password_hash=?, must_change_password=1 WHERE user_id=?', hashPassword(temp), userId);
    run(db, 'DELETE FROM sessions WHERE user_id=?', userId);
    audit(db, { actor: admin, action: 'password_reset', target_type: 'user', target_id: userId });
  });
  return temp;
}

export function setUserStatus(db, admin, userId, status) {
  check(['active', 'disabled'].includes(status), 400, 'bad_status', '无效状态');
  const u = one(db, 'SELECT * FROM users WHERE user_id=?', userId);
  check(u, 404, 'not_found', '用户不存在');
  check(!(u.user_id === admin.user_id && status === 'disabled'), 400, 'self_disable', '不能停用自己');
  tx(db, () => {
    run(db, 'UPDATE users SET status=? WHERE user_id=?', status, userId);
    if (status === 'disabled') run(db, 'DELETE FROM sessions WHERE user_id=?', userId);
    audit(db, { actor: admin, action: status === 'disabled' ? 'user_disabled' : 'user_enabled', target_type: 'user', target_id: userId });
  });
}

export function setUserRoles(db, admin, userId, { is_teacher, is_admin }) {
  const u = one(db, 'SELECT * FROM users WHERE user_id=?', userId);
  check(u, 404, 'not_found', '用户不存在');
  check(!(u.user_id === admin.user_id && is_admin === false), 400, 'self_demote', '不能移除自己的管理员权限');
  tx(db, () => {
    if (typeof is_teacher === 'boolean') run(db, 'UPDATE users SET is_teacher=? WHERE user_id=?', is_teacher ? 1 : 0, userId);
    if (typeof is_admin === 'boolean') run(db, 'UPDATE users SET is_admin=? WHERE user_id=?', is_admin ? 1 : 0, userId);
    // Teacher identity granted later still receives the one-time initial grant (idempotent per user).
    if (is_teacher === true && !u.is_teacher) grantInitial(db, userId, Number(getSetting(db, 'signup_bonus')), admin.user_id);
    run(db, 'DELETE FROM sessions WHERE user_id=?', userId);
    audit(db, { actor: admin, action: 'user_roles_changed', target_type: 'user', target_id: userId, detail: { is_teacher, is_admin } });
  });
}

export function listUsers(db, q) {
  const like = `%${q || ''}%`;
  return all(db, `SELECT u.*, c.total_balance, c.reserved_balance FROM users u LEFT JOIN credit_accounts c ON c.user_id=u.user_id
    WHERE u.login LIKE ? OR u.display_name LIKE ? OR u.pseudonym LIKE ? ORDER BY u.created_at`, like, like, like)
    .map((u) => ({ ...publicUser(u), total_balance: u.total_balance, reserved_balance: u.reserved_balance, available: u.total_balance - u.reserved_balance }));
}
