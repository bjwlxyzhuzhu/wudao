// V01–V06, V08, V09 and account lifecycle.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers, mockProvider, configureModel, lessonToClassroom } from './helpers.js';
import { reconcileAccount } from '../server/credits.js';

let app, users, mock;
before(async () => { app = await startApp(); users = seedUsers(app.db); mock = await mockProvider(); });
after(async () => { await mock.close(); await app.stop(); });

const ledgerCount = (userId, type) => app.db.prepare('SELECT COUNT(*) n FROM credit_ledger WHERE user_id=? AND type=?').get(userId, type).n;

test('V01 新教师仅一次获得100积分：刷新、再登录、换设备（新会话）不补发', async () => {
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  const created = await admin.post('/api/admin/users', { login: 'new_teacher', display_name: '新老师' });
  assert.equal(created.status, 200);
  assert.deepEqual(created.data.balance, { total: 100, reserved: 0, available: 100 });
  const temp = created.data.temporary_password;
  const dev1 = client(app.base); assert.equal((await dev1.login('new_teacher', temp)).status, 200);
  // first login must change password
  assert.equal((await dev1.get('/api/credits')).status, 403);
  assert.equal((await dev1.post('/api/auth/password', { old_password: temp, new_password: 'Changed123' })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await dev1.get('/api/me')).data.balance.total, 100);
  await dev1.post('/api/auth/logout');
  const dev2 = client(app.base); await dev2.login('new_teacher', 'Changed123');
  const me = await dev2.get('/api/me');
  assert.equal(me.data.balance.total, 100);
  assert.equal(ledgerCount(me.data.user.user_id, 'initial_grant'), 1);
  // migration pass on restart must not re-grant
  const { migrateInitialGrants } = await import('../server/credits.js');
  assert.equal(migrateInitialGrants(app.db, 100), 0);
  assert.equal(ledgerCount(me.data.user.user_id, 'initial_grant'), 1);
});

test('V02 调整新账号赠送值只影响以后新建教师', async () => {
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  assert.equal((await admin.put('/api/admin/settings', { signup_bonus: 50 })).status, 200);
  const r = await admin.post('/api/admin/users', { login: 'bonus50' });
  assert.equal(r.data.balance.total, 50);
  const old = client(app.base); await old.login('teacher_a', 'Teach12345');
  assert.equal((await old.get('/api/me')).data.balance.total, 100);
  await admin.put('/api/admin/settings', { signup_bonus: 100 });
});

test('管理员不默认领取教师积分；授予教师身份后一次性领取', async () => {
  assert.equal(ledgerCount(users.admin.user_id, 'initial_grant'), 0);
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  const a2 = await admin.post('/api/admin/users', { login: 'admin_two', is_admin: true, is_teacher: false });
  assert.equal(a2.data.balance.total, 0);
  await admin.post(`/api/admin/users/${a2.data.user.user_id}/roles`, { is_teacher: true });
  await admin.post(`/api/admin/users/${a2.data.user.user_id}/roles`, { is_teacher: false });
  await admin.post(`/api/admin/users/${a2.data.user.user_id}/roles`, { is_teacher: true });
  assert.equal(ledgerCount(a2.data.user.user_id, 'initial_grant'), 1);
});

test('V03 单人/批量分配：预览、原因必填、重试只记一笔、扣减不侵犯冻结', async () => {
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  const items = [{ user_id: users.t1.user_id, amount: 20 }, { user_id: users.t2.user_id, amount: 30 }];
  assert.equal((await admin.post('/api/admin/credits/preview', { items, reason: '' })).status, 400);
  const pv = await admin.post('/api/admin/credits/preview', { items, reason: '课题组配额' });
  assert.equal(pv.data.preview[0].after.total, 120);
  const batch = 'batch_' + Date.now();
  const c1 = await admin.post('/api/admin/credits/commit', { batch_id: batch, items, reason: '课题组配额' });
  const c2 = await admin.post('/api/admin/credits/commit', { batch_id: batch, items, reason: '课题组配额' });
  assert.equal(c1.status, 200); assert.equal(c2.data.replayed, true);
  const rows = app.db.prepare("SELECT * FROM credit_ledger WHERE batch_id=?").all(batch);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.reason === '课题组配额' && r.actor_id === users.admin.user_id));
  // deduction beyond available is rejected as a whole batch
  const bad = await admin.post('/api/admin/credits/commit', { batch_id: batch + 'x', items: [{ user_id: users.t1.user_id, amount: -10000 }], reason: '测试扣减' });
  assert.equal(bad.status, 409);
  assert.ok(reconcileAccount(app.db, users.t1.user_id).ok);
});

