// 五位专家审核后的整改：学情分析依据班级画像；目标可观察性；思政融入过度/同质化/脱节；课堂价值表达“口号式 vs 说理式”。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers, lessonToClassroom } from './helpers.js';
import { ideologyCheck, validateBody } from '../server/artifacts.js';
import { courseBrief } from '../server/dialogue.js';
import { valueTalk } from '../server/runs.js';

const b64 = (s) => Buffer.from(s).toString('base64');
let app, t;
before(async () => { app = await startApp(); seedUsers(app.db); t = client(app.base); await t.login('teacher_a', 'Teach12345'); });
after(async () => { await app.stop(); });

test('教学设计专家：研课场选用班级画像后，学情分析写入画像统计，未导入时如实说明而不编造', async () => {
  const csv = ['代号,前测成绩,兴趣方向,发言活跃度,质疑倾向,常见误解', ...Array.from({ length: 12 }, (_, i) => `A${i + 1},${30 + i * 6},${i % 2 ? '工程应用' : '数据分析'},${['高', '中', '低'][i % 3]},${i % 4},${i % 4 === 0 ? '把公差和偏差混为一谈' : ''}`)].join('\n');
  const p = (await t.post('/api/class-profiles', { consent: true, filename: '机械2班.csv', group_size: 4, data_base64: b64(csv) })).data;
  const run = async (extra) => {
    const r = (await t.post('/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'syllabus', course: { name: '机械质量检测', unit: '尺寸公差', prereq: '机械制图' }, ...extra })).data;
    await t.post(`/api/runs/${r.run_id}/start`); for (let i = 0; i < 300; i++) { const s = await t.post(`/api/runs/${r.run_id}/step`); if (s.data.ended || s.status !== 200) break; }
    const v = (await t.get(`/api/runs/${r.run_id}`)).data;
    return { v, a: (await t.get(`/api/artifacts/${v.run.output_artifact_id}`)).data.artifact };
  };
  const withP = await run({ class_profile_id: p.profile_id });
  assert.equal(withP.v.run.config.class_profile_id, p.profile_id);
  const learners = withP.a.body.sections.find((s) => s.key === 'learners').content;
  assert.match(learners, /依据班级画像「机械2班/); assert.match(learners, /12 人/); assert.match(learners, /把公差和偏差混为一谈/);
  assert.match(courseBrief(withP.a.body), /学情（班级画像统计/);
  const without = await run({});
  assert.match(without.a.body.sections.find((s) => s.key === 'learners').content, /尚未导入班级画像/);
  assert.match(courseBrief(without.a.body), /不得编造数据/);
});

test('教学设计专家：只用“了解/理解/掌握”等内隐动词的目标给出可观察性提示', () => {
  const body = { course: {}, sections: [{ key: 'goals', kind: 'table', columns: [], rows: [{ id: 'K1', category: '知识', description: '了解尺寸公差的基本概念' }, { id: 'A1', category: '能力', description: '能依据检测数据判断零件是否放行' }, { id: 'V1', category: '价值', description: '树立质量责任意识' }] }] };
  const w = validateBody('lesson_plan', body).filter((i) => /内隐动词/.test(i.message));
  assert.deepEqual(w.map((i) => i.message.match(/目标 (\w+)/)[1]), ['K1', 'V1']);
});

test('课程思政专家：检出思政融入过度、同质化表述与脱离专业内容的“贴标签”', () => {
  const same = '培养学生的工匠精神与职业责任意识，树立正确价值观';
  const rows = ['尺寸公差', '形位公差', '表面粗糙度', '量具选择', '测量误差', '检测报告'].map((u) => ({ unit: u, content: `${u}的概念与检测方法`, ideology_point: same }));
  const k = ideologyCheck({ sections: [{ key: 'content', kind: 'table', columns: [{ key: 'unit' }, { key: 'content' }, { key: 'ideology_point' }], rows }] });
  assert.equal(k.embedding, 'over'); assert.equal(k.repeated_rows, 6); assert.equal(k.n_detached, 6);
  const good = rows.map((r, i) => ({ ...r, ideology_point: i < 2 ? `在${r.unit}检测中遇到数据临界时，是否如实记录并复检？讨论篡改数据的后果` : '' }));
  const k2 = ideologyCheck({ sections: [{ key: 'content', kind: 'table', columns: [{ key: 'unit' }, { key: 'content' }, { key: 'ideology_point' }], rows: good }] });
  assert.equal(k2.embedding, 'balanced'); assert.equal(k2.repeated_rows, 0); assert.equal(k2.n_detached, 0);
});

test('立德树人专家：课堂价值表达区分“说理式”与“口号式”，并统计学生是否表态', () => {
  const ev = [
    { event_id: 'e1', actor_id: 'T', actor_type: 'scripted_agent', ideology_terms: '["工匠精神"]', text: '我们要发扬工匠精神！' },
    { event_id: 'e2', actor_id: 'S3', actor_type: 'student_agent', ideology_terms: '["数据真实性"]', text: '不能改数据，因为一旦放行不合格零件，会导致装配失效，后果由用户承担。' },
    { event_id: 'e3', actor_id: 'S4', actor_type: 'student_agent', ideology_terms: '[]', text: '老师我没听懂。' },
  ];
  assert.deepEqual(valueTalk(ev), { total: 2, reasoned: 1, slogan: 1, students: 1, firstSlogan: 'e1' });
});

test('课堂反馈摘要写入价值表达分类（启发式、需人工复核）', async () => {
  await lessonToClassroom(t, `er-${Date.now()}`);
  const r = (await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo' })).data;
  await t.post(`/api/runs/${r.run_id}/start`); for (let i = 0; i < 40; i++) await t.post(`/api/runs/${r.run_id}/step`);
  await t.post(`/api/runs/${r.run_id}/pause`);
  const fb = (await t.post(`/api/runs/${r.run_id}/feedback`)).data;
  const sum = (fb.artifact || fb).body.sections.find((s) => s.key === 'summary').content;
  const ev = (await t.get(`/api/runs/${r.run_id}`)).data.events;
  assert.ok(ev.some((e) => e.ideology_terms && e.ideology_terms !== '[]'), '示例课程含思政词');
  assert.match(sum, /说理式 \d+ 条、口号式 \d+ 条/);
  await t.post(`/api/runs/${r.run_id}/finish`);
});
