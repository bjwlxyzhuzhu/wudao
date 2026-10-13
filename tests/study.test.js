// 科研数据中心：表格读写与智能映射、统计（α/κ/Krippendorff α/ICC/题目分析/滞后序列）、项目—被试—知情同意—量表—作答—编码—评分一致性—导出全流程。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, seedUsers, unzip } from './helpers.js';
import { APP_VERSION } from '../server/research.js';
import { parseCsv, parseXlsx, toXlsx, suggestMapping, coerce } from '../server/tabular.js';
import { cronbach, cohenKappa, krippendorff, icc, itemAnalysis, lagSequential } from '../server/stats.js';

const b64 = (x) => Buffer.from(x).toString('base64');
let app, t;
before(async () => { app = await startApp(); seedUsers(app.db); t = client(app.base); await t.login('teacher_a', 'Teach12345'); });
after(async () => { await app.stop(); });

test('表格读取：CSV 引号/逗号/换行；XLSX 空单元格保持列位置；写出后可原样读回', () => {
  assert.deepEqual(parseCsv('a,b,c\n"x,1","he said ""hi""","多\n行"\n'), [['a', 'b', 'c'], ['x,1', 'he said "hi"', '多\n行']]);
  assert.deepEqual(parseCsv('编号\t得分\nP1\t3\n'), [['编号', '得分'], ['P1', '3']]);
  const buf = toXlsx([{ name: '数据', header: ['编码', '年龄', '备注'], rows: [['P1', 20, ''], ['P2', '', '=1+1']] }]);
  const [s] = parseXlsx(buf);
  assert.equal(s.name, '数据');
  assert.deepEqual(s.rows, [['编码', '年龄', '备注'], ['P1', '20', ''], ['P2', '', '=1+1']], '空单元格不会让后面的列左移；公式文本按字符串写入');
});

test('智能映射：中文/英文/近似表头匹配到字段；类型转换与校验', () => {
  const fields = [{ key: 'code', label: '被试编码', synonyms: ['编号', 'id'] }, { key: 'gender', label: '性别' }, { key: 'prior_score', label: '前测/先修成绩', synonyms: ['前测'] }, { key: 'consent', label: '知情同意' }];
  const m = suggestMapping(['ID', '性别(男/女)', '前测成绩', '是否签署知情同意书', '爱好'], fields);
  assert.deepEqual(m.map((x) => x.field), ['code', 'gender', 'prior_score', 'consent', null]);
  assert.deepEqual(coerce('85分', { type: 'number', label: 'x' }), { value: 85 });
  assert.ok(coerce('abc', { type: 'int', label: '年龄' }).error);
  assert.deepEqual(coerce('2026/9/1', { type: 'date', label: 'd' }), { value: '2026-09-01' });
  assert.deepEqual(coerce('46000', { type: 'date', label: 'd' }), { value: '2025-12-09' }, 'Excel 日期序列号');
  assert.deepEqual(coerce('同意', { type: 'enum', label: 'c', options: { consented: ['已同意', '同意'], declined: ['拒绝'] } }), { value: 'consented' });
});

test('统计：κ、Krippendorff α、ICC、Cronbach α、题目分析、滞后序列与已知结果一致', () => {
  const pairs = [...Array(20).fill(['Y', 'Y']), ...Array(5).fill(['Y', 'N']), ...Array(10).fill(['N', 'Y']), ...Array(15).fill(['N', 'N'])];
  const k = cohenKappa(pairs); assert.equal(k.percent_agreement, 0.7); assert.equal(k.kappa, 0.4);
  assert.equal(krippendorff([[1, 1], [1, 1], [2, 2], [1, 2]], 'nominal').alpha, 0.533);
  assert.equal(krippendorff([[3, 3], [2, 2], [4, 4]], 'interval').alpha, 1);
  const sf = icc([[9, 2, 5, 8], [6, 1, 3, 2], [8, 4, 6, 8], [7, 1, 2, 6], [10, 5, 6, 9], [6, 2, 4, 7]]); // Shrout & Fleiss (1979) 示例
  for (const [k, v] of [['icc2_1', 0.29], ['icc3_1', 0.71], ['icc3_k', 0.91]]) assert.ok(Math.abs(sf[k] - v) < 0.01, `${k}=${sf[k]}`);
  assert.equal(cronbach([[1, 1, 1], [2, 2, 2], [3, 3, 3], [5, 5, 5]]).alpha, 1);
  const c = cronbach([[1, 2], [2, 1], [3, 3], [4, 5], [5, 4]]); assert.ok(c.alpha > 0.8 && c.alpha < 1);
  const ia = itemAnalysis([[1, 1, 0], [1, 0, 0], [1, 1, 1], [0, 0, 0], [1, 1, 1], [1, 0, 0]], [1, 1, 1]);
  assert.equal(ia.items[0].difficulty_p, 0.833); assert.ok('kr20' in ia.reliability);
  const lag = lagSequential([['A', 'B', 'A', 'B'], ['A', 'B']]);
  assert.equal(lag.n_transitions, 4); assert.equal(lag.cells.find((x) => x.from === 'A' && x.to === 'B').observed, 3);
});

