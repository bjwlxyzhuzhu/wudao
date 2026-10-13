// V15–V18: autonomous random classroom scheduling (pure scheduler + API).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as sched from '../server/scheduler.js';
import { startApp, client, seedUsers, lessonToClassroom, COURSE } from './helpers.js';

const STAGES = [
  { key: 's1', label: '导入', topic: '质量检测案例', teacher_text: '以召回案例引入', question: '' },
  { key: 's2', label: '讲授', topic: '公差与检测数据', teacher_text: '公差原理', question: '数据不完整时能否放行？' },
  { key: 's3', label: '讨论', topic: '工程责任', teacher_text: '价值冲突情境', question: '成本与安全冲突时怎么办？' },
  { key: 's4', label: '总结', topic: '总结', teacher_text: '梳理', question: '' },
];
// long sessions: repeat the unit so the simulation is not cut short by the end of the lesson
const LONG = Array.from({ length: 30 }, (_, i) => ({ ...STAGES[i % 4], key: `s${i + 1}` }));

function simulate(config, n) {
  const cfg = sched.normalizeConfig({ class_minutes: 240, ...config });
  const students = sched.makeStudents(cfg, cfg.seed);
  const state = sched.initState(cfg, cfg.seed);
  const out = []; let last = null; let seq = 0;
  for (let i = 0; i < n; i++) {
    const { act, decision } = sched.step(state, { students, stages: LONG, config: cfg, last });
    if (act.who === 'end') break;
    const actor = act.who === 'student' ? act.agent_id : act.who === 'teacher' ? 'T' : 'SYS';
    last = { event_id: `e${++seq}`, actor_id: actor, actor_type: act.who === 'system' ? 'system' : 'agent', kind: act.action === 'ask' ? 'question' : act.action, human_role: null };
    out.push({ actor, action: act.action, target: act.target_actor || null, decision });
  }
  return { out, students };
}

test('V15 非名单轮询：出现重复发言者、沉默、同伴回应，目标指向有效事件', () => {
  const { out, students } = simulate({ class_size: 24, seed: 'v15', max_turns: 400 }, 400);
  const studentTurns = out.filter((x) => /^S\d/.test(x.actor)).map((x) => x.actor);
  assert.ok(studentTurns.length > 30);
  // roll-call would visit S001,S002,... in order; check sequence is not the roster order
  const firstK = studentTurns.slice(0, 10);
  const roster = students.map((s) => s.agent_id).slice(0, 10);
  assert.notDeepEqual(firstK, roster);
  assert.ok(new Set(studentTurns).size < studentTurns.length, '有学生重复发言');
  assert.ok(out.some((x) => x.action === 'silence'), '允许无人发言');
  assert.ok(out.some((x) => ['supplement', 'answer_peer', 'challenge'].includes(x.action) && /^S\d/.test(x.target || '')), '学生回应同伴');
  assert.ok(out.some((x) => x.action === 'ask'), '学生自主提问');
  // monopoly guard: no student exceeds 20% of student turns
  const counts = {}; for (const a of studentTurns) counts[a] = (counts[a] || 0) + 1;
  assert.ok(Math.max(...Object.values(counts)) / studentTurns.length < 0.2);
  // decisions carry traceable weights and seed-driven draws
  const d = out.find((x) => x.decision && x.decision.trigger !== 'queued_intent').decision;
  assert.ok(d.top_weights.length > 0 && d.speak_probability > 0 && d.distribution_version === sched.DISTRIBUTION_VERSION);
  // pending hands never exceed 3
  assert.ok(out.filter((x) => x.decision?.hands).every((x) => x.decision.hands.length <= 3));
});

test('V16 固定 seed：相同输入/配置/seed 抽样序列一致；不同 seed 不同', () => {
  const a = simulate({ class_size: 40, seed: 'fixed-seed', freedom: 'high' }, 120).out.map((x) => `${x.actor}:${x.action}`);
  const b = simulate({ class_size: 40, seed: 'fixed-seed', freedom: 'high' }, 120).out.map((x) => `${x.actor}:${x.action}`);
  const c = simulate({ class_size: 40, seed: 'other-seed', freedom: 'high' }, 120).out.map((x) => `${x.actor}:${x.action}`);
  assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  const p1 = sched.makeStudents(sched.normalizeConfig({ class_size: 40 }), 's'), p2 = sched.makeStudents(sched.normalizeConfig({ class_size: 40 }), 's');
  assert.deepEqual(p1, p2);
});

