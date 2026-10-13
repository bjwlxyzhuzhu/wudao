// V07, V26 and streaming contract.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers, mockProvider, configureModel, lessonToClassroom, COURSE } from './helpers.js';
import { reconcileAccount } from '../server/credits.js';
import { reconcile } from '../server/runs.js';

let app, users, mock, t, admin;
before(async () => {
  app = await startApp(); users = seedUsers(app.db); mock = await mockProvider();
  admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  await configureModel(admin, mock.url);
  t = client(app.base); await t.login('teacher_a', 'Teach12345');
});
after(async () => { await mock.close(); await app.stop(); });
const bal = () => ({ ...app.db.prepare('SELECT total_balance t, reserved_balance r FROM credit_accounts WHERE user_id=?').get(users.t1.user_id) });

test('V26 查看/编辑/流转/导出/脚本演示不消耗积分', async () => {
  await lessonToClassroom(t, 'v26-transfer-001');
  const c = await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo', config: { max_turns: 10 } });
  await t.post(`/api/runs/${c.data.run_id}/start`);
  for (let i = 0; i < 12; i++) await t.post(`/api/runs/${c.data.run_id}/step`);
  await t.post(`/api/runs/${c.data.run_id}/finish`);
  const fb = await t.post(`/api/runs/${c.data.run_id}/feedback`);
  await t.post(`/api/artifacts/${fb.data.artifact_id}/current`);
  await t.post('/api/transfers', { from: 'classroom', idempotency_key: 'v26-back-00001', save_draft: true });
  await t.post('/api/export/zip', {});
  assert.deepEqual(bal(), { t: 100, r: 0 });
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM credit_ledger WHERE user_id=? AND type<>'initial_grant'").get(users.t1.user_id).n, 0);
});

