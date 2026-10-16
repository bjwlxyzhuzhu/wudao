import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, one } from '../server/db.js';
import { createUser, verifyPassword } from '../server/auth.js';
import { loadMasterKey, resolveProvider } from '../server/models.js';
import { ensureDance } from '../server/dance/service.js';
import { bootstrapDanceAccounts, bootstrapQwen, DEMO_ACCOUNTS } from '../server/dance/bootstrap.js';

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'wudao-bootstrap-'));
  loadMasterKey(dir);
  const db = openDb(join(dir, 'test.db'));
  ensureDance(db);
  return { db, close() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('本机演示固定密码仅允许由初始化专用选项创建', () => {
  const fixture = database();
  try {
    assert.throws(() => createUser(fixture.db, { login: 'weak_regular', password: '12345678' }), /同时包含字母和数字/);
    const user = createUser(fixture.db, { login: 'weak_local', password: '12345678', is_teacher: false, allowLocalDemoPassword: true });
    assert.equal(verifyPassword('12345678', user.password_hash), true);
    assert.throws(() => createUser(fixture.db, { login: 'wrong_local', password: '87654321', is_teacher: false, allowLocalDemoPassword: true }), /同时包含字母和数字/);
  } finally { fixture.close(); }
});

test('部署演示模式创建固定角色账号，重复运行不会覆盖密码', () => {
  const fixture = database();
  try {
    const first = bootstrapDanceAccounts(fixture.db, { DANCE_DEMO_MODE: '1' });
    assert.equal(first.created.length, DEMO_ACCOUNTS.length);
    assert.equal(one(fixture.db, "SELECT count(*) total FROM users WHERE is_admin=1").total, 2);
    assert.equal(one(fixture.db, "SELECT count(*) total FROM dance_profiles WHERE role='teacher'").total, 3);
    assert.equal(one(fixture.db, "SELECT count(*) total FROM dance_profiles WHERE role='student'").total, 6);
    assert.equal(one(fixture.db, "SELECT count(*) total FROM dance_profiles WHERE role='medic'").total, 1);
    assert.equal(verifyPassword('Student123', one(fixture.db, "SELECT password_hash FROM users WHERE login='student01'").password_hash), true);
    assert.deepEqual(bootstrapDanceAccounts(fixture.db, { DANCE_DEMO_MODE: '1' }).created, []);
  } finally { fixture.close(); }
});

test('正式部署账号要求密码来自环境变量', () => {
  const fixture = database();
  try {
    assert.throws(() => bootstrapDanceAccounts(fixture.db, { DANCE_BOOTSTRAP_ACCOUNTS: '1' }), /DANCE_ADMIN_PASSWORD/);
    const result = bootstrapDanceAccounts(fixture.db, {
      DANCE_BOOTSTRAP_ACCOUNTS: '1', DANCE_ADMIN_PASSWORD: 'Admin987', DANCE_TEACHER_PASSWORD: 'Teacher987',
      DANCE_STUDENT_PASSWORD: 'Student987', DANCE_MEDIC_PASSWORD: 'Medic987',
    });
    assert.equal(result.created.length, DEMO_ACCOUNTS.length);
    assert.equal(verifyPassword('Admin987', one(fixture.db, "SELECT password_hash FROM users WHERE login='admin01'").password_hash), true);
  } finally { fixture.close(); }
});

test('千问由运行时环境自动配置，数据库不保存明文密钥', () => {
  const fixture = database();
  try {
    const env = { DASHSCOPE_API_KEY: 'sk-test-runtime-only-1234', QWEN_VISION_MODEL: 'qwen3-vl-plus' };
    const result = bootstrapQwen(fixture.db, env);
    assert.equal(result.enabled, true);
    assert.equal(env.DANCE_VISION_PROVIDER_ID, result.provider_id);
    assert.equal(env.DANCE_TEXT_PROVIDER_ID, result.provider_id);
    const row = one(fixture.db, 'SELECT * FROM model_configs WHERE provider_id=?', result.provider_id);
    assert.equal(row.model_id, 'qwen3-vl-plus');
    assert.equal(row.key_last4, '1234');
    assert.notEqual(row.key_ciphertext, env.DASHSCOPE_API_KEY);
    assert.equal(resolveProvider(fixture.db, result.provider_id).config.provider_id, result.provider_id);
    assert.equal(bootstrapQwen(fixture.db, env).key_updated, false);
  } finally { fixture.close(); }
});
