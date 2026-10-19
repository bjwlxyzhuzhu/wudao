import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUser } from '../server/auth.js';
import { ACTIONS, addProfile, ensureDance } from '../server/dance/service.js';
import { startApp, client } from './helpers.js';

test('四个新版标准可发布；六个旧动作历史不覆盖，禁止新练习复用旧标准', async () => {
  const app = await startApp();
  try {
    const connect = async (role) => {
      const user = createUser(app.db, { login: `archive_${role}`, password: 'Archive1234', is_teacher: false, must_change_password: false });
      addProfile(app.db, user.user_id, role, 'archive-class');
      const c = client(app.base);
      assert.equal((await c.post('/api/dance/auth/login', { login: user.login, password: 'Archive1234' })).status, 200);
      return c;
    };
    const teacher = await connect('teacher'), student = await connect('student');
    for (const key of ['first-position','second-position','demi-plie','tendu','passe','degage']) {
      const published = await teacher.post('/api/dance/standards', { action_key: ACTIONS[0].key, title: `原动作 ${key}`, view: 'front', instructions: '原始教学要求', checkpoints: ['原始检查点'], confirm: true });
      const original = await student.post('/api/dance/sessions', { standard_id: published.data.standard_id, consent_teaching: true, idempotency_key: `old-${key}` });
      assert.equal(original.status, 200);
      // Simulate a pre-upgrade database; production does not rewrite these rows.
      app.db.prepare('UPDATE dance_standards SET action_key=? WHERE standard_id=?').run(key, published.data.standard_id);
      const before = app.db.prepare('SELECT * FROM dance_standards WHERE standard_id=?').get(published.data.standard_id);
      ensureDance(app.db);
      assert.deepEqual(app.db.prepare('SELECT * FROM dance_standards WHERE standard_id=?').get(published.data.standard_id), before);
      const history = await student.get(`/api/dance/sessions/${original.data.training_id}`);
      assert.equal(history.status, 200);
      assert.equal(history.data.standard.title, `原动作 ${key}`);
      assert.equal(history.data.standard.action_key, key);
      assert.equal(history.data.standard.archived_action, true);
      assert.equal((await teacher.get(`/api/dance/sessions/${original.data.training_id}`)).status, 200);
      const blocked = await student.post('/api/dance/sessions', { standard_id: published.data.standard_id, consent_teaching: true, idempotency_key: `new-${key}` });
      assert.equal(blocked.status, 400);
      assert.equal(blocked.data.error.code, 'archived_action');
    }
    let catalog = (await student.get('/api/dance/catalog')).data.actions;
    assert.equal(catalog.length, 4);
    assert.ok(catalog.every(action => action.standard === null));
    for (const action of ACTIONS) {
      const published = await teacher.post('/api/dance/standards', { action_key: action.key, title: action.title, view: action.view, instructions: action.instructions, checkpoints: action.checkpoints, confirm: true });
      assert.equal(published.status, 200);
      assert.equal(published.data.version, 1);
      assert.equal(published.data.reference_metrics, null);
      assert.equal((await student.post('/api/dance/sessions', { standard_id: published.data.standard_id, consent_teaching: true, idempotency_key: action.key })).status, 200);
    }
    catalog = (await student.get('/api/dance/catalog')).data.actions;
    assert.deepEqual(catalog.map(action => action.title), ACTIONS.map(action => action.title));
    assert.ok(catalog.every(action => action.standard && !action.standard.archived_action));
    assert.equal((await student.get('/api/dance/sessions')).data.sessions.length, 10);
  } finally { await app.stop(); }
});
