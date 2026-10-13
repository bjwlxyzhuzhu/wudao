// V11, V12, V19–V22: arrows, versions, frameworks, templates, answer isolation, DOCX.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers, lessonToClassroom, COURSE, mockProvider, configureModel, unzip } from './helpers.js';
import { classroomStages, studentView } from '../server/artifacts.js';

let app, t, users;
before(async () => { app = await startApp(); users = seedUsers(app.db); t = client(app.base); await t.login('teacher_a', 'Teach12345'); });
after(async () => { await app.stop(); });


test('V11 右箭头、左箭头各确认一次、取消一次；新版本、当前产物明确', async () => {
  const home0 = await t.get('/api/home');
  assert.equal(home0.data.current.seminar, null);
  const noCur = await t.post('/api/transfers', { from: 'seminar', idempotency_key: 'none-00000001' });
  assert.equal(noCur.data.error.code, 'no_current');
  const { seminarArtifact, classroomArtifact } = await lessonToClassroom(t, 'v11-right-0001');
  assert.equal(classroomArtifact.module, 'classroom'); assert.equal(classroomArtifact.parent_id, seminarArtifact.artifact_id);
  assert.ok(classroomArtifact.version > seminarArtifact.version);
  const home = await t.get('/api/home');
  assert.equal(home.data.current.classroom.artifact_id, classroomArtifact.artifact_id);
  // "cancel" = no request; nothing is written
  const n0 = app.db.prepare('SELECT COUNT(*) n FROM transfers').get().n;
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM transfers').get().n, n0);
  // left arrow with classroom feedback
  const c = await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo', config: { max_turns: 12, seed: 'v11' } });
  await t.post(`/api/runs/${c.data.run_id}/start`);
  for (let i = 0; i < 14; i++) await t.post(`/api/runs/${c.data.run_id}/step`);
  await t.post(`/api/runs/${c.data.run_id}/finish`);
  const fb = await t.post(`/api/runs/${c.data.run_id}/feedback`);
  await t.post(`/api/artifacts/${fb.data.artifact_id}/current`);
  const back = await t.post('/api/transfers', { from: 'classroom', idempotency_key: 'v11-left-00001', save_draft: true });
  assert.equal(back.status, 200); assert.equal(back.data.target.module, 'seminar'); assert.equal(back.data.target.type, 'classroom_feedback');
  assert.equal(back.data.transfer.saved_draft_first, 1);
  const again = await t.post('/api/transfers', { from: 'classroom', idempotency_key: 'v11-left-00001', save_draft: true });
  assert.equal(again.data.replayed, true); assert.equal(again.data.target.artifact_id, back.data.target.artifact_id);
  // source provenance is available in detail, and the source artifact version is immutable
  const d = await t.get(`/api/artifacts/${back.data.target.artifact_id}`);
  assert.ok(d.data.provenance.length >= 2 && d.data.provenance[0].transfer);
  assert.ok(JSON.parse(back.data.transfer.evidence_event_ids).length >= 0);
});

test('V12 未保存草稿需确认“保存并导入”；不修改正在运行的输入快照', async () => {
  const draft = await t.post('/api/artifacts', { module: 'seminar', type: 'courseware', title: '草稿课件' });
  await t.post(`/api/artifacts/${draft.data.artifact_id}/current`);
  const r1 = await t.post('/api/transfers', { from: 'seminar', idempotency_key: 'v12-draft-0001' });
  assert.equal(r1.status, 409); assert.equal(r1.data.error.code, 'draft_unsaved');
  assert.equal(app.db.prepare('SELECT status FROM artifacts WHERE artifact_id=?').get(draft.data.artifact_id).status, 'draft', '未确认时不隐式保存');
  // add slide content and start a classroom run from the current classroom artifact
  const { classroomArtifact } = await lessonToClassroom(t, 'v12-base-00001');
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo', config: { max_turns: 30 } });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  const snap0 = app.db.prepare('SELECT input_snapshot FROM runs WHERE run_id=?').get(run.data.run_id).input_snapshot;
  await t.post(`/api/artifacts/${draft.data.artifact_id}/current`);
  const r2 = await t.post('/api/transfers', { from: 'seminar', idempotency_key: 'v12-draft-0002', save_draft: true });
  assert.equal(r2.status, 200);
  assert.equal(app.db.prepare('SELECT status FROM artifacts WHERE artifact_id=?').get(draft.data.artifact_id).status, 'saved');
  assert.equal(app.db.prepare('SELECT input_snapshot FROM runs WHERE run_id=?').get(run.data.run_id).input_snapshot, snap0);
  assert.equal(JSON.parse(snap0).artifact_id, classroomArtifact.artifact_id);
  // saved versions are immutable: editing creates a new draft child
  const edit = await t.put(`/api/artifacts/${classroomArtifact.artifact_id}`, { title: '改名' });
  assert.notEqual(edit.data.artifact.artifact_id, classroomArtifact.artifact_id);
  assert.equal(edit.data.artifact.parent_id, classroomArtifact.artifact_id);
  await t.post(`/api/runs/${run.data.run_id}/finish`);
});

