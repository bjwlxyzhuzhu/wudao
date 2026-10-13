// v3.1 features: class clock & lecture order, material upload/extraction/PII, new 课程思政 document types, ideology tagging.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as sched from '../server/scheduler.js';
import { zip } from '../server/zip.js';
import { extractText, piiScan, redact } from '../server/materials.js';
import { startApp, client, seedUsers, lessonToClassroom, COURSE } from './helpers.js';

const docx = (paras) => zip([
  { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
  { name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>` },
]);
const pptx = (slides) => zip(slides.map((lines, i) => ({ name: `ppt/slides/slide${i + 1}.xml`, data: `<p:sld xmlns:a="a" xmlns:p="p">${lines.map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`).join('')}</p:sld>` })));

test('课堂计时：按设定课时推进环节、依次讲解教案内容、到点下课', () => {
  const stages = [
    { key: 's1', label: '导入', minutes: 5, topic: '放行判断', teacher_text: '', segments: ['第一段：召回案例。', '第二段：问题提出。'] },
    { key: 's2', label: '讲授', minutes: 25, topic: '公差', teacher_text: '', segments: ['公差定义。', '测量误差。', '放行规则。'] },
    { key: 's3', label: '讨论', minutes: 15, topic: '工程责任', teacher_text: '', segments: ['价值冲突情境。'] },
    { key: 's4', label: '总结', minutes: 5, topic: '总结', teacher_text: '', segments: ['要点回顾。'] },
  ];
  const cfg = sched.normalizeConfig({ class_minutes: 50, seed: 'clock', class_size: 24 });
  const students = sched.makeStudents(cfg, cfg.seed), state = sched.initState(cfg, cfg.seed);
  const acts = []; let last = null;
  for (let i = 0; i < 1000; i++) {
    const { act } = sched.step(state, { students, stages, config: cfg, last });
    if (act.who === 'end') break;
    acts.push(act); last = { event_id: `e${i}`, actor_id: act.who === 'student' ? act.agent_id : act.who === 'teacher' ? 'T' : 'SYS', actor_type: act.who === 'system' ? 'system' : 'agent', kind: act.action === 'ask' ? 'question' : act.action };
  }
  const end = acts.at(-1);
  assert.equal(end.action, 'conclude');
  assert.ok(state.clock_ms >= 50 * 60000 - 120000 && state.clock_ms <= 52 * 60000, `课堂时钟 ${state.clock_ms / 60000} 分钟接近设定的 50 分钟`);
  // clock is monotonic and every act carries its start time
  acts.reduce((prev, a) => { assert.ok(a.class_clock_ms >= prev); return a.class_clock_ms; }, 0);
  // lecture segments are delivered in order within each stage
  for (const s of stages) {
    const segs = acts.filter((a) => a.action === 'lecture' && a.stage === s.key).map((a) => a.segment);
    assert.deepEqual(segs, [...segs].sort((a, b) => a - b), `${s.label} 讲解顺序`);
    assert.equal(segs[0], 0);
  }
  // the long 讲授 stage takes clearly longer than 导入
  const span = (k) => { const xs = acts.filter((a) => a.stage === k); return xs.at(-1).class_clock_ms - xs[0].class_clock_ms; };
  assert.ok(span('s2') > span('s1') * 2);
});

test('材料提取：docx/pptx/txt，隐私信息检出并在使用前隐去', () => {
  const d = extractText('大纲.docx', docx(['第一章 公差与配合', '课程目标：培养学生的质量责任意识和工匠精神。', '联系人电话 13812345678']));
  assert.match(d.text, /第一章 公差与配合/); assert.match(d.text, /工匠精神/);
  assert.deepEqual(piiScan(d.text), { 手机号: 1 });
  assert.ok(!redact(d.text).includes('13812345678'));
  const p = extractText('课件.pptx', pptx([['检测与放行'], ['案例：某零件召回', '讨论：谁来承担责任？']]));
  assert.match(p.text, /【第2页】[\s\S]*谁来承担责任/);
  assert.equal(extractText('a.txt', Buffer.from('课程思政教学设计')).text, '课程思政教学设计');
  assert.throws(() => extractText('a.pdf', Buffer.from('%PDF')), /另存为/);
});

let app, t, t2;
before(async () => { app = await startApp(); seedUsers(app.db); t = client(app.base); await t.login('teacher_a', 'Teach12345'); t2 = client(app.base); await t2.login('teacher_b', 'Teach12345'); });
after(async () => { await app.stop(); });

test('上传材料参与研讨：材料研读步骤、依据材料起草并注明出处；他人不可引用', async () => {
  const up = await t.post('/api/materials', { filename: '机械检测教学大纲.docx', kind: 'syllabus', data_base64: docx(['一、课程目标', '通过零件检测任务，培养学生的质量责任意识与工程伦理。', '二、教学内容', '1. 公差与配合', '2. 测量误差分析', '3. 放行判断与复检', '学生张三 学号 20230101 电话 13900001111']).toString('base64') });
  assert.equal(up.status, 200); assert.deepEqual(up.data.pii_flags, { 手机号: 1, 疑似学号: 1 });
  assert.ok(!up.data.preview.includes('13900001111'));
  assert.equal((await t2.post('/api/runs/estimate', { module: 'seminar', exec_mode: 'demo', type: 'syllabus', course: COURSE, material_ids: [up.data.material_id] })).status, 404);
  const run = await t.post('/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'course_design', course: COURSE, mode: 'cooperate', material_ids: [up.data.material_id] });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  const first = await t.post(`/api/runs/${run.data.run_id}/step`);
  assert.equal(first.data.event.kind, 'review'); assert.match(first.data.event.text, /机械检测教学大纲/);
  for (let i = 0; i < 60; i++) { const s = await t.post(`/api/runs/${run.data.run_id}/step`); if (s.data.ended) break; }
  const v = await t.get(`/api/runs/${run.data.run_id}`);
  const a = (await t.get(`/api/artifacts/${v.data.run.output_artifact_id}`)).data.artifact;
  const units = a.body.sections.find((s) => s.key === 'units').rows.map((r) => r.content);
  assert.ok(units.some((u) => /公差与配合/.test(u)), `单元来自材料：${units}`);
  assert.ok(!JSON.stringify(a.body).includes('13900001111'), '隐私信息不进入产物');
  assert.ok(v.data.events.some((e) => e.ideology_terms && e.ideology_terms !== '[]'), '思政词被标注');
  assert.equal((await t2.del(`/api/materials/${up.data.material_id}`)).status, 404);
  assert.equal((await t.del(`/api/materials/${up.data.material_id}`)).status, 200);
});

test('人才培养方案/课程教学设计/教学计划进度表：结构、校验与课堂适配', async () => {
  const cat = (await t.get('/api/catalog')).data;
  assert.deepEqual(cat.lesson_minutes, [15, 25, 45, 50, 90]);
  for (const k of ['talent_plan', 'course_design', 'teaching_schedule']) assert.ok(cat.artifact_types.find((x) => x.key === k), k);
  assert.equal(cat.artifact_types.find((x) => x.key === 'semester_plan').name, '学期教学设计');
  const tp = await t.post('/api/artifacts', { module: 'seminar', type: 'talent_plan', course: COURSE });
  const b = tp.data.body; b.sections.find((s) => s.key === 'goals_map').rows = [{ goal: '具备工程伦理意识', element: '工程伦理', approach: '爱国敬业', evidence: '' }];
  const r = await t.put(`/api/artifacts/${tp.data.artifact_id}`, { body: b });
  assert.ok(r.data.issues.some((i) => /口号化/.test(i.message)), '口号化融入点被提示');
  assert.ok(r.data.issues.some((i) => /达成证据/.test(i.message)));
  await t.post(`/api/artifacts/${tp.data.artifact_id}/save`); await t.post(`/api/artifacts/${tp.data.artifact_id}/current`);
  await t.post('/api/transfers', { from: 'seminar', idempotency_key: 'tp-xfer-000001' });
  const e = await t.post('/api/runs/estimate', { module: 'classroom', exec_mode: 'demo', config: {} });
  assert.equal(e.data.error.code, 'type_not_runnable'); assert.match(e.data.error.message, /专业层面/);
});

test('演课场：选择 25 分钟课时，事件带课堂时钟，到点下课', async () => {
  await lessonToClassroom(t, 'clock-xfer-00001');
  const est = await t.post('/api/runs/estimate', { module: 'classroom', exec_mode: 'demo', config: { class_minutes: 25 } });
  assert.equal(est.data.class_minutes, 25); assert.ok(est.data.stages.every((s) => /分）$/.test(s)));
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo', config: { class_minutes: 25, seed: 'c25' } });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  let ended = null;
  for (let i = 0; i < 400 && !ended; i++) { const s = await t.post(`/api/runs/${run.data.run_id}/step`); if (s.data.ended) ended = s.data.reason; }
  assert.ok(['class_time_over', 'stages_completed'].includes(ended), ended);
  const v = await t.get(`/api/runs/${run.data.run_id}`);
  assert.ok(v.data.events.every((e) => e.class_clock_ms != null));
  const lastEv = v.data.events.at(-1);
  assert.ok(lastEv.class_clock_ms + lastEv.sim_duration_ms <= 27 * 60000 && lastEv.class_clock_ms >= 20 * 60000, `结束于 ${lastEv.class_clock_ms / 60000} 分`);
  assert.equal(v.data.clock.class_minutes, 25);
  assert.ok(v.data.ideology_terms.includes('工程责任'));
  const lectures = v.data.events.filter((e) => e.actor_id === 'T' && e.kind === 'lecture');
  assert.ok(lectures.length >= 4);
});
