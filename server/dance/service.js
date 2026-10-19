import { readFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { one, all, run, tx, id, now, check, json, audit } from '../db.js';
import { computeMetrics } from '../../public/dance/metrics.js';
import { analyzeTraining, ROLES } from './analysis.js';

import { ACTIONS } from '../../public/dance/curriculum.js';
export { ACTIONS };

export function ensureDance(db) {
  db.exec('CREATE TABLE IF NOT EXISTS dance_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  if (!one(db, 'SELECT 1 FROM dance_migrations WHERE version=1')) tx(db, () => {
    db.exec(readFileSync(new URL('./migrations/001.sql', import.meta.url), 'utf8'));
    run(db, 'INSERT INTO dance_migrations(version,applied_at) VALUES(1,?)', now());
  });
  if (!one(db, 'SELECT 1 FROM dance_migrations WHERE version=2')) tx(db, () => {
    db.exec(readFileSync(new URL('./migrations/002.sql', import.meta.url), 'utf8'));
    run(db, 'INSERT INTO dance_migrations(version,applied_at) VALUES(2,?)', now());
  });
  if (!one(db, 'SELECT 1 FROM dance_migrations WHERE version=3')) tx(db, () => {
    db.exec(readFileSync(new URL('./migrations/003.sql', import.meta.url), 'utf8'));
    run(db, 'INSERT INTO dance_migrations(version,applied_at) VALUES(3,?)', now());
  });
  run(db, "UPDATE dance_training SET status='WAITING_REVIEW', analysis_json=?, updated_at=? WHERE status='AI_PROCESSING'", JSON.stringify({ mode: 'interrupted', message: '服务重启中断 AI 分析；已保留指标，可重新分析或请教师复核', agents: [], selected: [] }), now());
}

export function addProfile(db, userId, role, cohort) {
  check(['student','teacher','medic'].includes(role), 400, 'bad_role', '身份无效');
  check(typeof cohort === 'string' && cohort.length >= 1 && cohort.length <= 80, 400, 'bad_cohort', '班级无效');
  run(db, 'INSERT INTO dance_profiles(user_id,role,cohort,created_at) VALUES(?,?,?,?)', userId, role, cohort, now());
}

function text(value, max, label) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 400, 'invalid_input', `${label}不能为空且不能超过 ${max} 字`);
  return value.trim();
}
function key(value) { return text(value, 100, '请求标识'); }
function list(value, max, label) {
  check(Array.isArray(value) && value.length <= max, 400, 'invalid_input', `${label}最多 ${max} 条`);
  return value.map((item) => text(item, 500, label));
}
function date(value) {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value, 400, 'invalid_date', '日期无效');
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0,10);
  check(value <= today, 400, 'future_date', '不能填写未来日期');
  return value;
}
function number(value, min, max, label, integer = false) {
  check(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)), 400, 'invalid_input', `${label}范围为 ${min}–${max}`);
  return value;
}

