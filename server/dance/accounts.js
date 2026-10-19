import { randomBytes } from 'node:crypto';
import { one, all, run, tx, check, audit } from '../db.js';
import { createUser, publicUser, setUserRoles } from '../auth.js';
import { addProfile } from './service.js';

function profileInput(body) {
  check(['admin', 'teacher', 'student', 'medic'].includes(body.role), 400, 'bad_role', '请选择管理员、舞蹈教师、学生或风险复核教师');
  const cohort = String(body.cohort || '').trim();
  check(body.role === 'admin' || (cohort.length > 0 && cohort.length <= 80), 400, 'bad_cohort', '班级编号需 1—80 字，同班师生请使用相同编号');
  return { role: body.role, cohort };
}
export function listDanceUsers(db, q = '') {
  const like = `%${q}%`;
  return all(db, `SELECT u.*, p.role dance_role, p.cohort FROM users u LEFT JOIN dance_profiles p ON p.user_id=u.user_id
    WHERE u.login LIKE ? OR u.display_name LIKE ? OR p.cohort LIKE ? ORDER BY u.created_at DESC`, like, like, like)
    .map(u => ({ ...publicUser(u), role: u.dance_role || (u.is_admin ? 'admin' : 'unassigned'), cohort: u.cohort || '' }));
}
export function createDanceUser(db, actor, body) {
  const { role, cohort } = profileInput(body);
  const password = body.password || `Dance${randomBytes(6).toString('hex')}8`;
  return tx(db, () => {
    const user = createUser(db, { login: body.login, display_name: body.display_name, password, is_teacher: false, is_admin: role === 'admin', must_change_password: true }, actor);
    if (role !== 'admin') addProfile(db, user.user_id, role, cohort);
    return { user: publicUser(user), role, cohort, temporary_password: password };
  });
}
export function updateDanceUser(db, actor, userId, body) {
  const { role, cohort } = profileInput(body);
  check(one(db, 'SELECT 1 FROM users WHERE user_id=?', userId), 404, 'not_found', '用户不存在');
  return tx(db, () => {
    setUserRoles(db, actor, userId, { is_teacher: false, is_admin: role === 'admin' });
    const prior = one(db, 'SELECT * FROM dance_profiles WHERE user_id=?', userId);
    if (role === 'admin') run(db, 'DELETE FROM dance_profiles WHERE user_id=?', userId);
    else if (prior) run(db, 'UPDATE dance_profiles SET role=?,cohort=? WHERE user_id=?', role, cohort, userId);
    else addProfile(db, userId, role, cohort);
    audit(db, { actor, action: 'dance_profile_updated', target_type: 'user', target_id: userId, detail: { role, cohort } });
    return { ok: true };
  });
}
