// Test harness: isolated data dir, real HTTP server, cookie-aware client and a local mock model provider.
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

process.env.YANZHI_ALLOW_HTTP_LOCAL = '1';
const { createApp } = await import('../server/server.js');
const { createUser, resetThrottle } = await import('../server/auth.js');

export async function startApp() {
  const dir = mkdtempSync(join(tmpdir(), 'yz-test-'));
  const app = createApp({ dataDir: dir });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  resetThrottle();
  return { ...app, base, dir, async stop() { await app.close(); try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ } } };
}

export function client(base) {
  const jar = {};
  const c = {
    jar,
    async req(method, path, body, headers = {}) {
      const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-yz-csrf': '1', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const sc = res.headers.getSetCookie?.() || [];
      for (const s of sc) { const [kv] = s.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, headers: res.headers };
    },
    get: (p) => c.req('GET', p), post: (p, b = {}) => c.req('POST', p, b), put: (p, b = {}) => c.req('PUT', p, b), del: (p) => c.req('DELETE', p),
    async login(login, password, admin = false) { return c.post(admin ? '/api/admin/auth/login' : '/api/auth/login', { login, password }); },
  };
  return c;
}

export function seedUsers(db) {
  const admin = createUser(db, { login: 'root_admin', password: 'Admin12345', is_admin: true, is_teacher: false, must_change_password: false });
  const t1 = createUser(db, { login: 'teacher_a', password: 'Teach12345', is_teacher: true, must_change_password: false });
  const t2 = createUser(db, { login: 'teacher_b', password: 'Teach12345', is_teacher: true, must_change_password: false });
  return { admin, t1, t2 };
}

export const COURSE = { name: '机械质量检测', major: '机械制造', audience: '大二', hours: 32, weeks: 16, lesson_minutes: 90, unit: '零件尺寸检测与放行判断',
  goal_knowledge: '掌握公差与检测方法', goal_ability: '能依据数据作放行判断', goal_value: '树立质量责任意识', ideology_elements: '工程责任、诚信、公共安全', cases: '某汽车零件召回案例', exam_total: 100 };

/** OpenAI-compatible SSE mock. mode: ok | auth | interrupt | empty | badjson | slow */
export async function mockProvider() {
  const state = { mode: 'ok', calls: 0, lastAuth: null, lastBody: null };
  const srv = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c)); req.on('end', () => {
      state.calls++; state.lastAuth = req.headers.authorization; state.lastBody = JSON.parse(raw || '{}');
      if (state.mode === 'auth') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad key"}'); }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': `req-${state.calls}` });
      const sys = state.lastBody.messages?.[0]?.content || '', user = state.lastBody.messages?.at(-1)?.content || '';
      const wantsJson = /JSON 数组/.test(user);
      let text = wantsJson ? JSON.stringify([{ id: 'K1', category: '知识', description: '模型生成目标', stage: 'bridge_in', minutes: '90', teacher_activity: '模型生成', title: 't', content: 'c', source: '待核查', unit: 'u', hours: '32', item: 'x', weight: '100', week: '1', no: '1', qtype: '选择', score: '100', stem: 's', answer: 'A' }]) : `模型回复（${/学生/.test(sys) ? '学生' : '教师'}）`;
      if (state.mode === 'badjson' && wantsJson) text = '这不是JSON';
      if (state.mode === 'empty') text = '';
      const parts = text.match(/.{1,6}/gs) || [];
      const send = (i) => {
        if (state.mode === 'interrupt' && i === 1) { res.destroy(); return; }
        if (i < parts.length) { res.write(`data: ${JSON.stringify({ id: 'cmpl-1', model: 'mock-model', choices: [{ delta: { content: parts[i] } }] })}\n\n`); setTimeout(() => send(i + 1), state.mode === 'slow' ? 50 : 1); return; }
        res.write(`data: ${JSON.stringify({ id: 'cmpl-1', model: 'mock-model', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      };
      send(0);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${srv.address().port}/v1`, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }) };
}

export async function configureModel(admin, url, extra = {}) {
  const r = await admin.post('/api/admin/models', { name: 'Mock', kind: 'openai_compatible', base_url: url, model_id: 'mock-model', api_key: 'sk-test-SECRETKEY-1234', credit_rate: 1, is_default: true, ...extra });
  if (r.status !== 200) throw new Error(JSON.stringify(r.data));
  return r.data;
}

/** Create a saved lesson plan in 研课场 via demo run, accept it and transfer to 演课场. */
export async function lessonToClassroom(t, key = 'xfer-setup-0001') {
  const run = await t.post('/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'lesson_plan', framework_key: 'boppps', course: COURSE, mode: 'cooperate', title: '放行判断教案' });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  for (let i = 0; i < 60; i++) { const s = await t.post(`/api/runs/${run.data.run_id}/step`); if (s.data.ended) break; }
  const acc = await t.post(`/api/runs/${run.data.run_id}/accept`);
  const x = await t.post('/api/transfers', { from: 'seminar', idempotency_key: key });
  return { seminarArtifact: acc.data.artifact, classroomArtifact: x.data.target };
}

/** Minimal ZIP reader for tests (supports store/deflate). */
export function unzip(buf) {
  const files = {}; let p = 0;
  while (buf.readUInt32LE(p) === 0x04034b50) {
    const method = buf.readUInt16LE(p + 8), csize = buf.readUInt32LE(p + 18), nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
    const name = buf.slice(p + 30, p + 30 + nlen).toString('utf8'); const data = buf.slice(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize);
    files[name] = method === 8 ? inflateRawSync(data) : data; p += 30 + nlen + xlen + csize;
  }
  return files;
}