export function createDanceService(db, dataDir) {
  ensureDance(db);
  const mediaDir = join(dataDir, 'dance-media');
  mkdirSync(mediaDir, { recursive: true });
  const pending = new Map();
  const me = (user) => {
    const profile = one(db, 'SELECT * FROM dance_profiles WHERE user_id=?', user.user_id);
    check(profile, 403, 'no_dance_access', user.is_admin ? '管理员请从 /admin 进入管理后台；教师和学生从 /wujing 登录。' : '该账号尚未开通舞蹈身份。请联系管理员在 /admin 的账号管理中设置身份和班级，然后返回 /wujing 登录。');
    return { user_id: user.user_id, name: user.display_name, pseudonym: user.pseudonym, must_change_password: !!user.must_change_password, ...profile };
  };
  const requireRole = (user, roles) => { const profile = me(user); check(roles.includes(profile.role), 403, 'forbidden', '当前身份不能执行此操作'); return profile; };
  const owned = (user, trainingId) => {
    const profile = me(user), training = one(db, 'SELECT * FROM dance_training WHERE training_id=?', trainingId);
    check(training && training.cohort === profile.cohort && (training.student_id === user.user_id || profile.role === 'teacher'), 404, 'not_found', '练习不存在或无权访问');
    return training;
  };
  const publicStandard = (standard) => {
    if (!standard) return null;
    const { checkpoints, reference_metrics_json, reference_keyframes_json, ...fields } = standard;
    return { ...fields, archived_action: !ACTIONS.some(action => action.key === fields.action_key), checkpoints: json(checkpoints, []), reference_metrics: json(reference_metrics_json), reference_frame_count: json(reference_keyframes_json, []).length };
  };
  const removeVideo = (training) => {
    if (training.video_path) {
      const file = join(mediaDir, training.video_path);
      if (existsSync(file)) unlinkSync(file);
    }
  };
  const pruneVideos = () => {
    for (const training of all(db, 'SELECT * FROM dance_training WHERE video_expires_at IS NOT NULL AND video_expires_at<=?', now())) {
      removeVideo(training);
      run(db, 'UPDATE dance_training SET video_path=NULL, video_type=NULL, video_expires_at=NULL WHERE training_id=?', training.training_id);
    }
  };
  pruneVideos();
  const retentionTimer = setInterval(() => { try { pruneVideos(); } catch { console.error('Dance media retention will retry on the next interval'); } }, 60000);
  retentionTimer.unref();
  const view = (user, trainingId) => {
    const training = owned(user, trainingId), profile = me(user);
    const standard = one(db, 'SELECT * FROM dance_standards WHERE standard_id=?', training.standard_id);
    const feedback = all(db, 'SELECT * FROM dance_feedback WHERE training_id=? ORDER BY version DESC', trainingId).map((row) => ({ ...row, strengths: json(row.strengths, []), priorities: json(row.priorities, []) }));
    let analysis = json(training.analysis_json);
    if (profile.role !== 'teacher' && analysis) analysis = { mode: analysis.mode, message: analysis.message, agents: (analysis.agents || []).map((agent) => ({ id: agent.id, label: agent.label, status: agent.status })) };
    return {
      training_id: training.training_id, student_id: training.student_id, student_code: one(db, 'SELECT pseudonym FROM users WHERE user_id=?', training.student_id).pseudonym,
      status: training.status, created_at: training.created_at, updated_at: training.updated_at,
      consent_cloud: !!training.consent_cloud, consent_video: !!training.consent_video,
      standard: publicStandard(standard), metrics: json(training.metrics_json), analysis,
      feedback, video_url: training.video_path && training.video_expires_at > now() && training.consent_video ? `/api/dance/sessions/${trainingId}/video` : null,
      video_expires_at: training.video_expires_at,
    };
  };
  const service = {
    me,
    catalog(user) {
      const profile = me(user);
      const standards = all(db, 'SELECT * FROM dance_standards WHERE cohort=? ORDER BY version DESC', profile.cohort);
      const savedQwen = one(db, "SELECT provider_id FROM model_configs WHERE enabled=1 AND name LIKE '千问视觉%' ORDER BY updated_at DESC LIMIT 1");
      return { actions: ACTIONS.map((action) => { const standard = standards.find((item) => item.action_key === action.key); return { ...action, standard: publicStandard(standard) }; }), roles: ROLES.map(({ id: roleId, label }) => ({ id: roleId, label })), vision_configured: !!(process.env.DANCE_VISION_PROVIDER_ID || savedQwen?.provider_id) };
    },
    publishStandard(user, input) {
      const profile = requireRole(user, ['teacher']);
      check(ACTIONS.some((action) => action.key === input.action_key), 400, 'bad_action', '未知动作');
      check(['front','side'].includes(input.view), 400, 'bad_view', '视角无效');
      const title = text(input.title, 80, '动作名称'), instructions = text(input.instructions, 2000, '教学要求');
      const checkpoints = list(input.checkpoints, 6, '检查点');
      check(checkpoints.length > 0 && input.confirm === true, 400, 'confirm_required', '请填写检查点并确认发布');
      let referenceMetrics = null;
      const referenceKeyframes = input.reference_keyframes ?? [];
      check(Array.isArray(referenceKeyframes) && referenceKeyframes.length <= 3, 400, 'bad_reference', '最多保存 3 张教师示范关键帧');
      for (const frame of referenceKeyframes) {
        check(frame && typeof frame.data === 'string' && frame.data.length <= 300000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.data) && typeof frame.time === 'number' && Number.isFinite(frame.time) && frame.time >= 0 && frame.time <= 90, 400, 'bad_reference', '教师示范关键帧格式无效');
        check(Buffer.from(frame.data.split(',')[1], 'base64').subarray(0, 3).toString('hex') === 'ffd8ff', 400, 'bad_reference', '教师示范关键帧不是 JPEG');
      }
      if (input.reference_pose != null) {
        check(input.reference_pose && input.reference_pose.view === input.view, 400, 'wrong_view', '示范视频视角必须与动作标准一致');
        check(Array.isArray(input.reference_pose.frames) && input.reference_pose.frames.length <= 450, 400, 'bad_reference', '示范视频最多提取 450 帧');
        try { referenceMetrics = computeMetrics(input.reference_pose); } catch (error) { check(false, 400, 'bad_reference', error.message); }
        check(referenceMetrics.reliable, 400, 'bad_reference_quality', '示范视频姿态质量不足，请调整机位或重新录制');
      }
      return tx(db, () => {
        const version = (one(db, 'SELECT MAX(version) version FROM dance_standards WHERE cohort=? AND action_key=?', profile.cohort, input.action_key).version || 0) + 1;
        const standardId = id('std');
        const previous = one(db, 'SELECT view,reference_metrics_json,reference_keyframes_json FROM dance_standards WHERE cohort=? AND action_key=? ORDER BY version DESC LIMIT 1', profile.cohort, input.action_key);
        const savedReference = referenceMetrics ? JSON.stringify(referenceMetrics) : previous?.view === input.view ? previous.reference_metrics_json : null;
        const savedFrames = referenceKeyframes.length ? JSON.stringify(referenceKeyframes) : previous?.view === input.view ? previous.reference_keyframes_json : null;
        run(db, `INSERT INTO dance_standards(standard_id,action_key,version,cohort,teacher_id,title,view,instructions,checkpoints,created_at,reference_metrics_json,reference_keyframes_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, standardId, input.action_key, version, profile.cohort, user.user_id, title, input.view, instructions, JSON.stringify(checkpoints), now(), savedReference, savedFrames);
        audit(db, { actor: user, action: 'dance_standard_published', target_type: 'dance_standard', target_id: standardId, detail: { version, reference_attached: !!savedReference, reference_replaced: !!referenceMetrics } });
        return { standard_id: standardId, version, reference_metrics: savedReference ? JSON.parse(savedReference) : null };
      });
    },
    createTraining(user, input) {
      const profile = requireRole(user, ['student']);
      check(input.consent_teaching === true, 400, 'consent_required', '需要同意将姿态指标用于本次教学反馈');
      const requestKey = key(input.idempotency_key);
      const existing = one(db, 'SELECT * FROM dance_training WHERE student_id=? AND idempotency_key=?', user.user_id, requestKey);
      if (existing) {
        check(existing.standard_id === input.standard_id && existing.consent_cloud === Number(input.consent_cloud === true) && existing.consent_video === Number(input.consent_video === true), 409, 'idempotency_conflict', '该请求标识已用于不同内容');
        return view(user, existing.training_id);
      }
      const standard = one(db, 'SELECT * FROM dance_standards WHERE standard_id=? AND cohort=?', input.standard_id, profile.cohort);
      check(standard, 404, 'no_standard', '请等待老师发布动作标准');
      check(ACTIONS.some(action => action.key === standard.action_key), 400, 'archived_action', '这是历史动作标准，保留查看与复核；新练习请使用教师重新发布的古典芭蕾标准。');
      const trainingId = id('train');
      run(db, `INSERT INTO dance_training(training_id,student_id,cohort,standard_id,status,idempotency_key,consent_teaching,consent_cloud,consent_video,created_at,updated_at) VALUES(?,?,?,?,'POSE_PENDING',?,1,?,?,?,?)`, trainingId, user.user_id, profile.cohort, standard.standard_id, requestKey, Number(input.consent_cloud === true), Number(input.consent_video === true), now(), now());
      return view(user, trainingId);
    },
    sessions(user) {
      const profile = me(user);
      check(profile.role !== 'medic', 403, 'forbidden', '风险教师请使用健康记录页面');
      const sessions = profile.role === 'teacher' ? all(db, 'SELECT training_id FROM dance_training WHERE cohort=? ORDER BY created_at DESC LIMIT 100', profile.cohort) : all(db, 'SELECT training_id FROM dance_training WHERE student_id=? ORDER BY created_at DESC LIMIT 100', user.user_id);
      return sessions.map((session) => view(user, session.training_id));
    },
    view,
    pose(user, trainingId, input) {
      requireRole(user, ['student']);
      const training = owned(user, trainingId);
      check(training.student_id === user.user_id && ['POSE_PENDING','NEEDS_RECAPTURE'].includes(training.status), 409, 'invalid_state', '当前练习不能覆盖姿态数据');
      const standard = one(db, 'SELECT * FROM dance_standards WHERE standard_id=?', training.standard_id);
      check(input.view === standard.view, 400, 'wrong_view', '拍摄视角必须与动作标准一致');
      let metrics;
      try { metrics = computeMetrics(input); } catch (error) { check(false, 400, 'bad_pose', error.message); }
      const status = metrics.reliable ? 'METRICS_READY' : 'NEEDS_RECAPTURE';
      run(db, 'UPDATE dance_training SET pose_json=?, metrics_json=?, status=?, updated_at=? WHERE training_id=?', JSON.stringify(input), JSON.stringify(metrics), status, now(), trainingId);
      return view(user, trainingId);
    },
    analyze(user, trainingId, input) {
      requireRole(user, ['student']);
      const training = owned(user, trainingId);
      if (pending.has(trainingId) || ['WAITING_REVIEW','PUBLISHED'].includes(training.status)) return view(user, trainingId);
      check(training.status === 'METRICS_READY', 409, 'invalid_state', '先完成有效姿态提取');
      const keyframes = input.keyframes || [];
      check(Array.isArray(keyframes) && keyframes.length <= 6, 400, 'bad_frames', '最多 6 张关键帧');
      check(!keyframes.length || training.consent_cloud, 403, 'consent_required', '未授权向云端发送关键帧');
      for (const frame of keyframes) {
        check(frame && typeof frame.data === 'string' && frame.data.length <= 500000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.data) && typeof frame.time === 'number' && Number.isFinite(frame.time) && frame.time >= 0 && frame.time <= 90, 400, 'bad_frame', '关键帧格式或大小无效');
        check(Buffer.from(frame.data.split(',')[1], 'base64').subarray(0,3).toString('hex') === 'ffd8ff', 400, 'bad_frame', '关键帧内容不是 JPEG');
      }
      check(pending.size < 2, 429, 'busy', '分析队列繁忙，请稍后重试');
      const controller = new AbortController();
      run(db, 'UPDATE dance_training SET status=?, updated_at=? WHERE training_id=?', 'AI_PROCESSING', now(), trainingId);
      const entry = { controller, promise: null };
      pending.set(trainingId, entry);
      entry.promise = (async () => {
        try {
          const analysis = await analyzeTraining(db, { standard: one(db, 'SELECT * FROM dance_standards WHERE standard_id=?', training.standard_id), metrics: json(training.metrics_json), keyframes, consentCloud: !!training.consent_cloud, signal: controller.signal });
          if (!controller.signal.aborted) run(db, "UPDATE dance_training SET analysis_json=?, status='WAITING_REVIEW', updated_at=? WHERE training_id=? AND status='AI_PROCESSING'", JSON.stringify(analysis), now(), trainingId);
        } catch {
          if (!controller.signal.aborted) run(db, "UPDATE dance_training SET status='WAITING_REVIEW', analysis_json=?, updated_at=? WHERE training_id=? AND status='AI_PROCESSING'", JSON.stringify({ mode: 'metrics_only', message: 'AI 不可用，指标已保留，请教师复核', agents: [] }), now(), trainingId);
        } finally { pending.delete(trainingId); }
      })();
      return view(user, trainingId);
    },
    uploadVideo(user, trainingId, input) {
      requireRole(user, ['student']);
      const training = owned(user, trainingId);
      check(training.consent_video && training.status !== 'WITHDRAWN', 403, 'consent_required', '未授权保存原视频');
      check(['video/mp4','video/webm','video/quicktime'].includes(input.type), 400, 'bad_video', '仅支持 MP4、WebM 或 MOV');
      const bytes = input.bytes;
      check(Buffer.isBuffer(bytes) && bytes.length >= 16 && bytes.length <= 100 * 1024 * 1024, 400, 'bad_video', '视频上限为 100MB');
      const isWebm = bytes.subarray(0,4).toString('hex') === '1a45dfa3';
      const isMp4 = bytes.subarray(4,8).toString() === 'ftyp';
      check(input.type === 'video/webm' ? isWebm : isMp4, 400, 'bad_video', '文件内容与视频格式不匹配');
      const filename = `${trainingId}.video`;
      writeFileSync(join(mediaDir, filename), bytes);
      run(db, 'UPDATE dance_training SET video_path=?,video_type=?,video_expires_at=?,updated_at=? WHERE training_id=?', filename, input.type, new Date(Date.now() + 30 * 86400000).toISOString(), now(), trainingId);
      return view(user, trainingId);
    },
    video(user, trainingId) {
      const training = owned(user, trainingId);
      check(training.status !== 'WITHDRAWN' && training.consent_video && training.video_path && training.video_expires_at > now(), 404, 'not_found', '视频未保存或已过期');
      check(existsSync(join(mediaDir, training.video_path)), 404, 'not_found', '视频不存在');
      return { bytes: readFileSync(join(mediaDir, training.video_path)), type: training.video_type };
    },
    review(user, trainingId, input) {
      requireRole(user, ['teacher']);
      const training = owned(user, trainingId);
      check(['WAITING_REVIEW','PUBLISHED'].includes(training.status), 409, 'invalid_state', '练习尚不能发布');
      const strengths = list(input.strengths || [], 2, '优点'), priorities = list(input.priorities || [], 3, '改进项');
      const drill = text(input.next_drill, 1000, '下一轮提示');
      check(['adopt','modify','reject'].includes(input.decision), 400, 'bad_decision', '请选择复核结论');
      return tx(db, () => {
        const current = one(db, 'SELECT MAX(version) version FROM dance_feedback WHERE training_id=?', trainingId).version || 0;
        check(input.expected_version === current, 409, 'version_conflict', '反馈已被更新，请刷新后再提交');
        run(db, 'INSERT INTO dance_feedback VALUES(?,?,?,?,?,?,?,?,?)', id('feedback'), trainingId, current + 1, user.user_id, input.decision, JSON.stringify(strengths), JSON.stringify(priorities), drill, now());
        run(db, "UPDATE dance_training SET status='PUBLISHED',updated_at=? WHERE training_id=?", now(), trainingId);
        audit(db, { actor: user, action: 'dance_feedback_published', target_type: 'training', target_id: trainingId, detail: { version: current + 1, decision: input.decision } });
        return view(user, trainingId);
      });
    },
    withdraw(user, trainingId) {
      requireRole(user, ['student']);
      const training = owned(user, trainingId);
      pending.get(trainingId)?.controller.abort();
      removeVideo(training);
      tx(db, () => {
        run(db, 'DELETE FROM dance_feedback WHERE training_id=?', trainingId);
        run(db, "UPDATE dance_training SET status='WITHDRAWN',consent_teaching=0,consent_cloud=0,consent_video=0,pose_json=NULL,metrics_json=NULL,analysis_json=NULL,video_path=NULL,video_type=NULL,video_expires_at=NULL,updated_at=? WHERE training_id=?", now(), trainingId);
      });
      return { ok: true };
    },
    checkin(user, input) {
      const profile = requireRole(user, ['student']);
      check(input.consent_health === true, 400, 'consent_required', '请明确同意保存健康记录');
      const day = date(input.date), fatigue = number(input.fatigue,1,5,'疲劳程度',true), sleep = number(input.sleep_hours,0,24,'睡眠时长'), pain = number(input.pain,0,10,'疼痛程度',true);
      const areas = list(input.areas || [],8,'不适部位');
      run(db, 'INSERT INTO dance_health VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(student_id,date) DO UPDATE SET fatigue=excluded.fatigue,sleep_hours=excluded.sleep_hours,pain=excluded.pain,areas=excluded.areas', id('checkin'), user.user_id, profile.cohort, day, fatigue, sleep, pain, JSON.stringify(areas), now());
      return service.health(user);
    },
    load(user, input) {
      const profile = requireRole(user, ['student']);
      check(input.consent_health === true, 400, 'consent_required', '请明确同意保存训练负荷');
      const day = date(input.date), minutes = number(input.minutes,1,300,'训练分钟数',true), rpe = number(input.rpe,0,10,'主观强度',true), requestKey = key(input.idempotency_key);
      const previous = one(db, 'SELECT * FROM dance_loads WHERE student_id=? AND idempotency_key=?', user.user_id, requestKey);
      if (previous) check(previous.date === day && previous.minutes === minutes && previous.rpe === rpe, 409, 'idempotency_conflict', '该请求标识已用于其他负荷记录');
      else run(db, 'INSERT INTO dance_loads VALUES(?,?,?,?,?,?,?,?,?)', id('load'), user.user_id, profile.cohort, day, minutes, rpe, minutes * rpe, requestKey, now());
      return service.health(user);
    },
    health(user) {
      const profile = requireRole(user, ['student','medic']);
      const clause = profile.role === 'medic' ? 'cohort=?' : 'student_id=?';
      const value = profile.role === 'medic' ? profile.cohort : user.user_id;
      const withStudent = (item) => ({ ...item, student_code: one(db, 'SELECT pseudonym FROM users WHERE user_id=?', item.student_id).pseudonym });
      return { checkins: all(db, `SELECT * FROM dance_health WHERE ${clause} ORDER BY date DESC LIMIT 100`, value).map((item) => ({ ...withStudent(item), areas: json(item.areas) })), loads: all(db, `SELECT * FROM dance_loads WHERE ${clause} ORDER BY date DESC LIMIT 100`, value).map(withStudent), risk: { level: 'unassessed', message: '风险规则尚未由专业教师发布，目前只记录状态与负荷，不作安全评级。' } };
    },
    withdrawHealth(user) {
      requireRole(user, ['student']);
      tx(db, () => { run(db, 'DELETE FROM dance_health WHERE student_id=?', user.user_id); run(db, 'DELETE FROM dance_loads WHERE student_id=?', user.user_id); });
      return { ok: true };
    },
    async close() {
      clearInterval(retentionTimer);
      const running = [...pending.values()];
      running.forEach((entry) => entry.controller.abort());
      await Promise.allSettled(running.map((entry) => entry.promise));
    },
  };
  return service;
}
