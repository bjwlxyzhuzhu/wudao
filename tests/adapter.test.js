// Provider adapters: Anthropic Messages streaming format, error mapping, and base_url validation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YANZHI_ALLOW_HTTP_LOCAL = '1';
const models = await import('../server/models.js');
const { openDb } = await import('../server/db.js');

let srv, url, last = {};
before(async () => {
  srv = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      last = { path: req.url, key: req.headers['x-api-key'], version: req.headers['anthropic-version'], body: JSON.parse(raw) };
      if (last.body.model === 'quota') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"type":"insufficient_quota"}}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_abc' });
      const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      ev('message_start', { message: { id: 'msg_1', model: 'mock-claude', usage: { input_tokens: 21 } } });
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const t of ['课程', '思政', '回应']) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } });
      ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });
      ev('message_stop', {});
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${srv.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'yz-adapter-'));
  models.loadMasterKey(dir);
});
after(() => new Promise((r) => srv.close(r)));

function cfgFor(model) {
  const dir = mkdtempSync(join(tmpdir(), 'yz-adapter-db-'));
  const db = openDb(join(dir, 'a.db'));
  const admin = { user_id: 'admin_x', is_admin: 1, scope: 'admin' };
  const c = models.saveConfig(db, admin, { name: 'A', kind: 'anthropic', base_url: url, model_id: model, api_key: 'sk-ant-test-ABCDEFG9' });
  return db.prepare('SELECT * FROM model_configs WHERE provider_id=?').get(c.provider_id);
}

test('Anthropic Messages 流式：拼接文本、读取 usage 与 request-id、发送正确请求头', async () => {
  const deltas = [];
  const out = await models.chat(cfgFor('mock-claude'), { system: '系统提示', messages: [{ role: 'user', content: '你好' }], onDelta: (d) => deltas.push(d) });
  assert.equal(out.text, '课程思政回应'); assert.deepEqual(deltas, ['课程', '思政', '回应']);
  assert.equal(out.input_tokens, 21); assert.equal(out.output_tokens, 9); assert.equal(out.request_id, 'req_abc'); assert.equal(out.model_reported, 'mock-claude');
  assert.equal(last.path, '/v1/messages'); assert.equal(last.key, 'sk-ant-test-ABCDEFG9'); assert.equal(last.version, '2023-06-01');
  assert.equal(last.body.system, '系统提示'); assert.equal(last.body.stream, true);
});

test('供应商额度不足映射为明确错误码', async () => {
  await assert.rejects(models.chat(cfgFor('quota'), { system: 's', messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'provider_quota');
});

test('base_url 校验：仅 https（测试环境允许本机 http），不允许凭据/查询', () => {
  delete process.env.YANZHI_ALLOW_HTTP_LOCAL;
  assert.throws(() => models.validateBaseUrl('http://127.0.0.1:1/v1'));
  process.env.YANZHI_ALLOW_HTTP_LOCAL = '1';
  assert.equal(models.validateBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  assert.throws(() => models.validateBaseUrl('https://api.example.com/v1?x=1'));
  assert.throws(() => models.validateBaseUrl('ftp://api.example.com'));
});

test('OpenAI 兼容：400 错误带出供应商原因（便于发现模型 ID 写错），并可列出供应商模型', async () => {
  const s2 = createServer((req, res) => {
    if (req.url === '/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"object":"list","data":[{"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash"},{"id":"deepseek-v4-pro"}]}'); }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-v4.1-flash. (request_id: 1234)","type":"invalid_request_error"}}');
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  try {
    const dir = mkdtempSync(join(tmpdir(), 'yz-adapter-oa-'));
    const db = openDb(join(dir, 'a.db'));
    const admin = { user_id: 'admin_x', is_admin: 1, scope: 'admin' };
    const c = models.saveConfig(db, admin, { name: 'DeepSeek', kind: 'openai_compatible', base_url: `http://127.0.0.1:${s2.address().port}`, model_id: 'deepseek-v4.1-flash', api_key: 'sk-test-ABCDEFGHIJ' });
    const cfg = db.prepare('SELECT * FROM model_configs WHERE provider_id=?').get(c.provider_id);
    await assert.rejects(models.chat(cfg, { system: 's', messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'bad_request' && /模型ID不被支持/.test(e.message) && /deepseek-flash/.test(e.message) && !/request_id/.test(e.message));
    const list = await models.listRemoteModels(db, admin, c.provider_id);
    assert.equal(list.ok, true); assert.deepEqual(list.models.map((m) => m.id), ['deepseek-flash', 'deepseek-v4-pro']); assert.equal(list.current, 'deepseek-v4.1-flash');
    assert.ok(!JSON.stringify(list).includes('sk-test'));
  } finally { await new Promise((r) => s2.close(r)); }
});