test('V04 教师访问他人数据/后台/密钥接口被服务端拒绝', async () => {
  const a = client(app.base); await a.login('teacher_a', 'Teach12345');
  const b = client(app.base); await b.login('teacher_b', 'Teach12345');
  const art = await a.post('/api/artifacts', { module: 'seminar', type: 'syllabus', title: 'A的大纲' });
  assert.equal((await b.get(`/api/artifacts/${art.data.artifact_id}`)).status, 404);
  assert.equal((await b.put(`/api/artifacts/${art.data.artifact_id}`, { title: 'x' })).status, 404);
  assert.equal((await b.get(`/api/artifacts/${art.data.artifact_id}/export?format=docx`)).status, 404);
  assert.equal((await a.get('/api/admin/users')).status, 401);
  assert.equal((await a.get('/api/admin/models')).status, 401);
  assert.equal((await a.post('/api/admin/credits/commit', { batch_id: 'hackhack1', items: [{ user_id: users.t1.user_id, amount: 999 }], reason: '自己加分' })).status, 401);
  // teacher credentials cannot log into admin; forged user_id in body is ignored
  assert.equal((await client(app.base).login('teacher_a', 'Teach12345', true)).status, 403);
  const other = await b.post('/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'syllabus', reference_artifact_id: art.data.artifact_id });
  assert.equal(other.status, 404);
  // missing CSRF header
  const raw = await fetch(app.base + '/api/artifacts', { method: 'POST', headers: { 'content-type': 'application/json', cookie: Object.entries(a.jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: '{}' });
  assert.equal(raw.status, 403);
});

test('V08 API Key 仅服务端持有：前端、列表、审计、导出不含完整密钥；轮换有审计', async () => {
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  const cfg = await configureModel(admin, mock.url);
  assert.equal(cfg.key_last4, '1234'); assert.equal(cfg.key_configured, true);
  const list = await admin.get('/api/admin/models');
  assert.ok(!JSON.stringify(list.data).includes('SECRETKEY'));
  await admin.post(`/api/admin/models/${cfg.provider_id}/key`, { api_key: 'sk-rotated-NEWSECRET-9876' });
  const t = await admin.post(`/api/admin/models/${cfg.provider_id}/test`);
  assert.equal(t.data.ok, true); assert.equal(mock.state.lastAuth, 'Bearer sk-rotated-NEWSECRET-9876');
  const audit = await admin.get('/api/admin/audit');
  const s = JSON.stringify(audit.data);
  assert.ok(!s.includes('NEWSECRET') && !s.includes('SECRETKEY'));
  assert.ok(audit.data.audit.some((a) => a.action === 'api_key_rotated'));
  const raw = app.db.prepare('SELECT key_ciphertext FROM model_configs').get();
  assert.ok(!raw.key_ciphertext.includes('NEWSECRET'));
  const teacher = client(app.base); await teacher.login('teacher_a', 'Teach12345');
  const cat = await teacher.get('/api/catalog');
  assert.ok(!JSON.stringify(cat.data).includes('NEWSECRET'));
  const zip = await teacher.post('/api/export/zip', { package: 'full', include_event_text: true });
  assert.ok(!zip.data.toString('latin1').includes('NEWSECRET'));
  const fin = await admin.get('/api/admin/export/finance');
  assert.ok(!fin.data.toString('latin1').includes('NEWSECRET'));
  // base_url must be https (http only for localhost in test mode) and never carry credentials
  assert.equal((await admin.post('/api/admin/models', { name: 'x', kind: 'openai_compatible', base_url: 'http://evil.example.com/v1', model_id: 'm' })).status, 400);
  assert.equal((await admin.post('/api/admin/models', { name: 'x', kind: 'openai_compatible', base_url: 'https://u:p@evil.example.com/v1', model_id: 'm' })).status, 400);
  await admin.post('/api/admin/models', { ...cfg, enabled: false, provider_id: cfg.provider_id, api_key: undefined });
});

test('V09 未配置/停用 API 时真实模型模式无法启动，不静默输出脚本', async () => {
  const t = client(app.base); await t.login('teacher_b', 'Teach12345');
  const r = await t.post('/api/runs/estimate', { module: 'seminar', exec_mode: 'model', type: 'syllabus' });
  assert.equal(r.status, 409);
  assert.ok(['model_disabled', 'no_model_config', 'missing_key'].includes(r.data.error.code));
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM events WHERE source='model'").get().n, 0);
});

test('V05 100积分预占10、成功3次后停止：总97、冻结0、可用97', async () => {
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  const cfgs = (await admin.get('/api/admin/models')).data.models;
  await admin.post('/api/admin/models', { ...cfgs[0], enabled: true });
  const created = await admin.post('/api/admin/users', { login: 'v05_teacher', password: 'Teach12345' });
  const t = client(app.base); await t.login('v05_teacher', 'Teach12345'); await t.post('/api/auth/password', { old_password: 'Teach12345', new_password: 'Teach123456' });
  await lessonToClassroom(t, 'v05-transfer-01');
  const est = await t.post('/api/runs/estimate', { module: 'classroom', exec_mode: 'model', config: { max_turns: 10, seed: 'v05' } });
  assert.equal(est.data.max_credits, 10);
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'model', config: { max_turns: 10, seed: 'v05' } });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  assert.deepEqual((await t.get('/api/me')).data.balance, { total: 100, reserved: 10, available: 90 });
  let calls = 0;
  for (let i = 0; i < 20 && calls < 3; i++) { await t.post(`/api/runs/${run.data.run_id}/step`); calls = (await t.get(`/api/runs/${run.data.run_id}`)).data.run.model_calls; }
  assert.equal(calls, 3);
  assert.deepEqual((await t.get('/api/me')).data.balance, { total: 97, reserved: 7, available: 90 });
  await t.post(`/api/runs/${run.data.run_id}/finish`);
  assert.deepEqual((await t.get('/api/me')).data.balance, { total: 97, reserved: 0, available: 97 });
  const uid = created.data.user.user_id;
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM credit_ledger WHERE user_id=? AND type='settle'").get(uid).n, 3);
  assert.ok(reconcileAccount(app.db, uid).ok);
});

test('V06 多标签并发步进、重复提交、余额不足：无重复扣分、无负余额、数据可导出', async () => {
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  const created = await admin.post('/api/admin/users', { login: 'v06_teacher', password: 'Teach12345' });
  const uid = created.data.user.user_id;
  const t = client(app.base); await t.login('v06_teacher', 'Teach12345'); await t.post('/api/auth/password', { old_password: 'Teach12345', new_password: 'Teach123456' });
  await lessonToClassroom(t, 'v06-transfer-01');
  mock.state.mode = 'slow';
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'model', config: { max_turns: 8, seed: 'v06' } });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  // two tabs step concurrently: one must be rejected as in-progress
  const [a, b] = await Promise.all([t.post(`/api/runs/${run.data.run_id}/step`, { idempotency_key: 'tab-a-0001' }), t.post(`/api/runs/${run.data.run_id}/step`, { idempotency_key: 'tab-b-0001' })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  // duplicate submit with same key returns the same event
  const k = 'dup-step-0001';
  const d1 = await t.post(`/api/runs/${run.data.run_id}/step`, { idempotency_key: k });
  const d2 = await t.post(`/api/runs/${run.data.run_id}/step`, { idempotency_key: k });
  assert.equal(d1.data.event.event_id, d2.data.event.event_id);
  mock.state.mode = 'ok';
  const settles = app.db.prepare("SELECT COUNT(*) n FROM credit_ledger WHERE user_id=? AND type='settle'").get(uid).n;
  const succeeded = app.db.prepare("SELECT COUNT(*) n FROM model_calls WHERE user_id=? AND status='succeeded'").get(uid).n;
  assert.equal(settles, succeeded);
  await t.post(`/api/runs/${run.data.run_id}/finish`);
  // insufficient balance: drain available then try to start a new budgeted run
  const bal = (await t.get('/api/me')).data.balance;
  await admin.post('/api/admin/credits/commit', { batch_id: 'drain_v06_01', items: [{ user_id: uid, amount: -bal.available }], reason: '测试余额不足' });
  const r2 = await t.post('/api/runs', { module: 'classroom', exec_mode: 'model', config: { max_turns: 5 } });
  const s2 = await t.post(`/api/runs/${r2.data.run_id}/start`);
  assert.equal(s2.status, 409); assert.equal(s2.data.error.code, 'insufficient_credits');
  const me = (await t.get('/api/me')).data.balance;
  assert.ok(me.total >= 0 && me.available >= 0);
  const zip = await t.post('/api/export/zip', {});
  assert.equal(zip.status, 200);
  assert.ok(reconcileAccount(app.db, uid).ok);
});

test('禁用账号：阻止登录与新请求，进行中的运行被停止并释放预占', async () => {
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  const created = await admin.post('/api/admin/users', { login: 'dis_teacher', password: 'Teach12345' });
  const uid = created.data.user.user_id;
  const t = client(app.base); await t.login('dis_teacher', 'Teach12345'); await t.post('/api/auth/password', { old_password: 'Teach12345', new_password: 'Teach123456' });
  await lessonToClassroom(t, 'dis-transfer-01');
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'model', config: { max_turns: 6 } });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  await t.post(`/api/runs/${run.data.run_id}/step`);
  await admin.post(`/api/admin/users/${uid}/status`, { status: 'disabled' });
  assert.equal((await t.post(`/api/runs/${run.data.run_id}/step`)).status, 401);
  assert.equal((await client(app.base).login('dis_teacher', 'Teach123456')).status, 403);
  const r = app.db.prepare('SELECT status FROM runs WHERE run_id=?').get(run.data.run_id);
  assert.equal(r.status, 'cancelled');
  const bal = app.db.prepare('SELECT * FROM credit_accounts WHERE user_id=?').get(uid);
  assert.equal(bal.reserved_balance, 0);
  assert.ok(app.db.prepare('SELECT COUNT(*) n FROM events WHERE run_id=?').get(run.data.run_id).n >= 1, '历史不被抹除');
});

test('登录限流：连续失败后拒绝', async () => {
  const c = client(app.base);
  for (let i = 0; i < 5; i++) await c.login('teacher_b', 'wrong-pass1');
  assert.equal((await c.login('teacher_b', 'Teach12345')).status, 429);
});