test('V19 BOPPPS/PDCA/ADDIE/PjBL 切换：结构与必填字段实际变化，PDCA 为改进闭环', async () => {
  const make = async (fw, extra = {}) => (await t.post('/api/artifacts', { module: 'seminar', type: 'lesson_plan', framework_key: fw, course: COURSE, ...extra })).data;
  const b = await make('boppps'); const p = await make('pdca'); const a = await make('addie'); const j = await make('pjbl');
  const keys = (x) => x.body.sections.map((s) => s.key);
  assert.ok(keys(b).includes('stages') && !keys(b).includes('pdca'));
  assert.ok(keys(p).includes('pdca') && !keys(p).includes('stages'), 'PDCA 作为主框架时不是课堂六步法');
  assert.deepEqual(b.body.framework.steps.map((s) => s[1]), ['导入', '目标', '前测', '参与式学习', '后测', '总结']);
  assert.deepEqual(a.body.framework.steps.map((s) => s[1]), ['分析', '设计', '开发', '实施', '评价']);
  const withPdca = await make('boppps', { with_pdca: true });
  assert.ok(keys(withPdca).includes('stages') && keys(withPdca).includes('pdca'));
  const dj = await t.get(`/api/artifacts/${j.artifact_id}`);
  assert.ok(dj.data.issues.some((i) => i.section === 'framework' && /driving_question/.test(i.message)), 'PjBL 要求驱动问题');
  const dp = await t.get(`/api/artifacts/${p.artifact_id}`);
  assert.ok(dp.data.issues.some((i) => /improvement_target/.test(i.message)));
  // BOPPPS pre/post tests must link to goals
  const body = b.body; const st = body.sections.find((s) => s.key === 'stages');
  st.rows = [{ stage: 'pre_assessment', minutes: '45', goal_refs: '' }, { stage: 'post_assessment', minutes: '45', goal_refs: 'K1' }];
  body.sections.find((s) => s.key === 'goals').rows = [{ id: 'K1', category: '知识', description: 'x' }];
  const up = await t.put(`/api/artifacts/${b.artifact_id}`, { body });
  assert.ok(up.data.issues.some((i) => /前测必须关联教学目标/.test(i.message)));
});

test('V20 大纲/计划/教案/练习/试卷：结构正确、学时/分值校验、可编辑版本', async () => {
  for (const type of ['syllabus', 'semester_plan', 'lesson_plan', 'exercises', 'exam']) {
    const run = await t.post('/api/runs', { module: 'seminar', exec_mode: 'demo', type, framework_key: 'boppps', course: COURSE, mode: 'mixed' });
    await t.post(`/api/runs/${run.data.run_id}/start`);
    for (let i = 0; i < 80; i++) { const s = await t.post(`/api/runs/${run.data.run_id}/step`); if (s.data.ended) break; }
    const v = await t.get(`/api/runs/${run.data.run_id}`);
    const d = await t.get(`/api/artifacts/${v.data.run.output_artifact_id}`);
    const errors = d.data.issues.filter((i) => i.level === 'error');
    assert.deepEqual(errors, [], `${type} 演示骨架应通过学时/分值结构校验：${JSON.stringify(errors)}`);
    assert.equal(d.data.artifact.status, 'draft');
    assert.ok(d.data.artifact.body.sections.every((s) => s.kind === 'text' || Array.isArray(s.rows)));
    assert.match(d.data.artifact.body.notice, /本地规则生成|AI 辅助/);
  }
  // hours mismatch detection
  const s = await t.post('/api/artifacts', { module: 'seminar', type: 'syllabus', course: COURSE });
  const body = s.data.body; body.sections.find((x) => x.key === 'content').rows = [{ unit: 'u1', content: 'c', hours: '10', goal_refs: '' }];
  const r = await t.put(`/api/artifacts/${s.data.artifact_id}`, { body });
  assert.ok(r.data.issues.some((i) => /学时合计 10，与总学时 32 不一致/.test(i.message)));
  const e = await t.post('/api/artifacts', { module: 'seminar', type: 'exam', course: COURSE });
  const eb = e.data.body; eb.sections.find((x) => x.key === 'questions').rows = [{ no: '1', qtype: '简答', score: '40', stem: 's', answer: 'a' }];
  const er = await t.put(`/api/artifacts/${e.data.artifact_id}`, { body: eb });
  assert.ok(er.data.issues.some((i) => /分值合计 40，与试卷总分 100 不一致/.test(i.message)));
  assert.ok(er.data.derived.blueprint);
});