test('研究全流程：项目 → 名册与知情同意 → 量表题项与作答 → α → 退出与数据删除 → 导出', async () => {
  const p = (await t.post('/api/research/projects', { title: 'AI 辅助数字教研对课程思政教学设计能力的影响', code: 'CSR01', body: { field: '教育技术学', design: 'quasi_prepost', rqs: ['平台使用是否提升设计能力？'],
    conditions: [{ code: 'EXP', label: '实验组' }, { code: 'CTL', label: '对照组' }], timepoints: [{ code: 'T0', label: '前测' }, { code: 'T1', label: '后测' }] } })).data;
  const pid = p.project.project_id;
  assert.equal(p.checklist.find((c) => c.key === 'ethics').status, 'todo');
  // 名册：含“姓名”列（自动忽略）、中文同意状态、未设置的组别报错
  const roster = `编号,姓名,组别,性别,是否同意\nP01,张三,EXP,女,同意\nP02,李四,EXP,男,同意\nP03,王五,CTL,女,同意\nP04,赵六,CTL,男,同意\nP05,孙七,CTL,女,拒绝\nP06,周八,XYZ,男,同意\n`;
  const pv = (await t.post('/api/io/preview', { dataset: 'participants', ctx: { project_id: pid }, filename: 'roster.csv', data_base64: b64(roster) })).data;
  assert.deepEqual(pv.ignored_pii_columns, ['姓名']);
  assert.equal(pv.mapping.find((m) => m.column === '是否同意').field, 'consent');
  assert.equal(pv.n_valid, 5); assert.equal(pv.n_errors, 1); assert.match(pv.errors[0].messages[0], /组别“XYZ”未在项目中设置/);
  assert.equal((await t.post('/api/io/commit', { dataset: 'participants', ctx: { project_id: pid }, filename: 'roster.csv', data_base64: b64(roster) })).status, 400, '有错误行时默认拒绝整批');
  const cm = (await t.post('/api/io/commit', { dataset: 'participants', ctx: { project_id: pid }, filename: 'roster.csv', data_base64: b64(roster), skip_invalid: true })).data;
  assert.equal(cm.inserted, 5); assert.equal(cm.skipped_invalid, 1);
  const pv2 = (await t.get(`/api/research/projects/${pid}`)).data;
  assert.equal(pv2.flow.consented, 4); assert.equal(pv2.flow.declined, 1);
  assert.ok(!pv2.participants.some((x) => /张三/.test(JSON.stringify(x))), '姓名未入库');

  // 量表：导入题项（XLSX，含反向题）
  const inst = (await t.post('/api/research/instruments', { project_id: pid, kind: 'scale', name: '设计效能感（自编）', code: 'SE', scale: [1, 5], source_status: 'self_developed' })).data.instrument;
  const itemsX = toXlsx([{ name: '题项', header: ['题号', '维度', '题目', '反向'], rows: [['SE1', 'A', '我能设计…', '否'], ['SE2', 'A', '我能评价…', '否'], ['SE3', 'A', '我难以…', '是'], ['SE4', 'B', '我会…', ''], ['SE5', 'B', '我愿意…', '']] }]);
  const ci = (await t.post('/api/io/commit', { dataset: 'scale_items', ctx: { instrument_id: inst.instrument_id }, filename: 'items.xlsx', data_base64: itemsX.toString('base64') })).data;
  assert.equal(ci.inserted, 5);
  const iv = (await t.get(`/api/research/instruments/${inst.instrument_id}`)).data;
  assert.equal(iv.items.find((x) => x.code === 'SE3').reverse, 1);
  // 作答（宽表），表头用 Q1… 与题号混写；P99 未登记 → 报错；越界值报错
  const resp = `被试编码,时间点,Q1,SE2,第3题,SE4,SE5\nP01,前测,4,4,2,3,3\nP02,前测,5,4,1,4,5\nP03,前测,2,3,4,2,2\nP04,T0,3,3,3,3,4\nP99,T0,3,3,3,3,3\nP01,T1,9,4,1,4,4\n`;
  const rp = (await t.post('/api/io/preview', { dataset: 'responses', ctx: { instrument_id: inst.instrument_id }, filename: 'resp.csv', data_base64: b64(resp) })).data;
  assert.deepEqual(rp.mapping.map((m) => m.field), ['participant_code', 'timepoint', 'item:SE1', 'item:SE2', 'item:SE3', 'item:SE4', 'item:SE5']);
  assert.equal(rp.n_errors, 2); assert.ok(rp.errors.some((e) => /P99 未在被试名册中登记/.test(e.messages.join())));
  assert.ok(rp.errors.some((e) => /不能大于 5/.test(e.messages.join())));
  await t.post('/api/io/commit', { dataset: 'responses', ctx: { instrument_id: inst.instrument_id }, filename: 'resp.csv', data_base64: b64(resp), skip_invalid: true });
  const an = (await t.get(`/api/research/instruments/${inst.instrument_id}/analysis`)).data;
  const relA = an.reliability.find((r) => r.timepoint === 'T0' && r.dimension === 'A');
  assert.equal(relA.n, 4); assert.ok(relA.alpha > 0.7, `反向题已反转后维度 A 内部一致 α=${relA.alpha}`);
  assert.ok(an.descriptives.some((d) => d.condition === 'EXP' && d.dimension === 'A' && d.n === 2));
  // 退出：被试 P04 退出后不再进入分析与导出；删除其数据
  const p04 = pv2.participants.find((x) => x.code === 'P04');
  await t.put(`/api/research/participants/${p04.participant_id}`, { consent: 'withdrawn' });
  assert.equal((await t.get(`/api/research/instruments/${inst.instrument_id}/analysis`)).data.reliability.find((r) => r.timepoint === 'T0' && r.dimension === 'A').n, 3);
  const pg = (await t.post(`/api/research/participants/${p04.participant_id}/purge`, { confirm: true })).data;
  assert.equal(pg.responses_deleted, 5);
  // 导出：XLSX 可读回、CSV 以字段键为表头、SPSS 语法、导入模板（只有表头与字段说明）
  const x = await t.get(`/api/io/export?dataset=responses&instrument_id=${inst.instrument_id}&format=xlsx`);
  const sheets = parseXlsx(x.data); assert.equal(sheets[0].rows[0][0], '被试编码'); assert.equal(sheets[0].rows.length, 1 + 3 + 0, '3 名同意被试的前测 + P01 后测被拒（越界）');
  const sps = unzip((await t.get(`/api/io/export?dataset=responses&instrument_id=${inst.instrument_id}&format=sps`)).data);
  assert.match(sps['data.sps'].toString(), /GET DATA \/TYPE=TXT/); assert.match(sps['data.sps'].toString(), /VARIABLE LABELS/); assert.match(sps['data.csv'].toString(), /"participant_code",/);
  const tpl = parseXlsx((await t.get(`/api/io/export?dataset=participants&project_id=${pid}&format=template`)).data);
  assert.equal(tpl[0].rows.length, 1, '模板只有表头，不含编造的示例数据'); assert.equal(tpl[1].name, '字段说明');
  const pr = parseCsv((await t.get(`/api/io/export?dataset=participants&project_id=${pid}&format=csv`)).data.toString());
  assert.equal(pr.length, 1 + 3, '导出只含已同意被试'); assert.equal(pr[0][0], 'code');
});

