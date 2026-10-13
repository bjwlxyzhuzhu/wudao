// v3.2: import course content → server-side task pipeline producing real results (pause/resume),
// knowledge-point seminar, answers grounded in the imported materials.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers } from './helpers.js';
import { analyzeMaterials } from '../server/knowledge.js';

import { readFileSync } from 'node:fs';
const LECTURE = readFileSync(new URL('./fixtures/机械质量检测讲义.txt', import.meta.url), 'utf8').trim();

let app, t;
before(async () => { app = await startApp(); seedUsers(app.db); t = client(app.base); await t.login('teacher_a', 'Teach12345'); });
after(async () => { await app.stop(); });
const upload = async (name = '机械质量检测讲义.txt') => (await t.post('/api/materials', { filename: name, kind: 'courseware', data_base64: Buffer.from(LECTURE).toString('base64') })).data;
const waitJob = async (id, until = (j) => ['completed', 'failed', 'paused', 'cancelled'].includes(j.status), ms = 90000) => {
  const t0 = Date.now(); let j;
  while (Date.now() - t0 < ms) { j = (await t.get(`/api/jobs/${id}`)).data; if (until(j)) return j; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error(`job timeout: ${JSON.stringify(j?.steps?.map((s) => s.status))}`);
};

test('知识点抽取：定义、出处、难点、知识点相关的思政融入与带答案的检测题', () => {
  const a = analyzeMaterials([{ filename: '讲义.txt', text: LECTURE }]);
  assert.equal(a.course.name, '机械质量检测'); assert.equal(a.course.hours, 32); assert.equal(a.course.major, '机械制造及其自动化');
  const terms = a.knowledge_points.map((k) => k.term);
  for (const tm of ['公差', '测量误差', '系统误差', '随机误差', '合格判定']) assert.ok(terms.includes(tm), tm);
  assert.ok(!terms.some((x) => /专业|对象|课程/.test(x)), '课程元信息不算知识点');
  const k = a.knowledge_points.find((x) => x.term === '公差');
  assert.match(k.source, /讲义\.txt》·尺寸公差/); assert.match(k.difficulty, /不能与偏差混淆/);
  assert.match(k.ideology.suggestion, /「公差」/); assert.equal(k.question.qtype, '选择'); assert.match(k.question.answer, /^[ABCD]$/);
  assert.ok(new Set(a.knowledge_points.slice(0, 6).map((x) => x.ideology.category)).size >= 3, '思政融入角度有区分');
});

test('导入课程内容后自动执行任务链：各步骤产出真实结果，可在课堂中暂停与继续', async () => {
  const m = await upload();
  const est = await t.post('/api/jobs/estimate', { material_ids: [m.material_id], outputs: ['lesson_plan', 'exercises', 'exam'], class_minutes: 15 });
  assert.equal(est.status, 200); assert.equal(est.data.max_credits, 0, '本地执行不消耗积分');
  assert.ok(est.data.analysis.knowledge_points.length >= 5);
  assert.deepEqual(est.data.steps.map((s) => s.slice(0, 4)), ['解析课程', '知识点研', '整理「课', '生成「模', '生成「模', '模拟上课', '生成课堂', '依据课堂']);
  const created = await t.post('/api/jobs', { material_ids: [m.material_id], outputs: ['lesson_plan', 'exercises', 'exam'], class_minutes: 15 });
  const id = created.data.job_id;
  // pause while the class is running, verify nothing advances, then resume
  let j = await waitJob(id, (x) => x.steps.find((s) => s.key === 'classroom').status === 'running' || x.status !== 'running');
  const p = await t.post(`/api/jobs/${id}/pause`);
  assert.equal(p.data.status, 'paused');
  await new Promise((r) => setTimeout(r, 400));
  const a1 = (await t.get(`/api/jobs/${id}`)).data;
  await new Promise((r) => setTimeout(r, 500));
  const a2 = (await t.get(`/api/jobs/${id}`)).data;
  assert.equal(a1.cursor, a2.cursor); assert.equal(a2.status, 'paused');
  const ev1 = (await t.get(`/api/runs/${a2.current_run_id}`)).data.events.length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await t.get(`/api/runs/${a2.current_run_id}`)).data.events.length, ev1, '暂停期间课堂不再推进');
  await t.post(`/api/jobs/${id}/resume`);
  j = await waitJob(id);
  assert.equal(j.status, 'completed', j.error);
  assert.ok(j.steps.every((s) => s.status === 'done'));

  const art = async (key) => (await t.get(`/api/artifacts/${j.steps.find((s) => s.key === key).artifact_ids[0]}`)).data;
  // knowledge map: every discussed point has explanation, ideology, question and source
  const map = await art('map');
  const pts = map.artifact.body.sections.find((s) => s.key === 'points').rows;
  assert.ok(pts.length >= 5 && pts.every((r) => r.source && r.ideology && r.question));
  // lesson plan: real definitions in the teaching stages, no placeholder text, timings match the 15-minute class
  const lp = await art('discuss');
  const stages = lp.artifact.body.sections.find((s) => s.key === 'stages').rows;
  assert.ok(stages.some((r) => /允许尺寸的变动量/.test(r.teacher_activity)), '教学过程包含材料中的定义');
  assert.ok(!JSON.stringify(stages).includes('待教师补充'), '教学过程没有占位符');
  assert.equal(stages.reduce((a, r) => a + Number(r.minutes), 0), 15);
  assert.deepEqual(lp.issues.filter((i) => i.level === 'error'), []);
  // exercises and exam: answers filled, exam scores add up
  const ex = (await art('generate')).artifact;
  const items = ex.body.sections.find((s) => s.key === 'items').rows;
  assert.ok(items.filter((r) => r.qtype === '选择').every((r) => /^[ABCD]$/.test(r.answer)));
  const examStep = j.steps.filter((s) => s.key === 'generate')[1];
  const exam = (await t.get(`/api/artifacts/${examStep.artifact_ids[0]}`)).data;
  assert.deepEqual(exam.issues.filter((i) => i.level === 'error'), []);
  // classroom feedback and revision
  const fb = await art('feedback');
  assert.ok(fb.artifact.body.sections.find((s) => s.key === 'timing').rows.length >= 4);
  const rev = await art('revise');
  assert.equal(rev.artifact.parent_id, lp.artifact.artifact_id, '修订版是原教案的新版本');
  assert.notDeepEqual(rev.artifact.body.sections.find((s) => s.key === 'stages').rows, stages, '依据课堂反馈做了实际修改');
  assert.match(rev.artifact.body.sections.find((s) => s.key === 'reflection').content, /依据课堂反馈修订/);
  // classroom used knowledge points: students asked about actual concepts
  const cls = (await t.get(`/api/runs/${j.steps.find((s) => s.key === 'classroom').run_id}`)).data;
  assert.ok(cls.events.some((e) => /^S\d/.test(e.actor_id) && /「(公差|基本偏差|测量误差|系统误差|随机误差|合格判定)」/.test(e.text)), '学生围绕具体知识点发言');
  assert.ok(!JSON.stringify(cls).includes('"answer"'), '课堂数据不含题目答案');
  // no credits used
  assert.equal((await t.get('/api/me')).data.balance.total, 100);
});