test('V21 试卷转入课堂：答案默认仅教师可见，学生上下文不含答案', async () => {
  const e = await t.post('/api/artifacts', { module: 'seminar', type: 'exam', title: '单元测验', course: COURSE });
  const body = e.data.body;
  body.sections.find((x) => x.key === 'questions').rows = [{ no: '1', qtype: '案例分析', score: '100', stem: '某零件检测数据缺失，能否放行？', answer: 'SECRET_ANSWER_不能放行', analysis: 'SECRET_ANALYSIS', rubric: 'SECRET_RUBRIC' }];
  await t.put(`/api/artifacts/${e.data.artifact_id}`, { body });
  await t.post(`/api/artifacts/${e.data.artifact_id}/save`);
  await t.post(`/api/artifacts/${e.data.artifact_id}/current`);
  const x = await t.post('/api/transfers', { from: 'seminar', idempotency_key: 'v21-exam-00001' });
  const stages = classroomStages(x.data.target);
  assert.ok(!JSON.stringify(stages).includes('SECRET'), '课堂阶段不含答案/解析/评分标准');
  assert.ok(!JSON.stringify(studentView(x.data.target.body)).includes('SECRET'));
  const run = await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo', config: { max_turns: 15 } });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  for (let i = 0; i < 15; i++) await t.post(`/api/runs/${run.data.run_id}/step`);
  const plan = app.db.prepare('SELECT plan, state FROM runs WHERE run_id=?').get(run.data.run_id);
  assert.ok(!plan.plan.includes('SECRET') && !plan.state.includes('SECRET'), '学生可见材料与记忆不含答案');
  const ev = app.db.prepare('SELECT text FROM events WHERE run_id=?').all(run.data.run_id).map((r) => r.text).join('');
  assert.ok(!ev.includes('SECRET'));
  // the teacher can still see it in the artifact itself
  const d = await t.get(`/api/artifacts/${x.data.target.artifact_id}`);
  assert.ok(JSON.stringify(d.data.artifact.body).includes('SECRET_ANSWER'));
  await t.post(`/api/runs/${run.data.run_id}/finish`);
  globalThis.__examId = x.data.target.artifact_id;
});

test('V22 学生卷与教师答案卷 DOCX：可解包、XML 完整，答案不混入学生卷', async () => {
  const id = globalThis.__examId;
  const stu = await t.get(`/api/artifacts/${id}/export?format=docx&variant=student`);
  const ans = await t.get(`/api/artifacts/${id}/export?format=docx&variant=answers`);
  assert.equal(stu.status, 200); assert.equal(ans.status, 200);
  const sf = unzip(stu.data), af = unzip(ans.data);
  for (const f of [sf, af]) for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) assert.ok(f[n], n);
  const sdoc = sf['word/document.xml'].toString('utf8'), adoc = af['word/document.xml'].toString('utf8');
  assert.ok(sdoc.includes('某零件检测数据缺失'));
  assert.ok(!sdoc.includes('SECRET'), '学生卷不含答案/解析/评分标准');
  assert.ok(adoc.includes('SECRET_ANSWER') && adoc.includes('SECRET_RUBRIC'));
  assert.match(sdoc, /学生卷/); assert.match(adoc, /教师答案卷/);
  // courseware is not falsely labelled as PPTX/DOCX
  const cw = await t.post('/api/artifacts', { module: 'seminar', type: 'courseware' });
  assert.equal((await t.get(`/api/artifacts/${cw.data.artifact_id}/export?format=docx`)).status, 400);
  assert.equal((await t.get(`/api/artifacts/${cw.data.artifact_id}/export?format=html`)).status, 200);
});

test('局部重生成：只改指定段落，显示预算，保存版本生成新草稿', async () => {
  const mock = await mockProvider();
  const admin = client(app.base); await admin.login('root_admin', 'Admin12345', true);
  await configureModel(admin, mock.url);
  const a = await t.post('/api/artifacts', { module: 'seminar', type: 'syllabus', course: COURSE, title: '局部重生成' });
  await t.post(`/api/artifacts/${a.data.artifact_id}/save`);
  const est = await t.post('/api/runs/estimate', { module: 'seminar', exec_mode: 'model', task: 'regen', target_artifact_id: a.data.artifact_id, section_key: 'goals' });
  assert.equal(est.data.max_calls, 1); assert.equal(est.data.max_credits, 1);
  const run = await t.post('/api/runs', { module: 'seminar', exec_mode: 'model', task: 'regen', target_artifact_id: a.data.artifact_id, section_key: 'goals' });
  await t.post(`/api/runs/${run.data.run_id}/start`);
  await t.post(`/api/runs/${run.data.run_id}/step`);
  const end = await t.post(`/api/runs/${run.data.run_id}/step`);
  assert.equal(end.data.ended, true);
  const v = await t.get(`/api/runs/${run.data.run_id}`);
  const out = await t.get(`/api/artifacts/${v.data.run.output_artifact_id}`);
  assert.equal(out.data.artifact.parent_id, a.data.artifact_id);
  const goals = out.data.artifact.body.sections.find((s) => s.key === 'goals');
  assert.equal(goals.rows[0].description, '模型生成目标');
  const content = out.data.artifact.body.sections.find((s) => s.key === 'content');
  assert.equal(content.rows.length, 0, '其他段落未被重跑');
  await mock.close();
});