test('测试：从答案键自动计分、题目分析；结构模板题项标注为占位', async () => {
  const pid = (await t.post('/api/research/projects', { title: '测试项目', body: { timepoints: [{ code: 'T1', label: '后测' }] } })).data.project.project_id;
  await t.post('/api/io/commit', { dataset: 'participants', ctx: { project_id: pid }, filename: 'r.csv', data_base64: b64(`code,consent\n${Array.from({ length: 8 }, (_, i) => `S${i + 1},已同意`).join('\n')}\n`) });
  const ti = (await t.post('/api/research/instruments', { project_id: pid, kind: 'test', name: '单元测验', code: 'QZ' })).data.instrument;
  await t.post('/api/io/commit', { dataset: 'test_items', ctx: { instrument_id: ti.instrument_id }, filename: 'q.csv', data_base64: b64('题号,题型,题干,答案,分值\nQ1,单选,…,B,1\nQ2,判断,…,对,1\nQ3,多选,…,ACD,2\nQ4,简答,…,,4\n') });
  const ans = ['B,√,DCA,3', 'B,对,AC,4', 'A,错,ACD,1', 'B,T,ACD,2', 'C,F,A,0', 'B,对,ACD,4', 'A,对,CD,1', 'B,错,ACD,3'];
  await t.post('/api/io/commit', { dataset: 'responses', ctx: { instrument_id: ti.instrument_id, timepoint: 'T1' }, filename: 'a.csv', data_base64: b64(`编码,Q1,Q2,Q3,Q4\n${ans.map((a, i) => `S${i + 1},${a}`).join('\n')}\n`) });
  const an = (await t.get(`/api/research/instruments/${ti.instrument_id}/analysis`)).data;
  const it = an.item_analysis[0];
  assert.equal(it.n, 8); assert.equal(it.items[0].difficulty_p, 0.625, 'Q1：8 人中 5 人选 B');
  assert.equal(it.items[2].difficulty_p, 0.625, 'Q3 多选顺序无关：DCA 与 ACD 同分');
  assert.equal(an.max_total, 8);
  const sk = (await t.post('/api/research/instruments', { project_id: pid, skeleton: 'tpack' })).data;
  assert.equal(sk.instrument.body.source_status, 'placeholder'); assert.ok(sk.items.every((x) => x.placeholder === 1));
  const v = (await t.get(`/api/research/projects/${pid}`)).data;
  assert.equal(v.checklist.find((c) => c.key === 'instruments').status, 'warn');
});

