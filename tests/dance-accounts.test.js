import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers } from './helpers.js';

test('舞蹈账号：创建、首次改密、班级隔离、重置、停用和身份变更', async () => {
  const app = await startApp();
  try {
    seedUsers(app.db);
    const admin = client(app.base);
    await admin.login('root_admin', 'Admin12345', true);
    const create = async (login, role, cohort = 'dance-a') => {
      const r = await admin.post('/api/admin/dance-users', { login, role, cohort, password: 'Initial12345' });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const c = client(app.base);
      const base = role === 'admin' ? '/api/admin' : '/api/dance';
      assert.equal((await c.post(`${base}/auth/login`, { login, password: r.data.temporary_password })).status, 200);
      if (role !== 'admin') {
        assert.equal((await c.get('/api/dance/me')).data.must_change_password, true);
        assert.equal((await c.get('/api/dance/catalog')).status, 403);
      }
      assert.equal((await c.post(`${base}/auth/password`, { old_password: r.data.temporary_password, new_password: 'Changed12345' })).status, 200);
      return { c, id: r.data.user.user_id };
    };
    const teacher = await create('new_teacher', 'teacher');
    const student = await create('new_student', 'student');
    const outsider = await create('other_student', 'student', 'dance-b');
    const medic = await create('new_medic', 'medic');
    await create('new_admin', 'admin', '');
    assert.equal((await medic.c.get('/api/dance/me')).data.role, 'medic');
    assert.equal((await student.c.get('/api/dance/me')).data.must_change_password, false);
    const standard = await teacher.c.post('/api/dance/standards', { action_key: 'ballet-demi-plie', title: '账号回归标准', view: 'front', instructions: '教师要求', checkpoints: ['膝盖朝向脚尖'], confirm: true });
    assert.equal(standard.status, 200);
    const catalog = (await student.c.get('/api/dance/catalog')).data;
    assert.equal(catalog.actions.find(a => a.key === 'ballet-demi-plie').standard.standard_id, standard.data.standard_id);
    assert.ok(!(await outsider.c.get('/api/dance/catalog')).data.actions.find(a => a.key === 'ballet-demi-plie').standard);
    assert.equal((await student.c.post('/api/admin/dance-users', {})).status, 401);
    assert.equal((await admin.post('/api/admin/dance-users', { login: 'bad_cohort', role: 'student' })).status, 400);
    assert.equal((await admin.post('/api/admin/dance-users', { login: 'new_student', role: 'student', cohort: 'dance-a' })).status, 409);
    const reset = await admin.post(`/api/admin/users/${student.id}/reset-password`, {});
    assert.equal(reset.status, 200);
    assert.equal((await student.c.get('/api/dance/me')).status, 401);
    assert.equal((await student.c.post('/api/dance/auth/login', { login: 'new_student', password: reset.data.temporary_password })).status, 200);
    assert.equal((await student.c.get('/api/dance/me')).data.must_change_password, true);
    assert.equal((await admin.post(`/api/admin/users/${student.id}/status`, { status: 'disabled' })).status, 200);
    assert.equal((await student.c.post('/api/dance/auth/login', { login: 'new_student', password: reset.data.temporary_password })).status, 403);
    assert.equal((await admin.post(`/api/admin/dance-users/${teacher.id}/profile`, { role: 'medic', cohort: 'dance-b' })).status, 200);
    assert.equal((await teacher.c.get('/api/dance/me')).status, 401);
    await teacher.c.post('/api/dance/auth/login', { login: 'new_teacher', password: 'Changed12345' });
    assert.equal((await teacher.c.get('/api/dance/me')).data.role, 'medic');
    const list = (await admin.get('/api/admin/dance-users')).data.users;
    const root = list.find(u => u.login === 'root_admin');
    assert.equal((await admin.post(`/api/admin/dance-users/${root.user_id}/profile`, { role: 'student', cohort: 'dance-a' })).status, 400);
    const legacy = list.find(u => u.login === 'teacher_a');
    assert.equal(legacy.role, 'unassigned');
    const repaired = client(app.base);
    const denied = await repaired.post('/api/dance/auth/login', { login: 'teacher_a', password: 'Teach12345' });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.code, 'no_dance_access');
    assert.equal((await admin.post(`/api/admin/dance-users/${legacy.user_id}/profile`, { role: 'teacher', cohort: 'dance-a' })).status, 200);
    assert.equal((await repaired.post('/api/dance/auth/login', { login: 'teacher_a', password: 'Teach12345' })).status, 200);
    assert.equal((await repaired.get('/api/dance/me')).data.role, 'teacher');
    assert.equal((await repaired.post('/api/dance/standards', { action_key: 'ballet-tendu', title: '旧教师修复后的标准', view: 'front', instructions: '芭蕾擦地教学要求', checkpoints: ['保持躯干稳定'], confirm: true })).status, 200);
  } finally { await app.stop(); }
});
