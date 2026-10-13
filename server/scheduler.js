// Event-driven classroom scheduler. Pure and deterministic given (config, seed, profiles, prior events).
// It chooses WHO acts and HOW (no model calls); text is produced afterwards by the demo bank or a model.
// Default is autonomous weighted-random participation — never a roll-call over the roster.

export const DISTRIBUTION_VERSION = 'yz-sched-1.1-clock';

// ---- seeded PRNG (mulberry32, 32-bit serialisable state) ----
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (const ch of String(str)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
export function rngNext(state) {
  const s = (state.rng = (state.rng + 0x6d2b79f5) >>> 0);
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const makeRng = (seed) => { const st = { rng: hashSeed(seed) }; return () => rngNext(st); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round3 = (x) => Math.round(x * 1000) / 1000;

export const CONFIG_OPTIONS = {
  class_size: [24, 40, 120, 300],
  freedom: { low: { base: 0.35, spont: 0.1, label: '低' }, mid: { base: 0.6, spont: 0.25, label: '中' }, high: { base: 0.8, spont: 0.4, label: '高' } },
  atmosphere: { quiet: { mult: 0.7, label: '安静思考' }, balanced: { mult: 1, label: '均衡' }, active: { mult: 1.3, label: '活跃讨论' } },
  knowledge: { uniform: '均匀', normal: '集中（正态）', bimodal: '两极分化' },
  level: { low: 0.2, mid: 0.4, high: 0.6 },
  organization: { whole: '全班', group: '组内讨论', debate: '组间辩论' },
  guidance: { timely: { limit: 2, label: '适时介入' }, open: { limit: 5, label: '开放讨论' } },
};
export function normalizeConfig(c = {}) {
  const pick = (v, obj, d) => (Object.hasOwn(obj, v) ? v : d);
  const size = Number(c.class_size);
  return {
    class_size: Number.isInteger(size) && size >= 4 && size <= 300 ? size : 24,
    group_size: clamp(Number(c.group_size) || 6, 2, 12),
    freedom: pick(c.freedom, CONFIG_OPTIONS.freedom, 'mid'),
    atmosphere: pick(c.atmosphere, CONFIG_OPTIONS.atmosphere, 'balanced'),
    knowledge: pick(c.knowledge, CONFIG_OPTIONS.knowledge, 'normal'),
    skepticism: pick(c.skepticism, CONFIG_OPTIONS.level, 'mid'),
    cooperation: pick(c.cooperation, CONFIG_OPTIONS.level, 'mid'),
    organization: pick(c.organization, CONFIG_OPTIONS.organization, 'whole'),
    guidance: pick(c.guidance, CONFIG_OPTIONS.guidance, 'timely'),
    class_minutes: clamp(Number(c.class_minutes) || 45, 5, 240),
    max_turns: clamp(Number(c.max_turns) || Math.ceil((clamp(Number(c.class_minutes) || 45, 5, 240) * 60) / 15), 5, 400),
    max_minutes: clamp(Number(c.max_minutes) || 240, 1, 480),
    speed: [1, 2, 5, 10, 20, 60].includes(Number(c.speed)) ? Number(c.speed) : 10,
    seed: String(c.seed || '').slice(0, 64),
  };
}

const INTERESTS = ['原理', '案例', '伦理', '实践', '数据', '规范', '安全', '历史', '创新', '职业'];
const TOPIC_KEYWORDS = { 原理: /原理|概念|定义|公式|理论/, 案例: /案例|事故|情境|实例/, 伦理: /伦理|责任|价值|思政|公共|诚信/, 实践: /实践|实验|操作|任务|项目/,
  数据: /数据|检测|统计|指标|算法/, 规范: /规范|标准|规程|法规|制度/, 安全: /安全|风险|隐患|质量/, 历史: /历史|发展|演进/, 创新: /创新|设计|改进|优化/, 职业: /职业|岗位|工程师|行业/ };
export const topicTags = (text) => INTERESTS.filter((k) => TOPIC_KEYWORDS[k].test(String(text || '')));

/** Stable student profiles. Personality parameters are independent from avatars (separate RNG streams). */
import { studentIdentity } from './agents.js';

/** overrides：来自班级画像的逐人参数（按座位顺序），只覆盖给出的字段；随机抽样过程不变，保证可复现。 */
export function makeStudents(config, seed, overrides = null) {
  const r = makeRng(`${seed}:profiles`), av = makeRng(`${seed}:avatars`);
  const skMean = CONFIG_OPTIONS.level[config.skepticism], coMean = CONFIG_OPTIONS.level[config.cooperation];
  const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += r(); return u / 4; };
  const knowledge = () => config.knowledge === 'uniform' ? r() : config.knowledge === 'bimodal' ? clamp((r() < 0.5 ? 0.25 : 0.75) + (r() - 0.5) * 0.3, 0, 1) : clamp(gauss(), 0, 1);
  const out = [];
  for (let i = 0; i < config.class_size; i++) {
    const interests = []; while (interests.length < 2) { const t = INTERESTS[Math.floor(r() * INTERESTS.length)]; if (!interests.includes(t)) interests.push(t); }
    const prior = round3(knowledge());
    const who = studentIdentity(i), ov = overrides?.[i];
    out.push({ agent_id: `S${String(i + 1).padStart(3, '0')}`, name: who.name, gender: ov?.gender || who.gender, profile_code: ov?.code || null, group_id: `G${Math.floor(i / config.group_size) + 1}`,
      seat: i, avatar: Math.floor(av() * 60),
      traits: { prior_knowledge: prior, interests, expressiveness: round3(clamp(0.15 + r() * 0.8, 0, 1)), skepticism: round3(clamp(skMean + (r() - 0.5) * 0.5, 0, 1)),
        cooperation: round3(clamp(coMean + (r() - 0.5) * 0.5, 0, 1)), simulated_mastery: prior } });
    if (ov?.traits) { const t = out.at(-1).traits; for (const [k, v] of Object.entries(ov.traits)) if (v != null) t[k] = typeof v === 'number' ? round3(clamp(v, 0, 1)) : v; t.simulated_mastery = t.prior_knowledge; t.gender = out.at(-1).gender; if (ov.code) t.profile_code = ov.code; } else out.at(-1).traits.gender = out.at(-1).gender;
  }
  return out;
}

export function initState(config, seed) {
  return { rng: hashSeed(`${seed}:sched`), turn: 0, stage_idx: 0, stage_turn: 0, stage_intro: false, pending: [], last_spoke: {}, count: {}, last_actor: null, consec: 0,
    student_since_teacher: 0, last: null, phase: 'teach', group_cursor: 0, groups_this_round: [], group_turns: 0, debate_side: 0, deferred: [], done: false };
}

const COOLDOWN = 3, MAX_CONSEC = 2, MAX_PENDING = 3;

function eligible(state, students, filter) {
  return students.filter((s) => {
    if (filter && !filter(s)) return false;
    const last = state.last_spoke[s.agent_id];
    if (last != null && state.turn - last < COOLDOWN) return false;
    if (state.last_actor === s.agent_id && state.consec >= MAX_CONSEC) return false;
    if (state.pending.some((p) => p.agent_id === s.agent_id)) return false;
    return true;
  });
}

function weightOf(s, trigger, tags) {
  const t = s.traits;
  const rel = tags.length ? (t.interests.some((i) => tags.includes(i)) ? 1 : 0.55) : 0.75;
  const recency = 1 / (1 + 0.45 * (s._count || 0));
  const trig = trigger === 'teacher_question' ? 0.6 + t.expressiveness : trigger === 'peer_statement' ? 0.3 + (t.skepticism + t.cooperation) / 2 : 0.3 + t.expressiveness * 0.8;
  return rel * trig * recency;
}

function sampleAction(rand, s, trigger) {
  const t = s.traits;
  const table = trigger === 'teacher_question'
    ? [['answer_teacher', 0.55], ['clarify', 0.2 * (1 - t.prior_knowledge)], ['ask', 0.1], ['challenge', 0.2 * t.skepticism], ['reflect', 0.08]]
    : trigger === 'peer_statement'
      ? [['supplement', 0.4 * t.cooperation], ['challenge', 0.45 * t.skepticism], ['answer_peer', 0.2], ['ask', 0.1]]
      : [['ask', 0.35], ['clarify', 0.3 * (1 - t.prior_knowledge)], ['reflect', 0.15], ['challenge', 0.15 * t.skepticism], ['supplement', 0.1 * t.cooperation]];
  const total = table.reduce((a, [, w]) => a + w, 0);
  let u = rand() * total;
  for (const [a, w] of table) { if ((u -= w) <= 0) return a; }
  return table[0][0];
}

function weightedSampleWithoutReplacement(rand, items, weights, k) {
  const pool = items.map((x, i) => ({ x, w: weights[i] })), out = [];
  while (out.length < k && pool.length) {
    const total = pool.reduce((a, p) => a + p.w, 0);
    let u = rand() * total, j = 0;
    for (; j < pool.length - 1; j++) { if ((u -= pool[j].w) <= 0) break; }
    out.push(pool[j].x); pool.splice(j, 1);
  }
  return out;
}

/**
 * Participation opportunity: decide whether anyone speaks, who raises hands (≤3 intents), and their actions.
 * Returns { decision, intents }.
 */
function opportunity(state, students, config, stage, trigger, triggerEvent, filter) {
  const rand = () => rngNext(state);
  const tags = topicTags(`${stage?.topic || ''} ${stage?.teacher_text || ''} ${stage?.question || ''}`);
  const f = CONFIG_OPTIONS.freedom[config.freedom], atm = CONFIG_OPTIONS.atmosphere[config.atmosphere].mult;
  for (const s of students) s._count = state.count[s.agent_id] || 0;
  const pool = eligible(state, students, filter);
  const weights = pool.map((s) => weightOf(s, trigger, tags));
  const trigFactor = trigger === 'teacher_question' ? 1.15 : trigger === 'peer_statement' ? 0.75 : 0.55 + f.spont;
  const p = clamp(f.base * atm * trigFactor, 0.05, 0.95);
  const draw = rand();
  const top = pool.map((s, i) => [s.agent_id, round3(weights[i])]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const decision = { trigger, trigger_event_id: triggerEvent?.event_id || null, n_candidates: students.length, n_eligible: pool.length,
    speak_probability: round3(p), draw: round3(draw), hands: [], selected_agent: null, action: null, target_actor: null, target_event_id: null,
    group_id: null, cooldown: COOLDOWN, top_weights: top, distribution_version: DISTRIBUTION_VERSION };
  if (!pool.length || draw >= p) return { decision, intents: [] };
  let k = 1; if (rand() < 0.35 * atm) k++; if (rand() < 0.15 * atm) k++;
  k = Math.min(k, MAX_PENDING - state.pending.length, pool.length);
  if (k <= 0) return { decision, intents: [] };
  const chosen = weightedSampleWithoutReplacement(rand, pool, weights, k);
  const intents = chosen.map((s, i) => {
    const action = i === 0 ? sampleAction(rand, s, trigger) : sampleAction(rand, s, 'peer_statement');
    // Later hands respond to the previous speaker (peer response) — resolved when emitted.
    return { agent_id: s.agent_id, group_id: s.group_id, action, target: i === 0 ? { event_id: triggerEvent?.event_id || null, actor: triggerEvent?.actor_id || null } : { previous: true } };
  });
  decision.hands = intents.map((x) => x.agent_id);
  decision.selected_agent = intents[0].agent_id; decision.action = intents[0].action;
  decision.target_actor = intents[0].target.actor; decision.target_event_id = intents[0].target.event_id; decision.group_id = intents[0].group_id;
  return { decision, intents };
}

const STAGE_LEN = { low: 4, mid: 6, high: 8 };

/**
 * Advance one step. `last` is the previous persisted event ({event_id, actor_id, actor_type, kind, human_role}).
 * Returns { act, decision } where act describes the next utterance, or { act:{who:'end'} }.
 */
function stepInner(state, { students, stages, config, last, segmentsLeft }) {
  const rand = () => rngNext(state);
  state.turn++;
  if (state.done || state.stage_idx >= stages.length) { state.done = true; return { act: { who: 'end', reason: 'stages_completed' } }; }
  const stage = stages[state.stage_idx];
  const guidanceLimit = CONFIG_OPTIONS.guidance[config.guidance].limit;
  const groupOf = (id) => students.find((s) => s.agent_id === id)?.group_id;
  const emitStudent = (intent, decision) => {
    const target = intent.target?.previous ? { event_id: last?.event_id || null, actor: last?.actor_id || null } : intent.target;
    state.last_spoke[intent.agent_id] = state.turn; state.count[intent.agent_id] = (state.count[intent.agent_id] || 0) + 1;
    state.consec = state.last_actor === intent.agent_id ? state.consec + 1 : 1; state.last_actor = intent.agent_id;
    state.student_since_teacher++; state.stage_turn++;
    return { act: { who: 'student', agent_id: intent.agent_id, action: intent.action, target_event_id: target?.event_id || null, target_actor: target?.actor || null, group_id: intent.group_id, stage: stage.key, phase: state.phase }, decision };
  };
  const emitTeacher = (action, extra = {}) => {
    state.student_since_teacher = 0; state.last_actor = 'T'; state.consec = 0; state.stage_turn++;
    const st = stages[Math.min(state.stage_idx, stages.length - 1)];
    return { act: { who: 'teacher', action, stage: st.key, phase: state.phase, ...extra }, decision: null };
  };

  const lastIsTeacher = last && last.actor_id === 'T';
  const lastIsHumanStudent = last && last.actor_type === 'human' && last.human_role === 'student';
  const lastIsHumanTeacher = last && last.actor_type === 'human' && last.human_role === 'teacher';
  // 0) a real person interrupted: the human takes priority over queued hands
  if (lastIsHumanStudent) { state.pending = []; return emitTeacher('respond', { target_event_id: last.event_id, target_actor: last.actor_id }); }
  if (lastIsHumanTeacher) {
    state.pending = []; state.student_since_teacher = 0;
    // 教师点名：指定学生（S…）直接回应；指定小组（G…）由组内一人代表发言。仅在真人教师点名时触发，不改变无人介入时的抽样。
    const called = last.target_actor && students.find((s) => s.agent_id === last.target_actor);
    const members = !called && /^G\d+$/.test(last.target_actor || '') ? students.filter((s) => s.group_id === last.target_actor) : [];
    if (called || members.length) {
      const pick = called || weightedSampleWithoutReplacement(rand, members, members.map((s) => 0.2 + s.traits.expressiveness), 1)[0];
      const action = called ? 'answer_teacher' : 'report';
      const d = { trigger: 'teacher_call', trigger_event_id: last.event_id, n_candidates: called ? 1 : members.length, n_eligible: called ? 1 : members.length, speak_probability: 1, draw: null,
        hands: [pick.agent_id], selected_agent: pick.agent_id, action, target_actor: last.actor_id, target_event_id: last.event_id, group_id: pick.group_id, cooldown: 0, top_weights: [], distribution_version: DISTRIBUTION_VERSION };
      return emitStudent({ agent_id: pick.agent_id, group_id: pick.group_id, action, target: { actor: last.actor_id, event_id: last.event_id } }, d);
    }
    const { decision, intents } = opportunity(state, students, config, stage, 'teacher_question', last);
    if (intents.length) { state.pending.push(...intents.slice(1)); return emitStudent(intents[0], decision); }
    return { act: { who: 'system', action: 'silence', stage: stage.key, phase: state.phase }, decision };
  }

  // 1) queued hands speak first (serial subtitles), each re-checked for eligibility
  while (state.pending.length) {
    const intent = state.pending.shift();
    const d = { trigger: 'queued_intent', trigger_event_id: last?.event_id || null, n_candidates: students.length, n_eligible: null, speak_probability: null, draw: null,
      hands: [intent.agent_id], selected_agent: intent.agent_id, action: intent.action, target_actor: last?.actor_id || null, target_event_id: last?.event_id || null,
      group_id: intent.group_id, cooldown: COOLDOWN, top_weights: [], distribution_version: DISTRIBUTION_VERSION };
    if (state.last_actor === intent.agent_id && state.consec >= MAX_CONSEC) continue;
    return emitStudent(intent, d);
  }

  // 2) group phases
  if (state.phase === 'group' || state.phase === 'debate') {
    const groups = state.groups_this_round;
    if (state.group_turns >= Math.max(3, groups.length * 2)) {
      state.phase = 'report'; state.group_cursor = 0;
      return emitTeacher('call_report');
    }
    state.group_turns++;
    let filter, trigger = 'peer_statement';
    if (state.phase === 'group') { const g = groups[state.group_cursor++ % groups.length]; filter = (s) => s.group_id === g; if (lastIsTeacher) trigger = 'teacher_question'; }
    else { const side = state.debate_side++ % 2; filter = (s) => s.group_id === groups[side]; }
    const { decision, intents } = opportunity(state, students, config, stage, trigger, last, filter);
    if (intents.length) {
      if (state.phase === 'debate') intents.forEach((x, i) => { if (i === 0 && last && !lastIsTeacher) x.action = 'challenge'; });
      state.pending.push(...intents.slice(1));
      return emitStudent(intents[0], decision);
    }
    return { act: { who: 'system', action: 'silence', stage: stage.key, phase: state.phase, group_id: decision.group_id }, decision };
  }
  if (state.phase === 'report') {
    const groups = state.groups_this_round;
    if (state.group_cursor >= groups.length) { state.phase = 'teach'; return emitTeacher('summarize_groups'); }
    const g = groups[state.group_cursor++];
    const members = students.filter((s) => s.group_id === g);
    const rep = weightedSampleWithoutReplacement(rand, members, members.map((s) => 0.2 + s.traits.expressiveness), 1)[0];
    const d = { trigger: 'group_report', trigger_event_id: last?.event_id || null, n_candidates: members.length, n_eligible: members.length, speak_probability: 1, draw: null,
      hands: [rep.agent_id], selected_agent: rep.agent_id, action: 'report', target_actor: 'T', target_event_id: null, group_id: g, cooldown: 0, top_weights: [], distribution_version: DISTRIBUTION_VERSION };
    return emitStudent({ agent_id: rep.agent_id, group_id: g, action: 'report', target: { actor: 'T', event_id: null } }, d);
  }

  function advanceStage() {
    // Stage change; optional group work for group/debate organisation.
    state.stage_idx++; state.stage_turn = 0;
    if (state.stage_idx >= stages.length) { state.done = true; state.stage_idx = stages.length - 1; return emitTeacher('conclude'); }
    if (config.organization !== 'whole' && state.stage_idx % 2 === 1) {
      state.stage_intro = false;
      const all = [...new Set(students.map((s) => s.group_id))];
      const pickN = config.organization === 'debate' ? 2 : Math.min(3, all.length);
      state.groups_this_round = weightedSampleWithoutReplacement(rand, all, all.map(() => 1), pickN);
      state.phase = config.organization === 'debate' ? 'debate' : 'group'; state.group_turns = 0; state.group_cursor = 0;
      return emitTeacher(config.organization === 'debate' ? 'start_debate' : 'start_group', { groups: state.groups_this_round });
    }
    state.stage_intro = true;
    return emitTeacher('lecture');
  }

  // 3) teaching phase
  if (!state.stage_intro) { state.stage_intro = true; state.stage_turn = 0; return emitTeacher('lecture'); }
  const stageLen = STAGE_LEN[config.freedom];
  const timeUp = state.time_up ?? state.stage_turn >= stageLen;

  if (last && !lastIsTeacher && last.actor_type !== 'system') {
    // A student just spoke: peers may react (bounded by guidance), else the teacher decides.
    if (state.student_since_teacher < guidanceLimit) {
      const { decision, intents } = opportunity(state, students, config, stage, 'peer_statement', last);
      if (intents.length) { state.pending.push(...intents.slice(1)); return emitStudent(intents[0], decision); }
    }
    // Teacher weighs importance, drift and time budget: respond, probe, park the question, or steer back.
    const important = ['challenge', 'question', 'clarify'].includes(last.kind);
    const drifting = state.student_since_teacher >= guidanceLimit;
    const u = rand();
    const tgt = { target_event_id: last.event_id, target_actor: last.actor_id };
    if (important) {
      if (u < 0.55) return emitTeacher('respond', tgt);
      if (u < 0.72 && !timeUp) return emitTeacher('follow_up', tgt);
      if (u < 0.9 || timeUp) { state.deferred.push(last.event_id); return emitTeacher('defer', tgt); }
      return emitTeacher('redirect', tgt);
    }
    if (drifting && u < 0.3) return emitTeacher('redirect', tgt);
    if (u < 0.4) return emitTeacher('respond', tgt);
    if (timeUp) return advanceStage();
    return emitTeacher(segmentsLeft > 0 || rand() < 0.5 ? 'lecture' : 'question');
  }

  if (timeUp) return advanceStage();

  if (lastIsTeacher || (last && last.actor_type === 'system')) {
    const trigger = last && ['question', 'follow_up'].includes(last.kind) ? 'teacher_question' : 'lecture_segment';
    if (last.actor_type === 'system' && rand() < 0.5) return emitTeacher(rand() < 0.5 ? 'question' : 'lecture');
    const { decision, intents } = opportunity(state, students, config, stage, trigger, last);
    if (intents.length) { state.pending.push(...intents.slice(1)); return emitStudent(intents[0], decision); }
    // nobody spoke after a lecture segment: the teacher simply goes on teaching the next segment
    if (trigger === 'lecture_segment' && segmentsLeft > 0) return emitTeacher('lecture');
    return { act: { who: 'system', action: 'silence', stage: stage.key, phase: state.phase }, decision };
  }
  const qProb = { low: 0.35, mid: 0.5, high: 0.6 }[config.freedom];
  return emitTeacher(rand() < qProb ? 'question' : 'lecture');
}

// ---- simulated class clock ----
// Each act consumes nominal class time; runs.js later adjusts student speech to its actual length.
const NOMINAL = { lecture: 75000, recap: 45000, question: 20000, respond: 30000, follow_up: 15000, defer: 10000, redirect: 12000, transition: 10000,
  start_group: 30000, start_debate: 30000, call_report: 10000, summarize_groups: 30000, conclude: 30000,
  answer_teacher: 20000, ask: 12000, clarify: 10000, challenge: 18000, supplement: 15000, answer_peer: 15000, reflect: 15000, report: 40000, silence: 15000 };
export function stageBudgets(stages, config) {
  const total = (config.class_minutes || 45) * 60000;
  const m = stages.map((s) => (s.minutes > 0 ? s.minutes : null));
  if (m.every(Boolean)) { const sum = m.reduce((a, b) => a + b, 0); return m.map((x) => (x / sum) * total); }
  return stages.map(() => total / stages.length);
}
export function speechMs(text) { return Math.round((String(text || '').length / 4.5) * 1000) + 2000; }

/**
 * Advance one step. `last` is the previous persisted event ({event_id, actor_id, actor_type, kind, human_role}).
 * Returns { act, decision }; act carries class_clock_ms (start, simulated) and sim_ms (nominal duration).
 */
export function step(state, ctx) {
  const { stages, config } = ctx;
  if (state.clock_ms == null) { state.clock_ms = 0; state.stage_start_ms = 0; state.seg = {}; }
  const total = (config.class_minutes || 45) * 60000;
  const budgets = stageBudgets(stages, config);
  if (state.done) return { act: { who: 'end', reason: state.end_reason || 'stages_completed' } };
  if (state.clock_ms >= total) {
    // bell rings: whatever is going on, the teacher wraps up
    state.done = true; state.end_reason = 'class_time_over'; state.pending = [];
    const st = stages[Math.min(state.stage_idx, stages.length - 1)];
    const act = { who: 'teacher', action: 'conclude', stage: st.key, phase: 'teach', class_clock_ms: state.clock_ms, sim_ms: NOMINAL.conclude };
    state.clock_ms += act.sim_ms; state.turn++;
    return { act, decision: null };
  }
  const before = state.stage_idx;
  state.time_up = state.clock_ms - state.stage_start_ms >= budgets[Math.min(state.stage_idx, budgets.length - 1)];
  const stage = stages[Math.min(state.stage_idx, stages.length - 1)];
  const segs = stage?.segments?.length || 0;
  const res = stepInner(state, { ...ctx, segmentsLeft: segs - (state.seg[state.stage_idx] || 0) });
  delete state.time_up;
  const act = res.act;
  if (act.who === 'end') return res;
  if (state.stage_idx !== before) { state.stage_start_ms = state.clock_ms; }
  if (act.who === 'teacher' && act.action === 'lecture') {
    const idx = state.stage_idx, n = stages[idx]?.segments?.length || 0, k = state.seg[idx] || 0;
    if (n && k >= n) act.action = 'recap';
    else { act.segment = k; state.seg[idx] = k + 1; }
  }
  let ms = NOMINAL[act.action] ?? 15000;
  if (act.action === 'start_group' || act.action === 'start_debate') ms += Math.min(240000, budgets[state.stage_idx] * 0.4); // group work time
  act.class_clock_ms = state.clock_ms; act.sim_ms = ms;
  state.clock_ms += ms;
  return res;
}