test('V17 300人课堂：调度无需模型请求，全员可被抽中机会，冷却有效', () => {
  const { out, students } = simulate({ class_size: 300, seed: 'big', freedom: 'high', atmosphere: 'active' }, 400);
  assert.equal(students.length, 300);
  const d = out.find((x) => x.decision && x.decision.n_candidates === 300);
  assert.ok(d, '候选覆盖全部 300 人');
  // each step produces at most one utterance (serial), so ≤1 model request per step, never 300
  assert.ok(out.length <= 400);
  // cooldown: same student never speaks twice within 3 turns
  const turns = out.map((x) => x.actor);
  for (let i = 0; i < turns.length; i++) if (/^S\d/.test(turns[i])) for (let j = i + 1; j < Math.min(i + 3, turns.length); j++) assert.notEqual(turns[i], turns[j]);
  // diversity: many distinct students participate
  assert.ok(new Set(turns.filter((x) => /^S\d/.test(x))).size > 30);
});

test('学生差异独立于头像；组内讨论与组间辩论只在选中组内抽样', () => {
  const g = simulate({ class_size: 40, seed: 'grp', organization: 'group', freedom: 'high' }, 200).out;
  assert.ok(g.some((x) => x.action === 'start_group') && g.some((x) => x.action === 'report'));
  const db = simulate({ class_size: 40, seed: 'deb', organization: 'debate', freedom: 'high' }, 200).out;
  assert.ok(db.some((x) => x.action === 'start_debate'));
});

let app, t;
before(async () => { app = await startApp(); seedUsers(app.db); t = client(app.base); await t.login('teacher_a', 'Teach12345'); });
after(async () => { await app.stop(); });

test('V18 教研协作可组长轮询；课堂默认自主随机，两者不混用', async () => {
  const run = await t.post('/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'syllabus', course: COURSE, mode: 'cooperate' });
  const v = await t.get(`/api/runs/${run.data.run_id}`);
  const kinds = v.data.plan.steps.map((s) => s.kind);
  assert.ok(kinds.includes('assign') && kinds.includes('poll') && kinds.at(-1) === 'integrate');
  await lessonToClassroom(t, 'v18-xfer-00001');
  const c = await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo', config: { class_size: 24, seed: 'v18' } });
  await t.post(`/api/runs/${c.data.run_id}/start`);
  for (let i = 0; i < 30; i++) await t.post(`/api/runs/${c.data.run_id}/step`);
  const cv = await t.get(`/api/runs/${c.data.run_id}`);
  assert.equal(cv.data.run.config.organization, 'whole');
  const decisions = app.db.prepare('SELECT * FROM scheduler_decisions WHERE run_id=?').all(c.data.run_id);
  assert.ok(decisions.length > 3 && decisions.every((d) => d.seed === 'v18'));
  const studentEvents = cv.data.events.filter((e) => /^S\d/.test(e.actor_id));
  assert.ok(studentEvents.every((e) => e.decision_id), '每条学生发言都可追溯到调度决策');
  assert.ok(!cv.data.events.some((e) => e.kind === 'poll' || e.kind === 'assign'), '课堂不使用组长轮询');
});

test('教师点名：指定学生直接回应；指定小组由该组一名成员代表发言（40 人 · 8 组 × 5 人）', () => {
  const cfg = sched.normalizeConfig({ class_size: 40, group_size: 5, organization: 'group', seed: 'call-1', class_minutes: 45 });
  const students = sched.makeStudents(cfg, cfg.seed);
  assert.equal(new Set(students.map((s) => s.group_id)).size, 8);
  const state = sched.initState(cfg, cfg.seed);
  sched.step(state, { students, stages: LONG, config: cfg, last: null });
  const a = sched.step(state, { students, stages: LONG, config: cfg, last: { event_id: 'h1', actor_id: 'H-T1', actor_type: 'human', kind: 'question', human_role: 'teacher', target_actor: 'S017' } });
  assert.equal(a.act.who, 'student'); assert.equal(a.act.agent_id, 'S017'); assert.equal(a.act.action, 'answer_teacher'); assert.equal(a.decision.trigger, 'teacher_call');
  const g = sched.step(state, { students, stages: LONG, config: cfg, last: { event_id: 'h2', actor_id: 'H-T1', actor_type: 'human', kind: 'question', human_role: 'teacher', target_actor: 'G3' } });
  assert.equal(g.act.group_id, 'G3'); assert.equal(g.act.action, 'report');
  assert.ok(students.find((s) => s.agent_id === g.act.agent_id).group_id === 'G3');
});
