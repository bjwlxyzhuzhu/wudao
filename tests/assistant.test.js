// 数字客服思思：知识库训练与检索验证；登录前本地回答；未配置模型时本地回答；共享平台模型回答（不扣积分、不泄露 Key）；每小时上限；注册选择头像与更换头像。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers, mockProvider, configureModel } from './helpers.js';

let app, t, admin, mock;
before(async () => { app = await startApp(); seedUsers(app.db); mock = await mockProvider(); t = client(app.base); await t.login('teacher_a', 'Teach12345'); admin = client(app.base); await admin.login('root_admin', 'Admin12345', true); });
after(async () => { await app.stop(); await mock.close(); });

test('训练：采集平台文档 → 切分 → 索引 → 检索验证全部命中', async () => {
  const r = (await t.post('/api/assistant/train')).data;
  assert.deepEqual(r.stages.map((s) => s.key), ['collect', 'clean', 'index', 'verify']);
  assert.ok(r.stats.docs >= 7 && r.stats.chunks > 60, JSON.stringify(r.stats));
  assert.equal(r.validation.hit, r.validation.total, JSON.stringify(r.validation.items.filter((x) => !x.ok)));
  assert.match(r.method, /不是模型微调/);
  const st = (await t.get('/api/assistant/status')).data;
  assert.equal(st.name, '思思'); assert.equal(st.model_available, false); assert.ok(st.trained_at);
});

test('登录前与未配置模型时：用本地知识库回答并注明来源；无关问题如实说明', async () => {
  const anon = client(app.base);
  const a = (await anon.post('/api/assistant/public-ask', { question: '怎么注册账号？', page: '/login' })).data;
  assert.equal(a.mode, 'local'); assert.match(a.answer, /注册/); assert.ok(a.sources.length && a.sources[0].doc);
  const b = (await t.post('/api/assistant/ask', { question: '退出时怎么清空缓存？', page: '/' })).data;
  assert.equal(b.mode, 'local'); assert.match(b.note, /尚未配置大模型/); assert.match(b.answer, /清空缓存/);
  const c = (await t.post('/api/assistant/ask', { question: '今天天气怎么样', page: '/' })).data;
  assert.match(c.answer, /没有找到/);
});

test('共享平台模型：带知识库资料提问，记录调用但不扣积分，响应中没有 API Key', async () => {
  await configureModel(admin, mock.url);
  const bal0 = (await t.get('/api/me')).data.balance;
  const r = await t.post('/api/assistant/ask', { question: '怎么把课件送到演课场上课？', page: '/library', history: [{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好，我是思思' }] });
  assert.equal(r.data.mode, 'model'); assert.match(r.data.answer, /模型回复/); assert.ok(r.data.sources.length);
  assert.ok(!JSON.stringify(r.data).includes('SECRETKEY'));
  const sent = mock.state.lastBody.messages;
  assert.match(sent[0].content, /你是“思思”/); assert.match(sent.at(-1).content, /【资料】[\s\S]*送到演课场上课/); assert.match(sent.at(-1).content, /【用户当前页面】产物库/);
  assert.equal(sent.length, 4, 'system + 2 条历史 + 本次问题');
  const call = app.db.prepare("SELECT * FROM model_calls WHERE purpose='assistant' ORDER BY request_at DESC LIMIT 1").get();
  assert.equal(call.status, 'succeeded'); assert.equal(call.credits, 0);
  assert.deepEqual((await t.get('/api/me')).data.balance, bal0, '客服问答不扣积分');
});

test('每小时上限与管理员开关：超出或关闭后改用本地知识库', async () => {
  await admin.put('/api/admin/settings', { assistant_hourly_limit: 1 });
  const r = (await t.post('/api/assistant/ask', { question: '怎么训练教师智能体？' })).data;
  assert.equal(r.mode, 'local'); assert.match(r.note, /次数/);
  await admin.put('/api/admin/settings', { assistant_hourly_limit: 30, assistant_model: 0 });
  const r2 = (await t.post('/api/assistant/ask', { question: '怎么训练教师智能体？' })).data;
  assert.equal(r2.mode, 'local'); assert.match(r2.note, /仅用本地知识库/);
  await admin.put('/api/admin/settings', { assistant_model: 1 });
});

test('头像：注册时选择 12 个头像之一，之后可在账号页更换；非法值被拒绝', async () => {
  await admin.put('/api/admin/settings', { self_register: 1 });
  const anon = client(app.base);
  const reg = await anon.post('/api/auth/register', { login: 'new_teacher', display_name: '新老师', password: 'Newpass123', avatar_key: 'u07' });
  assert.equal(reg.status, 200); assert.equal(reg.data.user.avatar_key, 'u07');
  assert.equal((await anon.post('/api/auth/register', { login: 'bad_ava', password: 'Newpass123', avatar_key: 'u99' })).status, 400);
  assert.equal((await t.put('/api/me/avatar', { avatar_key: 'u13' })).status, 400);
  assert.equal((await t.put('/api/me/avatar', { avatar_key: 'u12' })).status, 200);
  assert.equal((await t.get('/api/me')).data.user.avatar_key, 'u12');
});

test('常见问题的首条检索结果落在正确章节（防止示例句子抢占排序）', async () => {
  const { retrieve, train } = await import('../server/assistant.js');
  train(null, null);
  for (const [q, exp] of [['怎么注册账号？', '登录与注册'], ['退出时怎么清空缓存？', '退出登录与清空缓存'], ['积分怎么获得？', '积分'], ['思思是谁？', '思思是谁'], ['怎么更换头像？', '头像']]) {
    const top = retrieve(q, 1)[0];
    assert.ok(top && top.section.includes(exp), `${q} → ${top?.doc} · ${top?.section}`);
  }
  assert.match(retrieve('研课八步是哪八步？', 1)[0].text, /对抗质询[\s\S]*形成终稿/);
});
