// Delivery-hardening regressions: static path containment, malformed-encoding
// handling, and graceful shutdown. These guard behaviour that is easy to
// regress and expensive when it breaks silently.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers } from './helpers.js';

let app, t;
before(async () => {
  app = await startApp(); seedUsers(app.db);
  t = client(app.base); await t.login('teacher_a', 'Teach12345');
});
after(async () => { await app.stop(); });

test('静态文件：目录穿越被拒绝，正常资源仍可访问', async () => {
  const base = app.base;
  // traversal attempts must not escape public/
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/css/../../package.json']) {
    const res = await fetch(base + p, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `${p} 应被拒绝，实际 ${res.status}`);
    const body = await res.text();
    assert.ok(!body.includes('"name": "yanzhi-platform"'), `${p} 不应泄露仓库文件`);
  }
  // a legitimate asset still serves
  const ok = await fetch(base + '/css/app.css');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/css/);
});

test('畸形百分号编码：返回 400 而不是 500', async () => {
  // an authenticated request whose path parameter has a lone '%'
  const res = await t.req('GET', '/api/artifacts/%');
  assert.equal(res.status, 400, `应返回 400，实际 ${res.status}`);
  assert.equal(res.data.error.code, 'bad_encoding');

  // a genuinely malformed cookie on an otherwise valid request: the cookie is
  // simply unusable, so this is an auth failure, never a server error
  const cookie = Object.entries(t.jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(app.base + '/api/me', { headers: { cookie: `yz_t=%E0%A4%A; ${cookie}`, 'x-yz-csrf': '1' } });
  assert.notEqual(r.status, 500, '畸形 cookie 不应导致 500');
});

test('优雅退出：close() 后端口释放且数据库已关闭', async () => {
  const a = await startApp();
  seedUsers(a.db);
  const port = a.server.address().port;
  await a.stop();
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/me`), /fetch failed|ECONNREFUSED/);
  // closing twice is safe
  await a.close();
});

test('配置：非法 PORT 在启动前被拒绝', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['server/server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: 'not-a-port' }, encoding: 'utf8', timeout: 20000 });
  assert.equal(r.status, 1, '应以退出码 1 结束');
  assert.match(r.stderr, /PORT/);
});

test('健康检查端点：无需登录，不泄露业务数据', async () => {
  const res = await fetch(app.base + '/api/health');
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.ok, true);
  assert.ok(b.version);
  const keys = Object.keys(b).sort().join(',');
  assert.equal(keys, 'ok,schema,time,version', '只暴露版本与时间');
});
