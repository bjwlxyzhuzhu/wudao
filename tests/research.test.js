// V23–V25, V27: ratings, rubric import, research ZIP, timing fields, migration/restore.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { startApp, client, seedUsers, lessonToClassroom, unzip } from './helpers.js';

let app, t, t2, runId;
before(async () => {
  app = await startApp(); seedUsers(app.db);
  t = client(app.base); await t.login('teacher_a', 'Teach12345');
  t2 = client(app.base); await t2.login('teacher_b', 'Teach12345');
  await lessonToClassroom(t, 'res-xfer-00001');
  const r = await t.post('/api/runs', { module: 'classroom', exec_mode: 'demo', config: { max_turns: 20, seed: 'res', organization: 'group', class_size: 24 } });
  runId = r.data.run_id;
  await t.post(`/api/runs/${runId}/start`);
  for (let i = 0; i < 10; i++) await t.post(`/api/runs/${runId}/step`);
  await t.post(`/api/runs/${runId}/composer`, { open: true });
  await t.post(`/api/runs/${runId}/human`, { text: '=HYPERLINK("x") 我认为需要"更多"数据，\n换行测试', human_role: 'student', composer_opened_at: new Date(Date.now() - 2000).toISOString() });
  for (let i = 0; i < 8; i++) await t.post(`/api/runs/${runId}/step`);
  await t.post(`/api/runs/${runId}/finish`);
});
after(async () => { await app.stop(); });

test('V23 七维人工评分：空值与0不同，修订链与评价者保留；量规导入校验/预览/新版本', async () => {
  const rub = (await t.get('/api/rubrics')).data.rubrics.find((r) => r.builtin);
  assert.equal(rub.body.dimensions.length, 7);
  const ev = (await t.get(`/api/runs/${runId}`)).data.events.find((e) => /^S/.test(e.actor_id));
  const r1 = await t.post('/api/ratings', { target_type: 'event', target_id: ev.event_id, rubric_id: rub.rubric_id, rater_code: 'R甲', scores: { values_alignment: 0, evidence_use: 'insufficient_evidence', collaboration: 'not_applicable' }, note: '初评' });
  assert.equal(r1.status, 200);
  const s1 = JSON.parse(r1.data.scores);
  assert.equal(s1.values_alignment, 0); assert.equal(s1.question_quality, 'not_rated'); assert.equal(s1.evidence_use, 'insufficient_evidence');
  const r2 = await t.post('/api/ratings', { target_type: 'event', target_id: ev.event_id, rubric_id: rub.rubric_id, rater_code: 'R甲', scores: { values_alignment: 2 }, note: '重评' });
  assert.equal(r2.data.supersedes_rating_id, r1.data.rating_id);
  assert.equal((await t.post('/api/ratings', { target_type: 'event', target_id: ev.event_id, rubric_id: rub.rubric_id, rater_code: 'R甲', scores: { values_alignment: 5 } })).status, 400);
  assert.equal((await t2.post('/api/ratings', { target_type: 'event', target_id: ev.event_id, rubric_id: rub.rubric_id, rater_code: 'X', scores: {} })).status, 404, '不能评价他人事件');
  const custom = { key: 'mini_rubric', name: '简版量规', scale: [0, 2], dimensions: [{ key: 'clarity', label: '清晰', anchors: ['不清', '基本清楚', '清楚'] }] };
  assert.equal((await t.post('/api/rubrics/preview', { ...custom, dimensions: [{ key: 'clarity', label: '清晰', anchors: ['a'] }] })).status, 400);
  const pv = await t.post('/api/rubrics/preview', custom);
  assert.equal(pv.data.preview.version, 1);
  const i1 = await t.post('/api/rubrics', custom); const i2 = await t.post('/api/rubrics', custom);
  assert.equal(i2.data.version, 2);
  const hist = (await t.get('/api/ratings')).data.ratings;
  assert.ok(hist.find((x) => x.rating_id === r1.data.rating_id), '历史评分不被改变');
  void i1;
});