test('知识点研讨中提问：依据导入材料回答并注明出处；材料中没有依据时如实说明', async () => {
  const m = await upload('讲义2.txt');
  const r = await t.post('/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'lesson_plan', material_ids: [m.material_id], kp_limit: 2 });
  assert.equal(r.status, 200);
  const v0 = (await t.get(`/api/runs/${r.data.run_id}`)).data;
  assert.equal(v0.run.config.mode, 'full');
  assert.equal(v0.plan.steps.filter((s) => s.kind.startsWith('kp_') && s.kind !== 'kp_view').length, 12, '2 个知识点 × 6 个研讨步骤');
  assert.equal(v0.plan.steps.filter((s) => s.kind === 'kp_view').length, 4, '行业导师、青年教师各补充一次视角');
  await t.post(`/api/runs/${r.data.run_id}/start`);
  for (let i = 0; i < 3; i++) await t.post(`/api/runs/${r.data.run_id}/step`);
  await t.post(`/api/runs/${r.data.run_id}/human`, { text: '系统误差和随机误差有什么区别？', kind: 'question' });
  const ans = await t.post(`/api/runs/${r.data.run_id}/step`);
  assert.match(ans.data.event.text, /系统误差[\s\S]*随机误差/); assert.match(ans.data.event.text, /讲义2\.txt/);
  await t.post(`/api/runs/${r.data.run_id}/human`, { text: '量子纠缠在这里怎么应用？', kind: 'question' });
  const none = await t.post(`/api/runs/${r.data.run_id}/step`);
  assert.match(none.data.event.text, /没有找到直接依据/);
  const kpEvents = (await t.get(`/api/runs/${r.data.run_id}`)).data.events.filter((e) => ['explain', 'difficulty', 'ideology_link'].includes(e.kind));
  assert.ok(kpEvents.some((e) => e.kind === 'explain' && /出处/.test(e.text)));
});

test('参与输入框打开后离开页面：输入框占用超过时限自动释放，任务不会一直卡住', async () => {
  for (const jb of (await t.get('/api/jobs')).data.jobs) if (['running', 'paused'].includes(jb.status)) await t.post(`/api/jobs/${jb.job_id}/cancel`);
  for (const r of (await t.get('/api/runs?module=seminar')).data.runs) if (['running', 'paused', 'ready', 'awaiting_human'].includes(r.status)) await t.post(`/api/runs/${r.run_id}/finish`);
  const m = await upload('卡住复现.txt');
  const created = (await t.post('/api/jobs', { material_ids: [m.material_id], outputs: ['lesson_plan'], classroom: false, revise: false, class_minutes: 15, pace: 'watch' })).data;
  const j = await waitJob(created.job_id, (x) => !!x.current_run_id);
  for (let i = 0; i < 100 && (await t.get(`/api/runs/${j.current_run_id}`)).data.run.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 50));
  const opened = await t.post(`/api/runs/${j.current_run_id}/composer`, { open: true });
  assert.equal(opened.data.status, 'awaiting_human');
  // 模拟“打开输入框后关掉了页面”：把占用时间拨回到时限之前
  app.db.prepare('UPDATE runs SET last_activity_at=? WHERE run_id=?').run(new Date(Date.now() - 5 * 60000).toISOString(), j.current_run_id);
  const done = await waitJob(created.job_id);
  assert.equal(done.status, 'completed', JSON.stringify(done.steps.map((s) => s.status)));
});

test('同一份讲义重复导入：课程目标不重复取句，知识点不重复', () => {
  const a = analyzeMaterials([{ filename: 'a.txt', text: LECTURE }, { filename: 'b.txt', text: LECTURE }]);
  const g = a.course.goal_knowledge;
  assert.ok(g && g.indexOf(g.slice(0, 8), 1) === -1, g);
  assert.equal(new Set(a.knowledge_points.map((k) => k.term)).size, a.knowledge_points.length);
});