test('真实模型研讨：流式 delta/final 携带事件序号与角色，按实际调用次数计费', async () => {
  const est = await t.post('/api/runs/estimate', { module: 'seminar', exec_mode: 'model', type: 'lesson_plan', framework_key: 'boppps', course: COURSE, mode: 'cooperate', human_reply_budget: 0 });
  const run = await t.post('/api/runs', { module: 'seminar', exec_mode: 'model', type: 'lesson_plan', framework_key: 'boppps', course: COURSE, mode: 'cooperate', human_reply_budget: 0 });
  assert.equal(run.data.budget_calls, est.data.max_calls);
  await t.post(`/api/runs/${run.data.run_id}/start`);
  const before = bal();
  // streamed step
  const cookie = Object.entries(t.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  let text = '';
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${app.base}/api/runs/${run.data.run_id}/step`, { method: 'POST', headers: { accept: 'text/event-stream', 'content-type': 'application/json', 'x-yz-csrf': '1', cookie }, body: '{}' });
    text += await res.text();
  }
  assert.match(text, /event: delta/); assert.match(text, /event: final/);
  const finals = text.split('\n\n').filter((b) => b.includes('event: final')).map((b) => JSON.parse(b.split('data: ')[1]));
  assert.ok(finals.every((f) => f.event.event_id && f.event.sequence && f.event.actor_id));
  for (let i = 0; i < 40; i++) { const s = await t.post(`/api/runs/${run.data.run_id}/step`); if (s.data.ended) break; }
  const v = await t.get(`/api/runs/${run.data.run_id}`);
  assert.equal(v.data.run.status, 'completed');
  const modelEvents = v.data.events.filter((e) => e.source === 'model').length;
  assert.equal(v.data.run.model_calls, modelEvents, '按实际调用次数，而非轮数');
  assert.ok(v.data.events.some((e) => e.source === 'system'), '组长分派/轮询为系统编排，不计费');
  const after = bal();
  assert.equal(before.t - after.t, modelEvents);
  assert.equal(after.r, 0);
  const out = await t.get(`/api/artifacts/${v.data.run.output_artifact_id}`);
  assert.equal(out.data.artifact.body.ai_assisted, true);
  assert.match(out.data.artifact.body.notice, /AI 辅助草案/);
  const calls = app.db.prepare("SELECT * FROM model_calls WHERE run_id=? AND status='succeeded'").all(run.data.run_id);
  assert.ok(calls.every((c) => c.request_id && c.model_id === 'mock-model' && c.output_tokens === 7));
  assert.ok(reconcileAccount(app.db, users.t1.user_id).ok);
});

test('V07 API 失败/半流中断/格式错误不扣分；重试关联原调用；服务重启后对账', async () => {
  await lessonToClassroom(t, 'v07-xfer-000001');
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'model', config: { max_turns: 6, seed: 'v07' } });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  const start = bal();
  mock.state.mode = 'auth';
  let s = await t.post(`/api/runs/${run.data.run_id}/step`);
  // may hit a silence step (no model) first; loop until a model failure is observed
  for (let i = 0; i < 5 && s.status === 200; i++) s = await t.post(`/api/runs/${run.data.run_id}/step`);
  assert.equal(s.status, 502); assert.equal(s.data.error.code, 'auth_failed');
  mock.state.mode = 'interrupt';
  s = await t.post(`/api/runs/${run.data.run_id}/step`);
  assert.equal(s.status, 502); assert.ok(['stream_interrupted', 'network'].includes(s.data.error.code), s.data.error.code);
  mock.state.mode = 'empty';
  s = await t.post(`/api/runs/${run.data.run_id}/step`);
  assert.equal(s.status, 502); assert.equal(s.data.error.code, 'bad_format');
  assert.deepEqual(bal(), start, '失败调用不扣分');
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM events WHERE run_id=? AND source='demo'").get(run.data.run_id).n, 0, '不以脚本伪装模型');
  mock.state.mode = 'ok';
  s = await t.post(`/api/runs/${run.data.run_id}/step`);
  assert.equal(s.status, 200);
  const ok = app.db.prepare("SELECT * FROM model_calls WHERE run_id=? AND status='succeeded' ORDER BY request_at DESC").get(run.data.run_id);
  assert.ok(ok.retry_of, '重试关联原失败调用');
  assert.equal(start.t - bal().t, 1);
  // simulate crash: a pending call left behind + a running run → restart reconciliation
  app.db.prepare("INSERT INTO model_calls(call_id,run_id,user_id,status,request_at,reservation_id) VALUES('call_orphan',?,?,'pending',?,?)").run(run.data.run_id, users.t1.user_id, new Date().toISOString(), app.db.prepare('SELECT reservation_id FROM runs WHERE run_id=?').get(run.data.run_id).reservation_id);
  app.db.prepare('UPDATE reservations SET inflight=inflight+1 WHERE reservation_id=(SELECT reservation_id FROM runs WHERE run_id=?)').run(run.data.run_id);
  const rep = reconcile(app.db, { startup: true });
  assert.equal(rep.failed_calls, 1);
  assert.equal(app.db.prepare('SELECT status FROM runs WHERE run_id=?').get(run.data.run_id).status, 'paused');
  assert.equal(app.db.prepare('SELECT inflight FROM reservations WHERE reservation_id=(SELECT reservation_id FROM runs WHERE run_id=?)').get(run.data.run_id).inflight, 0);
  await t.post(`/api/runs/${run.data.run_id}/cancel`);
  assert.equal(bal().r, 0, '取消后未用预占全部释放');
  assert.ok(reconcileAccount(app.db, users.t1.user_id).ok);
});

test('预算用尽：停止新调用并暂停，已有数据保留', async () => {
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'model', config: { max_turns: 400, seed: 'budget' } });
  // force a tiny budget
  app.db.prepare('UPDATE runs SET budget_calls=2 WHERE run_id=?').run(run.data.run_id);
  await t.post(`/api/runs/${run.data.run_id}/start`);
  let last;
  for (let i = 0; i < 10; i++) { last = await t.post(`/api/runs/${run.data.run_id}/step`); if (last.status !== 200) break; }
  assert.equal(last.data.error.code, 'budget_exhausted');
  const v = await t.get(`/api/runs/${run.data.run_id}`);
  assert.equal(v.data.run.status, 'paused'); assert.equal(v.data.run.model_calls, 2);
  assert.ok(v.data.events.length >= 2);
  await t.post(`/api/runs/${run.data.run_id}/finish`);
  assert.equal(bal().r, 0);
});

test('真人介入：浮层打开进入 awaiting_human，提交立即落库并记录输入停留', async () => {
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo', config: { max_turns: 20, seed: 'human' } });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  await t.post(`/api/runs/${run.data.run_id}/step`);
  const opened = new Date(Date.now() - 4000).toISOString();
  const c = await t.post(`/api/runs/${run.data.run_id}/composer`, { open: true });
  assert.equal(c.data.status, 'awaiting_human');
  assert.equal((await t.post(`/api/runs/${run.data.run_id}/step`)).status, 409, '真人输入时自动演示不推进');
  const h = await t.post(`/api/runs/${run.data.run_id}/human`, { text: '老师，这个判断依据来自哪个标准？', human_role: 'student', composer_opened_at: opened, idempotency_key: 'human-0001' });
  assert.equal(h.data.actor_type, 'human'); assert.ok(h.data.input_dwell_ms >= 3000);
  const dup = await t.post(`/api/runs/${run.data.run_id}/human`, { text: '老师，这个判断依据来自哪个标准？', human_role: 'student', idempotency_key: 'human-0001' });
  assert.equal(dup.data.event_id, h.data.event_id, '重复提交不重复落库');
  const next = await t.post(`/api/runs/${run.data.run_id}/step`);
  assert.equal(next.data.event.actor_id, 'T'); assert.equal(next.data.event.reply_to, h.data.event_id, '教师回应真人');
  await t.post(`/api/runs/${run.data.run_id}/finish`);
});