test('V24/V25 筛选导出 ZIP：范围一致、引用完整、中文与公式防护、SHA-256 匹配、来源与时间口径', async () => {
  const pv = await t.post('/api/export/preview', { module: 'classroom' });
  assert.ok(pv.data.tables.find((x) => x.name === 'events.csv').rows > 0);
  const res = await t.post('/api/export/zip', { module: 'classroom', package: 'full', include_event_text: true, include_rating_notes: true });
  assert.equal(res.status, 200);
  const files = unzip(res.data);
  for (const n of ['dataset.json', 'runs.csv', 'events.csv', 'participants.csv', 'scheduler_decisions.csv', 'interaction_edges.csv', 'timing_spans.csv', 'artifacts.csv', 'artifact_sections.csv', 'transfers.csv', 'ratings.csv', 'rubric.json', 'rubric.csv', 'metrics.csv', 'README.md', 'data-dictionary.md', 'manifest.json']) assert.ok(files[n], `缺少 ${n}`);
  const manifest = JSON.parse(files['manifest.json']);
  for (const f of manifest.files) assert.equal(createHash('sha256').update(files[f.name]).digest('hex'), f.sha256, `${f.name} 哈希`);
  const events = files['events.csv'].toString('utf8');
  assert.ok(events.startsWith('﻿'));
  assert.ok(events.includes(`"'=HYPERLINK(""x"") 我认为需要""更多""数据，\n换行测试"`), 'CSV 公式防护、引号转义与换行');
  const ds = JSON.parse(files['dataset.json']);
  const runs = ds.tables.runs; assert.ok(runs.every((r) => r.module === 'classroom'));
  const evIds = new Set(ds.tables.events.map((e) => e.event_id));
  assert.ok(ds.tables.events.every((e) => !e.reply_to || evIds.has(e.reply_to)), 'reply_to 外键完整');
  assert.ok(ds.tables.events.every((e) => runs.some((r) => r.run_id === e.run_id)));
  const dec = new Set(ds.tables.scheduler_decisions.map((d) => d.decision_id));
  assert.ok(ds.tables.events.every((e) => !e.decision_id || dec.has(e.decision_id)));
  const human = ds.tables.events.find((e) => e.actor_type === 'human');
  assert.match(human.actor_code, /^H\d{3}$/, '真人假名化');
  assert.ok(ds.tables.participants.some((p) => p.actor_code === human.actor_code && p.is_real_person === true), 'actor 映射一致');
  assert.ok(ds.tables.events.every((e) => e.is_real_classroom_evidence === false));
  assert.ok(ds.tables.events.filter((e) => e.source === 'demo').every((e) => e.data_provenance === 'synthetic_script'));
  assert.ok(ds.tables.timing_spans.some((s) => s.span_type === 'composer_dwell' && s.duration_ms >= 1000));
  assert.ok(ds.tables.metrics.every((m) => m.is_real_student_learning_time === false));
  const ratings = ds.tables.ratings; assert.ok(ratings.every((r) => /^R\d{3}$/.test(r.rater_code)));
  assert.ok(ratings.some((r) => r.score_status === 'not_rated' && r.score === ''), '未评不是0');
  const readme = files['README.md'].toString('utf8');
  assert.match(readme, /不是人类样本量/); assert.match(readme, /未测量/);
  const all = Buffer.concat(Object.values(files)).toString('utf8');
  assert.ok(!/teacher_a(?![a-z_])/.test(all) && !all.includes('Teach12345'), '不含登录名与凭据');
  // shared package (default): no free text
  const shared = unzip((await t.post('/api/export/zip', {})).data);
  assert.ok(!shared['events.csv'].toString('utf8').includes('我认为需要'));
  // empty-table handling
  const empty = unzip((await t2.post('/api/export/zip', {})).data);
  assert.match(empty['README.md'].toString('utf8'), /events\.csv：0 条/);
  // timing fields never back-filled
  const r0 = ds.tables.runs[0]; assert.ok(r0.started_at && r0.ended_at && r0.wall_duration_ms >= r0.active_session_ms);
});

test('V27 旧版本地数据迁移与坏备份恢复：不丢数据、不跨账号、失败不部分覆盖', async () => {
  const legacyPath = new URL('../legacy/v2-prototype/core.js', import.meta.url);
  assert.ok(existsSync(legacyPath));
  // Build a legacy study with the original v2 core (loaded as CommonJS text).
  const src = readFileSync(legacyPath, 'utf8');
  const mod = { exports: {} }; new Function('module', 'globalThis', src)(mod, globalThis);
  const L = mod.exports;
  const s = L.create();
  const a = L.artifact(s, { scene: 'seminar', title: '旧方案', content: '旧版正文内容' });
  const r = L.start(s, 'seminar', a.artifact_id);
  L.demo(s, r.run_id); L.event(s, r.run_id, { source: 'human_input', kind: 'question', text: '旧版真人提问' });
  L.finish(s, r.run_id);
  L.rate(s, { event_id: s.events[0].event_id, rater_code: 'R1', verdict: 'supported', score: 3, rubric_scores: { evidence_use: 2 } });
  const pv = await t2.post('/api/restore/preview', { data: s });
  assert.equal(pv.data.ok, true); assert.equal(pv.data.format, 'legacy_v2_local');
  assert.equal((await t2.post('/api/restore', { data: s })).status, 400, '须确认归属');
  const done = await t2.post('/api/restore', { data: s, confirm_ownership: true });
  assert.equal(done.status, 200); assert.ok(done.data.inserted >= 5);
  const again = await t2.post('/api/restore', { data: s, confirm_ownership: true });
  assert.equal(again.data.inserted, 0, '重复迁移不重复导入');
  const arts = (await t2.get('/api/artifacts')).data.artifacts;
  assert.ok(arts.some((x) => x.title === '旧方案' && x.type === 'legacy_plan'));
  // teacher_a cannot take teacher_b's migrated records
  const steal = await t.post('/api/restore/preview', { data: s });
  assert.equal(steal.data.conflicts, 1);
  const b = await t2.get('/api/backup');
  const bak = b.data;
  const cross = await t.post('/api/restore/preview', { data: bak });
  assert.equal(cross.data.ok, false); assert.match(cross.data.errors.join(''), /属于其他账号/);
  // corrupted backup: broken reference → nothing is written
  const bad = JSON.parse(JSON.stringify(bak));
  bad.data.events.push({ ...bad.data.events[0], event_id: 'ev_broken', reply_to: 'ev_missing' });
  bad.data.artifacts = bad.data.artifacts.map((x) => ({ ...x, artifact_id: x.artifact_id + '_copy' }));
  const n0 = app.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n;
  const res = await t.post('/api/restore', { data: bad, confirm_ownership: true });
  assert.equal(res.status, 400);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM artifacts').get().n, n0, '失败不部分覆盖');
  // own backup round-trip: restoring is idempotent
  const own = (await t.get('/api/backup')).data;
  const rr = await t.post('/api/restore', { data: own, confirm_ownership: true });
  assert.equal(rr.data.inserted, 0);
});