test('话语编码：导入转录（自动脱敏）、两位编码者盲编、κ 与分歧清单、ENA/滞后序列、项目数据包', async () => {
  const pid = (await t.post('/api/research/projects', { title: '话语分析', code: 'DA1', body: {} })).data.project.project_id;
  const tr = `课次,序号,说话人,话语\nL1,1,T,同学们先看这个零件的图纸。\nL1,2,S1,老师我觉得公差是0.04，联系我13900001111\nL1,3,T,为什么？依据是什么？\nL1,4,S2,因为上偏差减下偏差。\nL1,5,T,很好，那检测数据能不能改？\nL1,6,S1,不能，数据必须真实。\n`;
  const u = (await t.post('/api/io/commit', { dataset: 'units', ctx: { project_id: pid }, filename: 't.csv', data_base64: b64(tr) })).data;
  assert.equal(u.inserted, 6);
  const cb = (await t.post('/api/research/codebooks', { project_id: pid, name: 'IRF', mode: 'exclusive' })).data;
  await t.post('/api/io/commit', { dataset: 'codes', ctx: { codebook_id: cb.codebook.codebook_id }, filename: 'c.csv', data_base64: b64('代码,名称,定义\nI,发起,教师提问或布置\nR,回应,学生回答\nF,反馈,教师评价追问\n') });
  const cid = cb.codebook.codebook_id;
  const cv = (await t.get(`/api/research/codebooks/${cid}/coding?coder=C1`)).data;
  assert.equal(cv.units.length, 6); assert.match(cv.units[1].text, /\[手机号已隐去\]/);
  const A = ['I', 'R', 'F', 'R', 'F', 'R'], B = ['I', 'R', 'I', 'R', 'F', 'R'];
  for (let i = 0; i < 6; i++) { await t.post('/api/research/codings', { codebook_id: cid, unit_id: cv.units[i].unit_id, coder: 'C1', codes: [A[i]] }); }
  const blind = (await t.get(`/api/research/codebooks/${cid}/coding?coder=C2`)).data;
  assert.ok(blind.units.every((x) => x.mine.length === 0), '盲编：C2 看不到 C1 的编码');
  for (let i = 0; i < 6; i++) await t.post('/api/research/codings', { codebook_id: cid, unit_id: cv.units[i].unit_id, coder: 'C2', codes: [B[i]] });
  const irr = (await t.get(`/api/research/codebooks/${cid}/irr`)).data;
  assert.equal(irr.n_units_shared, 6); assert.equal(irr.pairs[0].percent_agreement, 0.833); assert.equal(irr.disagreements.length, 1);
  const sq = (await t.get(`/api/research/codebooks/${cid}/sequence?coder=C1`)).data;
  assert.equal(sq.lag.n_transitions, 5);
  assert.equal((await t.post('/api/research/codings', { codebook_id: cid, unit_id: cv.units[0].unit_id, coder: 'C1', codes: ['I', 'R'] })).status, 400, '互斥编码不允许多码');
  const zipBuf = (await t.post(`/api/research/projects/${pid}/package`, {})).data;
  const files = unzip(zipBuf);
  for (const f of ['DA1/README.md', 'DA1/manifest.json', 'DA1/units.csv', 'DA1/codings_IRF.csv', 'DA1/ena_IRF.csv', 'DA1/lag_sequential_IRF.csv', 'DA1/irr_IRF.json', 'DA1/analysis.R']) assert.ok(files[f], f);
  assert.match(files['DA1/units.csv'].toString(), /\[省略\]/, '默认不导出话语正文');
  const man = JSON.parse(files['DA1/manifest.json']); assert.equal(man.app_version, APP_VERSION, '清单里的版本号与代码常量一致'); assert.ok(man.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
});

test('评分一致性：外部评分导入（多位评价者）→ 加权 κ / Krippendorff α / ICC', async () => {
  const run = (await t.post('/api/runs', { module: 'seminar', exec_mode: 'demo', type: 'lesson_plan', course: { name: '机械质量检测', unit: '公差' } })).data;
  await t.post(`/api/runs/${run.run_id}/start`); for (let i = 0; i < 12; i++) await t.post(`/api/runs/${run.run_id}/step`);
  const ev = (await t.get(`/api/runs/${run.run_id}`)).data.events.filter((e) => e.actor_type !== 'system').slice(0, 5);
  const rub = (await t.get('/api/rubrics')).data.rubrics[0]; const d0 = rub.body.dimensions[0];
  const sc1 = [4, 3, 2, 1, 0], sc2 = [4, 3, 1, 1, 0];
  const csv = `对象ID,评价者,${d0.label}\n${ev.map((e, i) => `${e.event_id},R1,${sc1[i]}`).join('\n')}\n${ev.map((e, i) => `${e.event_id},R2,${sc2[i]}`).join('\n')}\n`;
  const c = (await t.post('/api/io/commit', { dataset: 'ratings', ctx: { rubric_id: rub.rubric_id }, filename: 'r.csv', data_base64: b64(csv) })).data;
  assert.equal(c.inserted, 10);
  const irr = (await t.get(`/api/research/rating-irr?rubric_id=${rub.rubric_id}`)).data;
  const dim = irr.dimensions.find((x) => x.key === d0.key);
  assert.equal(dim.n_shared, 5); assert.ok(dim.weighted_kappa > 0.9 && dim.icc2_1 > 0.9 && dim.krippendorff_ordinal > 0.8, JSON.stringify(dim));
  await t.post(`/api/runs/${run.run_id}/finish`);
});

test('产物表格：导出 XLSX、再导入预览时按列名匹配并返回规范化行（不直接写库）', async () => {
  const r0 = (await t.post('/api/artifacts', { module: 'seminar', type: 'lesson_plan', title: '表格测试' })).data; const a = { artifact: r0.artifact || r0 };
  const sec = a.artifact.body.sections.find((s) => s.kind === 'table');
  const x = await t.get(`/api/io/export?dataset=artifact_section&artifact_id=${a.artifact.artifact_id}&section_key=${sec.key}&format=xlsx`);
  const head = parseXlsx(x.data)[0].rows[0];
  assert.deepEqual(head, sec.columns.map((c) => c.label));
  const rows = [head, sec.columns.map((c, i) => `值${i}`)];
  const pv = (await t.post('/api/io/preview', { dataset: 'artifact_section', ctx: { artifact_id: a.artifact.artifact_id, section_key: sec.key }, filename: 's.xlsx', data_base64: toXlsx([{ name: 's', header: rows[0], rows: rows.slice(1) }]).toString('base64') })).data;
  assert.equal(pv.preview_only, true); assert.equal(pv.records.length, 1); assert.equal(pv.records[0][sec.columns[0].key], '值0');
  assert.equal((await t.post('/api/io/commit', { dataset: 'artifact_section', ctx: { artifact_id: a.artifact.artifact_id, section_key: sec.key }, filename: 's.csv', data_base64: b64('a\n1\n') })).status, 400);
});

test('研究导出包含智能体训练与班级画像元数据，版本号更新；个人备份包含科研数据表', async () => {
  const pv = (await t.post('/api/export/preview', { categories: ['agents'] })).data;
  assert.deepEqual(pv.tables.map((x) => x.name).sort(), ['agent_trainings.csv', 'class_profiles.csv']);
  const bk0 = (await t.get('/api/backup')).data; const bk = Buffer.isBuffer(bk0) ? JSON.parse(bk0.toString()) : bk0;
  assert.equal(bk.schema_version, '5.1'); assert.ok(Array.isArray(bk.data.study_projects) && bk.data.study_projects.length >= 3);
  const plan = (await t.post('/api/restore/preview', { data: bk })).data;
  assert.equal(plan.ok, true); assert.ok(plan.counts.study_responses > 0);
});
