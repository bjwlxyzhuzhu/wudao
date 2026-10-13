// 简化操作：一键“依据课堂反馈修订原产物”；新建任务可选班级画像（学情分析与模拟上课共用）；大纲 → 课件的任务链。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp, client, seedUsers, lessonToClassroom } from './helpers.js';

const b64 = (s) => Buffer.from(s).toString('base64');
let app, t;
before(async () => { app = await startApp(); seedUsers(app.db); t = client(app.base); await t.login('teacher_a', 'Teach12345'); });
after(async () => { await app.stop(); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('一键修订：课堂反馈直接带回研课场，并以上课所用产物为底稿发起修订，采纳后形成同一版本线的新版本', async () => {
  const { seminarArtifact } = await lessonToClassroom(t, 'simp-xfer-0001');
  const c = (await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo' })).data;
  await t.post(`/api/runs/${c.run_id}/start`); for (let i = 0; i < 30; i++) await t.post(`/api/runs/${c.run_id}/step`);
  await t.post(`/api/runs/${c.run_id}/pause`);
  const fb = (await t.post(`/api/runs/${c.run_id}/feedback`)).data;
  const rr = await t.post('/api/revise-from-feedback', { feedback_artifact_id: (fb.artifact || fb).artifact_id }); assert.equal(rr.status, 200, JSON.stringify(rr.data)); const r = rr.data;
  assert.equal(r.base.artifact_id, seminarArtifact.artifact_id, '底稿是研课场里的原教案');
  const v0 = (await t.get(`/api/runs/${r.run_id}`)).data;
  assert.equal(v0.run.config.base_artifact_id, seminarArtifact.artifact_id);
  assert.equal((await t.get('/api/home')).data.current.seminar.type, 'classroom_feedback', '反馈已作为研课场当前产物带回');
  await t.post(`/api/runs/${r.run_id}/start`); for (let i = 0; i < 80; i++) { const s = await t.post(`/api/runs/${r.run_id}/step`); if (s.data.ended || s.status !== 200) break; }
  const acc = (await t.post(`/api/runs/${r.run_id}/accept`)).data;
  assert.equal(acc.artifact.lineage_id, seminarArtifact.lineage_id); assert.ok(acc.artifact.version > seminarArtifact.version);
  assert.equal((await t.post('/api/revise-from-feedback', {})).status, 409, '研课场当前产物不是课堂反馈时给出明确提示');
  await t.post(`/api/runs/${c.run_id}/finish`);
});

test('新建任务：主成果“大纲”+ 课件，选用班级画像 → 大纲学情分析依据画像，课件随后生成', async () => {
  const csv = ['代号,前测成绩,发言活跃度,常见误解', ...Array.from({ length: 10 }, (_, i) => `E${i + 1},${40 + i * 5},${['高', '中', '低'][i % 3]},${i % 3 === 0 ? '认为电流流过负载会被消耗' : ''}`)].join('\n');
  const p = (await t.post('/api/class-profiles', { consent: true, filename: '电气2401班.csv', group_size: 5, data_base64: b64(csv) })).data;
  const mat = (await t.post('/api/materials', { filename: '讲义.txt', kind: 'courseware', data_base64: b64(readFileSync(new URL('./fixtures/机械质量检测讲义.txt', import.meta.url), 'utf8')) })).data;
  const j = (await t.post('/api/jobs', { material_ids: [mat.material_id], outputs: ['syllabus', 'courseware'], class_minutes: 45, exec_mode: 'demo', pace: 'fast', class_profile_id: p.profile_id, kp_limit: 2 })).data;
  let v; for (let i = 0; i < 200; i++) { v = (await t.get(`/api/jobs/${j.job_id}`)).data; if (['completed', 'failed'].includes(v.status)) break; await sleep(150); }
  assert.equal(v.status, 'completed', JSON.stringify(v.error));
  assert.deepEqual(v.steps.map((s) => s.key), ['analyze', 'discuss', 'map', 'generate'], '主成果为大纲时不自动模拟上课（大纲不能直接上课）');
  const syl = (await t.get(`/api/artifacts/${v.steps[1].artifact_ids[0]}`)).data.artifact;
  assert.equal(syl.type, 'syllabus'); assert.match(syl.body.sections.find((s) => s.key === 'learners').content, /依据班级画像「电气2401班/);
  const cw = (await t.get(`/api/artifacts/${v.steps[3].artifact_ids[0]}`)).data.artifact;
  assert.equal(cw.type, 'courseware');
});