test('回归：备份恢复不接受伪造列名（SQL 标识符注入防护）', async () => {
  // A backup is user-supplied JSON. Row keys become INSERT column names, so a
  // crafted key must never reach SQL text. We assert:
  //   1. the restore succeeds (unknown columns are dropped, not fatal),
  //   2. the legitimate columns in the same row still land,
  //   3. the schema and the other tables are untouched,
  //   4. a row missing a NOT NULL column yields a clear 400, not a 500.
  const backup = (await t.get('/api/backup')).data;
  const payload = JSON.parse(JSON.stringify(backup)); // { format, schema_version, data: {...} }
  const now = new Date().toISOString();

  const hostile = {
    artifact_id: 'art_hostile_0001',
    owner_id: 'someone_else',
    lineage_id: 'lin_hostile_0001',
    module: 'seminar',
    type: 'legacy_plan',
    title: '注入回归样本',
    body: JSON.stringify({ course: {}, sections: [] }),
    status: 'saved',
    version: 1,
    origin: 'manual',
    reviewed_by_teacher: 0,
    created_at: now,
    updated_at: now,
    saved_at: now,
    // the attack: keys that would close the column list and append their own clause
    'x") VALUES(1); DROP TABLE users;--': 'boom',
    'body) VALUES(1);--': 'boom2',
    unknown_future_column: 'v',
  };
  payload.data.artifacts.push(hostile);

  const res = await t.post('/api/restore', { data: payload, confirm_ownership: true });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(res.data.dropped_columns.includes('artifacts.x") VALUES(1); DROP TABLE users;--'), '伪列名被记录为已丢弃');
  assert.ok(res.data.dropped_columns.includes('artifacts.unknown_future_column'), '未知列被记录');

  // the row landed with its real columns
  const rows = app.db.prepare("SELECT * FROM artifacts WHERE artifact_id=?").all('art_hostile_0001');
  assert.equal(rows.length, 1, '合法列仍然写入');
  assert.equal(rows[0].title, '注入回归样本');
  assert.ok(rows[0].owner_id, 'owner 被强制归属当前账号');

  // the schema is intact — users table still exists
  const users = app.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='users'").get();
  assert.equal(users.n, 1, 'users 表未被删除');

  // and no column named after the fragment exists on any table
  const cols = app.db.prepare('PRAGMA table_info(artifacts)').all().map((c) => c.name);
  assert.ok(!cols.some((c) => c.includes('DROP')), '未注入新列');
  assert.ok(!cols.includes('unknown_future_column'), '未知列被丢弃');

  // an incomplete row is rejected with a helpful message rather than a 500
  const broken = JSON.parse(JSON.stringify(backup));
  broken.data.artifacts.push({ artifact_id: 'art_incomplete_0001', owner_id: 'x', module: 'seminar', type: 'legacy_plan', title: 't', body: '{}', status: 'saved', version: 1, created_at: now, updated_at: now });
  const bad = await t.post('/api/restore', { data: broken, confirm_ownership: true });
  assert.equal(bad.status, 400, '缺字段应返回 400 而不是 500');
  assert.match(bad.data.error.message, /缺少必要字段/);
  assert.equal(app.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE artifact_id=?").get('art_incomplete_0001').n, 0, '失败不写入半条记录');
});
