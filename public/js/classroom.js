// 演课场：40 人 · 可配置分组（默认 8 组 × 5 人）· 组级概览 + 个体聚焦 · 教师可干预。
// 上部「课堂实况 + 课堂实时数据」，下部「任课教师 + 学习小组」，所有状态来自真实运行数据（见 classroom-view.js）。
import { get, post } from './api.js';
import { esc, $, $$, toast, fail, modal, confirmBox, fmtMs, TYPE_NAME, hl, tour, execPref, modeCards, modeVal, bindModeCards, modeSwitch } from './ui.js';
import { createController, mountComposer, statusBadge } from './stage.js';
import { playerHtml, drawPlayer, bindPlayer } from './player.js';
import { flyPacket, kindOf } from './fx.js';
import { studentStates, groupStates, liveHtml, metricsHtml, groupCardHtml, teacherHtml, focusList, focusHtml, queueHtml, ideologyHtml, groupDetailHtml, gName, stuAva } from './classroom-view.js';

const GROUP_PRESETS = [[40, 8], [40, 5], [40, 4]]; // [班级人数, 每组人数] → 5×8、8×5、10×4
const profilePref = () => { try { return localStorage.getItem('yz-class-profile') || null; } catch { return null; } };
const groupPref = () => { try { const p = JSON.parse(localStorage.getItem('yz-groups') || 'null'); if (p?.class_size && p?.group_size) return p; } catch { /* ignore */ } return { class_size: 40, group_size: 5 }; };
const groupLabel = (p) => `${Math.ceil(p.class_size / p.group_size)}组 × ${p.group_size}人`;

export async function renderClassroom(root, { state, refreshMe, navigate, query }) {
  const cat = state.catalog, opt = cat.scheduler;
  let job = null, jobTimer = null, terms = [], speed = 10, clock = null, clockShown = 0, arrivedAt = 0, wasPlaying = false, ctrl = null, run = null, view = null, profiles = [], names = {}, pending = [], thinking = [], lastEv = null, stageIdx = 0;
  let phase = 'teach', groupsActive = [], streaming = null, viewMode = 'class', showAll = false, reviewIdx = null, ffTarget = null;
  const home = await get('/api/home');
  const current = home.current.classroom;
  const runs = (await get('/api/runs?module=classroom')).runs;
  const jobs = (await get('/api/jobs')).jobs;
  job = jobs.find((j) => ['running', 'paused'].includes(j.status)) || null;
  const jobRun = job?.current_run_id && runs.find((r) => r.run_id === job.current_run_id);
  if (!jobRun) job = null; // only follow a job while it is running the class
  const liveRun = runs.find((r) => ['running', 'paused', 'awaiting_human', 'ready'].includes(r.status));
  // 上一节课已结束、又导入了新的产物时，不再显示旧课堂，直接进入待开课状态（旧课堂仍可从产物库 / 评分页回看）
  const lastUsable = runs[0] && (!current || runs[0].input_artifact_id === current.artifact_id) ? runs[0] : null;
  const pick = query.run ? runs.find((r) => r.run_id === query.run) : jobRun || liveRun || lastUsable;
  let curBody = null, srcVersion = null;
  if (current) { try { const d = await get(`/api/artifacts/${current.artifact_id}`); curBody = d.artifact; srcVersion = d.versions.find((v) => v.artifact_id === d.artifact.parent_id && v.module === 'seminar')?.version ?? null; } catch { /* no access */ } }

  document.body.classList.add('is-cl');
  root.innerHTML = `<div class="cl">
    <div class="stage-top cl-top"><h1 class="cl-title">课堂试验场<small>多智能体课堂预演</small></h1><span id="st-badges" class="row" style="gap:6px"></span>
      ${modeSwitch(cat, 'mode-top')}
      <label class="cl-gsel" title="下一次开课使用的班级规模与分组">班级 <b>40人</b><select id="cl-groups" aria-label="分组方式">${GROUP_PRESETS.map(([c, g]) => `<option value="${c}:${g}">${groupLabel({ class_size: c, group_size: g })}</option>`).join('')}<option value="custom">自定义…</option></select></label>
      <button id="new-run" class="ghost-2">新建课堂</button><button id="fb" class="ghost-2">生成课堂反馈</button></div>
    <div class="cl-player">${playerHtml({ speeds: [1, 2, 5, 10, 20, 60] })}</div>
    <div class="cl-upper">
      <section class="cl-live-panel" aria-label="课堂实况">
        <header class="cl-ph"><div><h2>课堂实况 · 实时互动</h2><small>学生智能体依据教案与课堂进程自主参与；教师按教学设计推进</small></div><span class="cl-dot" id="live-dot"></span></header>
        <div class="cl-live" id="cl-live" aria-live="polite"></div>
        <div class="cl-live-foot"><button type="button" class="small ghost" id="cl-all">查看完整记录</button><details class="cl-prompt"><summary>讲解内容（跟学）</summary><div class="prompter" id="prompter" aria-label="教师讲解内容（跟学）"></div></details></div>
      </section>
      <aside class="cl-data" aria-label="课堂实时数据">
        <header class="cl-ph"><h2>课堂实时数据</h2><button type="button" class="small ghost" id="cl-ideo-btn">思政要点 <b id="cl-ideo-n">0</b></button></header>
        <div id="side" class="cl-data-body"></div>
      </aside>
    </div>
    <section class="cl-stage cl-room room-frame" aria-label="课堂试验场：任课教师与学习小组">
      <i class="rf-c tl"></i><i class="rf-c tr"></i><i class="rf-c bl"></i><i class="rf-c br"></i><i class="rf-sweep" aria-hidden="true"></i>
      <div class="rf-plate"><span class="rf-led" id="rf-led"></span><b>课堂试验场</b><span>智慧教室 · 多智能体课堂预演</span><em id="rf-stage"></em></div>
      <nav class="cl-rail" aria-label="课堂视图">
        ${[['class', '全班视图'], ['groups', '小组视图'], ['queue', '发言队列'], ['focus', '重点学生'], ['ideo', '思政要点']].map(([k, l]) => `<button type="button" data-view="${k}" class="${k === 'class' ? 'on' : ''}">${l}</button>`).join('')}
        <div class="cl-legend" id="cl-legend"></div>
      </nav>
      <div class="cl-main">
        <div class="cl-head"><div id="cl-teacher"></div><div class="cl-focus-row" id="cl-focus" aria-label="当前关注"></div>
          <div class="cl-tools" id="cl-tools" aria-label="教师调控">
            <button type="button" class="small" id="t-random">随机点名</button>
            <label class="cl-tsel"><select id="t-group" aria-label="指定小组发言"><option value="">指定小组发言…</option></select></label>
            <button type="button" class="small" id="t-discuss">发起全班讨论</button>
            <button type="button" class="small ghost" id="t-silent">查看未发言学生</button>
          </div></div>
        <div class="cl-body" id="scene"></div>
        <div class="stg-wrap cl-stg" id="cl-stages"></div>
      </div>
    </section></div>`;

  const composer = mountComposer({ label: '参与课堂', roles: [['teacher', '以教师身份'], ['student', '以学生身份']], kinds: [['question', '提问'], ['challenge', '质疑'], ['response', '回应'], ['supplement', '补充'], ['lecture', '讲授']],
    targets: () => { const recent = [...new Set((ctrl?.events || []).slice(-12).reverse().map((e) => e.actor_id).filter((a) => /^S\d|^T$/.test(a)))]; return recent.map((a) => [a, names[a] || a]); },
    onOpen: async () => { if (!ctrl) return; wasPlaying = ctrl.playing; ctrl.playing = false; try { ctrl.run = await post(`/api/runs/${run.run_id}/composer`, { open: true }); drawTop(); } catch { /* not running */ } },
    onClose: async () => { if (!ctrl) return; try { ctrl.run = await post(`/api/runs/${run.run_id}/composer`, { open: false }); drawTop(); } catch { /* ignore */ } if (wasPlaying) { wasPlaying = false; ctrl.play(); } },
    onSubmit: async (b) => { if (!ctrl) throw new Error('请先新建并开始课堂'); const e = await post(`/api/runs/${run.run_id}/human`, b); ctrl.add(e, true); toast(b.human_role === 'student' ? '已发言，教师将优先回应' : '已发言，学生将自主回应'); } });
  $('#cl-tools').append(composer.btn);
  composer.setEnabled(false);

  // ---------- derived state ----------
  // 回看：只显示到 reviewIdx 为止的事件（只读回放，不改变课堂）；举手队列与小组讨论状态不回放
  const events = () => (reviewIdx == null ? ctrl?.events || [] : (ctrl?.events || []).slice(0, reviewIdx + 1));
  const curLast = () => (reviewIdx == null ? lastEv : events().at(-1) || null);
  const speakingId = () => { const le = curLast(); return streaming && /^S\d/.test(streaming.actor_id) ? streaming.actor_id : le && /^S\d/.test(le.actor_id) && (reviewIdx != null || ctrl?.run?.status !== 'completed') ? le.actor_id : null; };
  const derive = () => {
    const rv = reviewIdx != null;
    const stu = studentStates({ profiles, events: events(), pending: rv ? [] : pending, thinking: rv ? [] : thinking, groupsActive: rv ? [] : groupsActive, phase: rv ? 'teach' : phase, speakingId: speakingId() });
    return { stu, groups: groupStates(stu, { events: events(), groupsActive: rv ? [] : groupsActive, phase: rv ? 'teach' : phase, lastEv: curLast() }) };
  };
  const active = () => ctrl?.run && ['ready', 'running', 'paused', 'awaiting_human'].includes(ctrl.run.status);
  const canCall = () => ctrl?.run && ['running', 'paused', 'awaiting_human'].includes(ctrl.run.status);

  // ---------- 顶部 ----------
  const drawTop = () => {
    const r = ctrl?.run;
    const c = curBody?.body?.course || {};
    $('#st-badges').innerHTML = `${c.name ? `<span class="badge">课程：${esc(c.name)}</span>` : ''}${view?.unit_label ? `<span class="badge cyan">单元：${esc(view.unit_label)}</span>` : ''}${current ? `<span class="badge gold" title="${esc(current.title)}（版本号在研课场与演课场之间连续编号，演课场 v${current.version}）">${esc({ lesson_plan: '教案', courseware: '课件', exercises: '练习', exam: '试卷', syllabus: '大纲', course_design: '课程设计', semester_plan: '学期设计', teaching_schedule: '进度表' }[current.type] || '产物')}${srcVersion != null ? ` · 研课场 v${srcVersion}` : ` v${current.version}`}</span>` : '<span class="badge">暂无当前产物</span>'}${curBody?.origin && /transfer/.test(curBody.origin) ? '<span class="badge red">来自研课场</span>' : ''}${statusBadge(r)}`;
    const act = active(), fresh = needsNewClass();
    $('#pl-play').title = fresh ? `用当前产物「${current.title}」直接开课（${execPref(cat) === 'model' ? '大模型 API 运行' : '模拟演示'}，${groupLabel(groupPref())}；可在“新建课堂”中调整）` : '';
    drawPlayerState();
    $('#fb').disabled = !(r && ['completed', 'paused', 'cancelled'].includes(r.status));
    $('#live-dot').classList.toggle('on', !!(r && r.status === 'running'));
    composer.setEnabled(!!act);
    for (const id of ['t-random', 't-group', 't-discuss']) $(`#${id}`).disabled = !canCall();
  };

  // ---------- 课堂实况 ----------
  const drawLive = () => {
    $('#cl-live').innerHTML = liveHtml({ events: events(), names, profiles, terms, streaming, showAll });
    if (showAll) { const f = $('#feed'); if (f) f.scrollTop = 0; }
    $('#cl-all').textContent = showAll ? '收起，只看重点事件' : '查看完整记录';
    drawPrompter();
  };

  // ---------- 课堂实时数据 ----------
  const drawSide = () => {
    const { stu, groups } = derive();
    const r = ctrl?.run;
    const jobNote = job ? `<div class="notice cyan small" style="margin-bottom:8px">这节课由任务自动执行（${job.status === 'running' ? '进行中' : '已暂停'}），结束后会自动生成课堂反馈并修订教案。<a href="/seminar" data-link="/seminar">查看任务进度 ›</a></div>` : '';
    const clockText = r ? `${fmtMs(headMs())}` : '';
    $('#side').innerHTML = r ? `${jobNote}${metricsHtml({ stu, groups, events: events(), pending, phase, clockText, run: r })}`
      : current && !runnable() ? `<div class="cl-empty"><b>当前产物是「${esc(TYPE_NAME[current.type] || current.type)}」</b><p>它不能直接用来上课。请在研课场中依据它修订教案，再把新教案送入演课场。</p><button class="small" data-link="/seminar">去研课场 ›</button></div>`
      : `<div class="cl-empty"><b>准备课堂</b><p>${current ? `将使用当前产物：${esc(current.title)} · ${esc(TYPE_NAME[current.type] || current.type)}${srcVersion != null ? `（研课场 v${srcVersion}）` : ` v${current.version}`}。点击“开始上课”即按 ${groupLabel(groupPref())} 开课。` : '演课场暂无当前产物。请在研课场完成教案后送入演课场（首页 → 箭头或研讨页“送入演课场”）。'}</p></div>`;
    $('#cl-ideo-n').textContent = events().filter((e) => e.ideology_terms && e.ideology_terms !== '[]').length;
    $$('#side [data-group]').forEach((b) => b.addEventListener('click', () => openGroup(b.dataset.group)));
  };

  // ---------- 下部：教师 + 小组 ----------
  const drawScene = () => {
    const { stu, groups } = derive();
    const lastT = [...events()].reverse().find((e) => e.actor_id === 'T');
    $('#cl-teacher').innerHTML = teacherHtml(lastT, streaming, names.T ? `${names.T.replace(/^任课教师 · /, '')} · 任课教师（AI）` : null);
    $('#cl-focus').innerHTML = focusHtml(focusList(stu, events()));
    const counts = {}; for (const s of stu.values()) counts[s.status] = (counts[s.status] || 0) + 1;
    $('#cl-legend').innerHTML = [['speaking', '发言中'], ['discussing', '小组讨论'], ['thinking', '思考中'], ['hand', '举手'], ['silent', '未发言']].map(([k, l]) => `<span><i class="sd sd-${k}"></i>${l}<b>${counts[k] || 0}</b></span>`).join('');
    const sel = $('#t-group'); const keep = sel.value;
    sel.innerHTML = `<option value="">指定小组发言…</option>${groups.map((g) => `<option value="${g.id}">${g.name}</option>`).join('')}`; sel.value = keep;
    const body = $('#scene');
    if (!profiles.length) body.innerHTML = `<div class="cl-empty">开课后，${groupLabel(groupPref())} 的学习小组会在这里显示：每组默认只显示一位代表和其余成员的状态点，点击小组查看全部成员。</div>`;
    else if (viewMode === 'class' || viewMode === 'groups') body.innerHTML = `<div class="cl-groups${viewMode === 'groups' ? ' expanded' : ''}" style="--n:${Math.min(4, Math.ceil(groups.length / 2))}">${groups.map((g) => groupCardHtml(g, { expanded: viewMode === 'groups' })).join('')}</div>`;
    else if (viewMode === 'queue') body.innerHTML = queueHtml({ stu, pending, speakingId: speakingId() });
    else if (viewMode === 'focus') body.innerHTML = `<div class="cl-focus-grid">${focusHtml(focusList(stu, events()))}</div><p class="cl-note">“当前关注”只列出需要教师留意的个体（最多 6 人）；“观点引发教师回应”表示该生发言后教师作了回应，不代表观点质量评分。</p>`;
    else body.innerHTML = ideologyHtml(events(), { names, profiles, terms });
    $$('#scene [data-group]').forEach((b) => b.addEventListener('click', () => openGroup(b.dataset.group)));
    $$('#scene [data-call], #cl-focus [data-stu], #scene [data-stu]').forEach((b) => b.addEventListener('click', () => (b.dataset.call ? callOn(b.dataset.call) : openStudent(b.dataset.stu))));
    $$('#cl-focus [data-stu]').forEach((b) => b.addEventListener('click', () => openStudent(b.dataset.stu)));
  };
  // 教学环节进程条：已完成/进行中/待开始、每个环节的计划时长，以及按当前倍速预估的下课时间
  const drawStages = () => {
    const st = view?.stages || [], el = $('#cl-stages'); if (!el) return;
    if (!ctrl?.run || !st.length) { el.innerHTML = '<div class="stg-empty">开课后按教案环节显示课堂进程，并按当前倍速预估下课时间。</div>'; $('#rf-stage').textContent = ''; return; }
    const ended = ['completed', 'cancelled', 'failed'].includes(ctrl.run.status), clockNow = headMs(), total = totalMs();
    const budgets = clock?.budgets_ms || []; let acc = 0;
    const items = st.map((x, i) => { const b = budgets[i] || 0, s0 = acc; acc += b; const state = ended || i < stageIdx ? 'done' : i === stageIdx ? 'running' : 'pending'; const used = Math.max(0, Math.min(b, clockNow - s0)); return { name: x.label, state, b, used }; });
    const remain = Math.max(0, total - clockNow), realRemain = remain / Math.max(1, speed);
    const eta = ended ? `已下课 · 模拟课时 ${fmtMs(Math.min(clockNow, total))}` : ctrl.playing ? `模拟课时剩 ${fmtMs(remain)} · 按 ${speed}× 约 ${fmtMs(realRemain)} 后下课（${new Date(Date.now() + realRemain).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}）` : `模拟课时剩 ${fmtMs(remain)} · 暂停中`;
    el.style.setProperty('--n', items.length);
    el.innerHTML = `<ol class="stg" style="grid-template-columns:repeat(${items.length},minmax(0,1fr))">${items.map((x, i) => `<li class="stg-${x.state}" title="${esc(`${x.name}：计划 ${Math.round(x.b / 60000)} 分钟`)}"><span class="stg-n">${x.state === 'done' ? '✓' : i + 1}</span><span class="stg-t"><b>${esc(x.name)}</b><small>${Math.round(x.b / 60000)} 分钟${x.state === 'running' ? ` · 已 ${fmtMs(x.used)}` : ''}</small></span><i class="stg-bar"><em style="width:${x.b ? (x.state === 'done' ? 100 : (x.used / x.b) * 100) : 0}%"></em></i></li>`).join('')}</ol><div class="stg-eta">${eta}</div>`;
    const cur = items.find((x) => x.state === 'running'); $('#rf-stage').textContent = cur ? `当前：${cur.name}` : ended ? '已下课' : '';
    $('#rf-led').classList.toggle('on', ctrl.run.status === 'running');
  };
  // 发言动画：学生发言从所在小组飞向教师；教师点名/回应从讲台飞向对应小组
  const animateEvent = (e) => {
    const box = $('.cl-main'); if (!box || reviewIdx != null) return;
    const teacher = $('#cl-teacher .cl-teacher') || $('#cl-teacher');
    const grp = (id) => { const g = profiles.find((p) => p.agent_id === id)?.group_id || (/^G\d+$/.test(id || '') ? id : null); return g ? $(`#scene [data-group="${g}"]`) : null; };
    if (/^S\d/.test(e.actor_id)) flyPacket(box, grp(e.actor_id), teacher, { kind: kindOf(e), label: { question: '提问', challenge: '质疑', report: '汇报', answer_teacher: '回答' }[e.kind] || '发言' });
    else if ((e.actor_id === 'T' || e.actor_type === 'human') && e.target_actor) flyPacket(box, teacher, grp(e.target_actor), { kind: e.actor_type === 'human' ? 'human' : 'teacher', label: e.actor_type === 'human' ? '点名' : '回应' });
  };
  const drawAll = () => { drawTop(); drawLive(); drawSide(); drawScene(); drawStages(); };

  // ---------- 教师调控（真实点名：服务端调度下一步由被点名学生/小组代表发言） ----------
  const stageNow = () => (view?.stages || [])[stageIdx] || {};
  async function teacherSay(text, target) {
    if (!canCall()) return toast('请先开始上课', true);
    try {
      const e = await post(`/api/runs/${run.run_id}/human`, { text, human_role: 'teacher', kind: 'question', target_actor: target || null, idempotency_key: `call-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });
      reviewIdx = null; ctrl.add(e, true); lastEv = e; drawAll(); requestAnimationFrame(() => animateEvent(e));
      toast(ctrl.playing || job ? '已发出，下一步由被点名的学生回应' : '已发出；点击“继续上课”或“单步”后由被点名的学生回应');
    } catch (err) { fail(err); }
  }
  function callOn(id) {
    const s = profiles.find((p) => p.agent_id === id); if (!s) return;
    const q = stageNow().question;
    teacherSay(`请${s.name}来谈谈：${q || '你对刚才讲的内容是怎么理解的？'}`, id);
  }
  $('#t-random').addEventListener('click', () => {
    const { stu } = derive(); const all = [...stu.values()];
    const pool = all.filter((s) => !s.spoke && s.status !== 'speaking'); const from = pool.length ? pool : all;
    const s = from[Math.floor(Math.random() * from.length)]; if (s) { toast(`随机点名：${s.name}（${gName(s.group)}${pool.length ? '，优先选择尚未发言的学生' : ''}）`); callOn(s.id); }
  });
  $('#t-group').addEventListener('change', (e) => { const g = e.target.value; if (!g) return; teacherSay(`请${gName(g)}派一位同学分享你们的想法。`, g); e.target.value = ''; });
  $('#t-discuss').addEventListener('click', () => { const st = stageNow(); teacherSay(`请大家围绕「${st.topic || st.label || '本环节内容'}」讨论：${st.question || '你认为关键在哪里？请说明理由。'}`); });
  $('#t-silent').addEventListener('click', () => {
    const { stu } = derive(); const list = [...stu.values()].filter((s) => !s.spoke);
    modal({ title: `尚未发言的学生（${list.length}）`, wide: true, body: list.length ? `<div class="cl-silent">${list.map((s) => `<button type="button" class="cl-focus" data-call="${s.id}">${stuAva(s)}<span><b>${esc(s.name)}</b><small>${gName(s.group)} · 表达倾向 ${Math.round((s.traits?.expressiveness ?? 0) * 100)}%</small></span></button>`).join('')}</div><p class="cl-note">点击学生即点名；表达倾向是模拟参数，不代表真实学生。</p>` : '<p>全班都已发过言。</p>',
      onMount: (m) => $$('[data-call]', m).forEach((b) => b.addEventListener('click', () => { m.querySelector('.actions button').click(); callOn(b.dataset.call); })) });
  });
  async function openGroup(gid) {
    const { groups } = derive(); const g = groups.find((x) => x.id === gid); if (!g) return;
    await modal({ title: `${g.name} · ${g.members.length} 人 · ${g.status[1]}`, wide: true, body: groupDetailHtml(g, { events: events(), terms }),
      onMount: (m) => $$('[data-call]', m).forEach((b) => b.addEventListener('click', () => { m.querySelector('.actions button').click(); callOn(b.dataset.call); })),
      buttons: [{ label: '关闭', value: null }, { label: `请${g.name}发言`, cls: 'primary', handler: async () => { await teacherSay(`请${g.name}派一位同学分享你们的想法。`, g.id); } }] });
  }
  function openStudent(id) { const { stu } = derive(); const s = stu.get(id); if (s) openGroup(s.group); }

  // ---------- 视图切换 ----------
  $$('.cl-rail [data-view]').forEach((b) => b.addEventListener('click', () => { viewMode = b.dataset.view; $$('.cl-rail [data-view]').forEach((x) => x.classList.toggle('on', x === b)); drawScene(); }));
  $('#cl-ideo-btn').addEventListener('click', () => { viewMode = 'ideo'; $$('.cl-rail [data-view]').forEach((x) => x.classList.toggle('on', x.dataset.view === 'ideo')); drawScene(); $('#scene').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
  $('#cl-all').addEventListener('click', () => { showAll = !showAll; drawLive(); });

  // ---- class clock (simulated class time) ----
  const totalMs = () => (clock?.class_minutes || 45) * 60000;
  const liveClock = () => {
    if (!lastEv || lastEv.class_clock_ms == null) return clock?.clock_ms || 0;
    if (ctrl?.watching) return lastEv.class_clock_ms + (lastEv.sim_duration_ms || 0);
    if (!ctrl?.playing) return clockShown;
    return Math.min(lastEv.class_clock_ms + (lastEv.sim_duration_ms || 0), lastEv.class_clock_ms + (Date.now() - arrivedAt) * speed);
  };
  // ---------- 播放器条：开始/继续 · 暂停 · 下课 · 回退 · 快进 · 进度条（回看 / 快进） ----------
  const liveEnd = () => { const e = ctrl?.events?.at(-1); return e?.class_clock_ms != null ? e.class_clock_ms + (e.sim_duration_ms || 0) : clock?.clock_ms || 0; };
  const stageMarks = () => { const b = clock?.budgets_ms || [], st = view?.stages || []; let acc = 0; return b.map((x, i) => { const m = { at: acc, label: `${st[i]?.label || ''}（${Math.round(x / 60000)} 分钟）` }; acc += x; return m; }); };
  const headMs = () => { if (reviewIdx != null) { const e = events().at(-1); return e ? e.class_clock_ms || 0 : 0; } return Math.min(clockShown, totalMs()); };
  const idxAt = (ms) => { const ev = ctrl?.events || []; let i = 0; for (let k = 0; k < ev.length; k++) { if ((ev[k].class_clock_ms || 0) <= ms) i = k; else break; } return i; };
  function drawPlayerState() {
    const r = ctrl?.run, act = active(), fresh = needsNewClass(), ended = r && ['completed', 'cancelled', 'failed'].includes(r.status);
    if (r && reviewIdx == null) clockShown = Math.max(clockShown, liveClock());
    const total = r ? totalMs() : 0, head = headMs(), marks = stageMarks();
    let si = 0; for (let i = 0; i < marks.length; i++) if (marks[i].at <= head) si = i;
    const stEnd = marks[si + 1]?.at ?? total;
    const state = !r ? 'idle' : ffTarget != null ? 'ff' : reviewIdx != null ? 'review' : job ? 'job' : ended ? 'ended' : ctrl.playing ? 'live' : 'paused';
    drawPlayer(root, {
      playLabel: reviewIdx != null ? '回到实时' : job ? '继续任务' : fresh ? '开始上课' : act && r.status !== 'ready' ? '继续上课' : '开始上课',
      canPlay: reviewIdx != null ? true : job ? job.status !== 'running' : fresh || (act && (!ctrl.playing || reviewIdx != null) && ffTarget == null),
      canPause: job ? job.status === 'running' : !!(ctrl?.playing || ffTarget != null),
      canEnd: !job && !!act, endLabel: '下课',
      canBack: !!r && (ctrl.events.length > 0) && head > 0,
      canFwd: !!r && ffTarget == null && (reviewIdx != null || (!!act && !job)),
      total, live: r ? Math.min(liveEnd(), total) : 0, head, marks: marks.slice(1),
      timeText: r ? `${fmtMs(head)} / ${fmtMs(total)}` : '尚未开课', stageText: r ? `${(view?.stages || [])[si]?.label || ''}${state === 'live' || state === 'paused' ? ` · 本环节剩 ${fmtMs(Math.max(0, stEnd - head))}` : ''}` : '',
      state, speed,
    });
    $('#live-dot').classList.toggle('on', state === 'live' || state === 'job');
  }
  async function review(ms) {
    if (!ctrl?.run) return;
    ffTarget = null;
    if (ctrl.playing) await ctrl.pause();
    const ev = ctrl.events; let i = 0;
    for (let k = 0; k < ev.length; k++) { if ((ev[k].class_clock_ms || 0) <= ms) i = k; else break; }
    reviewIdx = i >= ev.length - 1 && ms >= liveEnd() - 1000 ? null : i;
    showAll = false; drawAll();
  }
  async function fastForward(ms) {
    if (job) return toast('任务自动执行中：可以回看已发生的内容，不能快进', true);
    if (!active()) return toast('本节课已结束，无法快进', true);
    if (ctrl.run.exec_mode === 'model' && !(await confirmBox('快进', '<p>快进会连续调用大模型生成课堂发言，按成功调用扣积分。继续吗？</p>', '继续快进'))) return;
    reviewIdx = null;
    if (ctrl.playing) await ctrl.pause();
    ffTarget = Math.min(ms, totalMs()); drawAll();
    while (ffTarget != null && liveEnd() < ffTarget && active() && !ctrl.stopped) {
      const r = await ctrl.single();
      if (r === 'end' || r === 'error') break;
      if (r === 'busy') await new Promise((ok) => setTimeout(ok, 150));
    }
    ffTarget = null; clockShown = Math.min(liveEnd(), totalMs()); arrivedAt = Date.now();
    if (active() && !ctrl.playing) await ctrl.pause(); // 快进停在目标位置：服务端也记为暂停
    drawAll();
  }
  const seekTo = (ms) => (!ctrl?.run ? null : ms <= liveEnd() + 500 ? review(ms) : fastForward(ms));
  bindPlayer(root, {
    total: () => (ctrl?.run ? totalMs() : 0), format: (v) => fmtMs(v),
    seek: seekTo,
    // 回退 / 快进按“教学环节”跳；一段讲授跨越环节边界时，至少移动到前 / 后一条事件
    back: async () => {
      const ev = ctrl?.events || []; if (!ev.length) return;
      const cur = reviewIdx ?? ev.length - 1, h = headMs();
      const t = [0, ...stageMarks().map((m) => m.at)].reverse().find((a) => a < h - 3000 && idxAt(a) < cur);
      if (ctrl.playing) await ctrl.pause();
      reviewIdx = t != null ? idxAt(t) : Math.max(0, cur - 1); ffTarget = null; showAll = false; drawAll();
    },
    fwd: () => {
      const ev = ctrl?.events || [], h = headMs();
      if (reviewIdx != null) {
        const t = stageMarks().map((m) => m.at).find((a) => a > h + 3000 && idxAt(a) > reviewIdx);
        const i = t != null ? idxAt(t) : ev.length - 1;
        reviewIdx = i >= ev.length - 1 ? null : i; drawAll(); return;
      }
      fastForward(stageMarks().map((m) => m.at).find((a) => a > liveEnd() + 3000) ?? totalMs());
    },
    play: async () => {
      if (reviewIdx != null) { reviewIdx = null; drawAll(); if (!job && active() && !ctrl.playing) ctrl.play(); return; }
      if (job) { try { job = await post(`/api/jobs/${job.job_id}/resume`); drawTop(); } catch (e) { fail(e); } return; }
      if (needsNewClass()) return quickStart();
      if (active() && !ctrl.playing) ctrl.play();
    },
    pause: async () => {
      ffTarget = null;
      if (job) { try { job = await post(`/api/jobs/${job.job_id}/pause`); drawTop(); } catch (e) { fail(e); } return; }
      if (ctrl?.playing) await ctrl.pause();
      drawTop();
    },
    end: async () => {
      if (!active()) return;
      if (!(await confirmBox('下课', '<p>结束本节课？结束后不能继续上课，可以生成课堂反馈。</p>', '下课'))) return;
      ffTarget = null; reviewIdx = null; await ctrl.finish(); drawAll();
    },
    speed: (v) => { if (ctrl?.playing) { clockShown = liveClock(); arrivedAt = Date.now() - (clockShown - (lastEv?.class_clock_ms || 0)) / v; } speed = v; try { localStorage.setItem('yz-speed', String(v)); } catch { /* ignore */ } drawPlayerState(); },
  });
  const drawPrompter = () => {
    const st = (view?.stages || [])[stageIdx];
    if (!st || !ctrl?.run) { $('#prompter').innerHTML = '<p class="small faint">开课后显示当前环节的讲解要点。</p>'; return; }
    const segIdx = (clock?.segment_idx?.[stageIdx] ?? 0) - 1;
    $('#prompter').innerHTML = `<div class="ptitle">讲解内容 · ${esc(st.label)}（${st.minutes} 分钟）——跟着老师学</div>${(st.segments || []).map((t, i) => `<p class="${i < segIdx ? 'done' : i === segIdx ? 'now' : ''}">${hl(t, terms)}</p>`).join('')}${st.question ? `<p>❓ ${hl(st.question, terms)}</p>` : ''}`;
  };

  const attach = async (r) => {
    ctrl?.dispose();
    run = r; streaming = null; showAll = false;
    ctrl = createController({ runId: r.run_id, refreshMe, hooks: {
      delay: () => Math.min(120000, Math.max(600, (lastEv?.sim_duration_ms || 20000) / speed)),
      onLoad: (v) => { view = v; clock = v.clock; clockShown = Math.min(v.clock?.clock_ms || 0, (v.clock?.class_minutes || 45) * 60000); terms = v.ideology_terms || []; speed = Number((() => { try { return localStorage.getItem('yz-speed'); } catch { return null; } })()) || v.run.config.speed || 10; profiles = v.profiles; names = Object.fromEntries(profiles.map((p) => [p.agent_id, p.name])); pending = v.pending_hands || []; stageIdx = v.stage_idx || 0; phase = v.phase || 'teach'; groupsActive = v.groups_active || []; },
      onStart: (d) => { streaming = { actor_id: d.actor_id }; drawLive(); drawScene(); },
      onDelta: (d) => { const s = $('#stream-text'); if (s) s.textContent += d.delta; },
      onEvent: (e, live) => { if (!live) return; lastEv = e; streaming = null; drawLive(); drawScene(); drawStages(); requestAnimationFrame(() => animateEvent(e)); },
      onFinal: (d) => { arrivedAt = Date.now(); if (d.classroom) { pending = d.classroom.pending_hands; thinking = d.classroom.thinking || []; stageIdx = d.classroom.stage_idx; phase = d.classroom.phase || phase; groupsActive = d.classroom.groups_active || []; if (clock) { clock.clock_ms = d.classroom.clock_ms; clock.segment_idx = d.classroom.segment_idx || clock.segment_idx; } } ctrl.run.model_calls = d.model_calls ?? ctrl.run.model_calls; drawScene(); drawSide(); },
      onResync: (v) => { pending = v.pending_hands || pending; stageIdx = v.stage_idx ?? stageIdx; phase = v.phase || phase; groupsActive = v.groups_active || groupsActive; if (v.clock) clock = v.clock; drawSide(); drawTop(); drawPrompter(); drawScene(); },
      onState: () => { drawTop(); drawSide(); },
      onPlay: () => drawTop(),
      onModelError: (d) => offerDemo(d),
      onEnd: (d) => toast(`课堂结束（${{ turn_limit: '达到轮次上限', time_limit: '达到时间上限', stages_completed: '教学阶段完成' }[d.reason] || d.reason}）。可点击“生成课堂反馈”。`),
    } });
    await ctrl.load();
    if (ctrl.run.status === 'awaiting_human' && !composer.isOpen()) { try { ctrl.run = await post(`/api/runs/${r.run_id}/composer`, { open: false }); } catch { /* not ours to close */ } }
    if (job && job.current_run_id === r.run_id) ctrl.watch();
    lastEv = ctrl.events.at(-1) || null;
    drawAll();
  };

  // A class can start right away whenever there is a current artifact and no unfinished class on that same artifact
  // (e.g. just after importing from 研课场): “开始上课” creates the run with default settings and plays it.
  // 课堂反馈、知识点图谱、反思报告不能直接上课：应回到研课场修订后，再把新教案送入课堂
  const NOT_RUNNABLE = new Set(['classroom_feedback', 'knowledge_map', 'reflection_report']);
  const runnable = () => current && !NOT_RUNNABLE.has(current.type);
  function needsNewClass() {
    if (!current || job || !runnable()) return false;
    const r = ctrl?.run;
    return !(r && ['ready', 'running', 'paused', 'awaiting_human'].includes(r.status) && r.input_artifact_id === current.artifact_id);
  }
  async function quickStart(mode = execPref(cat)) {
    const r = ctrl?.run;
    if (r && ['running', 'paused', 'ready', 'awaiting_human'].includes(r.status)) { if (ctrl.playing) await ctrl.pause(); await post(`/api/runs/${r.run_id}/finish`).catch(() => {}); refreshMe(); }
    $('#pl-play').disabled = true;
    try {
      const created = await post('/api/runs', { module: 'classroom', exec_mode: mode, config: { ...groupPref(), ...(profilePref() ? { class_profile_id: profilePref() } : {}), organization: 'group', freedom: 'mid', atmosphere: 'balanced', guidance: 'timely', knowledge: 'normal', skepticism: 'mid', cooperation: 'mid', seed: `seed-${Math.random().toString(36).slice(2, 8)}`, speed } });
      await attach(created); toast(mode === 'model' ? '已开课：大模型 API 实时生成' : '已开课：模拟演示'); ctrl.play();
    } catch (e) { fail(e); drawTop(); }
  }
  async function offerDemo(d) {
    const ok = await modal({ title: '大模型调用失败', body: `<p>${esc(d.message)}</p><p class="small muted">本次失败的调用没有扣积分。需要管理员在后台“模型与 API Key”中修正配置后，才能继续用大模型运行。现在可以改用模拟演示，立即重新开课。</p>`,
      buttons: [{ label: '稍后再说', value: false }, { label: '🎬 改用模拟演示开课', value: true, cls: 'primary' }] });
    if (!ok) return;
    $('#mode-top [data-mode="demo"]')?.click();
    await quickStart('demo');
  }

  async function setup() {
    const seedGen = () => `seed-${Math.random().toString(36).slice(2, 8)}`;
    const sel = (id, obj, def, labelOf = (v) => v) => `<select id="${id}">${Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === def ? 'selected' : ''}>${esc(labelOf(v, k))}</option>`).join('')}</select>`;
    const body = `<div class="grid3">
      <label>班级规模<select id="c-size">${[...new Set([...opt.class_size, groupPref().class_size])].sort((a, b) => a - b).map((n) => `<option ${n === groupPref().class_size ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label>组织方式${sel('c-org', opt.organization, 'group')}</label><label>每组人数<input id="c-gs" type="number" min="2" max="12" value="${groupPref().group_size}"></label>
      <label>互动自由度${sel('c-free', opt.freedom, 'mid', (v) => v.label)}</label><label>课堂气氛${sel('c-atm', opt.atmosphere, 'balanced', (v) => v.label)}</label><label>教师引导${sel('c-guid', opt.guidance, 'timely', (v) => v.label)}</label>
      <label>知识分布${sel('c-know', opt.knowledge, 'normal')}</label><label>质疑倾向${sel('c-skep', { low: '低', mid: '中', high: '高' }, 'mid')}</label><label>合作倾向${sel('c-coop', { low: '低', mid: '中', high: '高' }, 'mid')}</label>
      <label>随机 seed<div class="row" style="flex-wrap:nowrap"><input id="c-seed" value="${seedGen()}"><button class="small" type="button" id="c-reseed" aria-label="重新生成 seed">🎲</button></div></label>
      <label>上课时长<select id="c-class">${cat.lesson_minutes.map((x) => `<option value="${x}" ${x === 45 ? 'selected' : ''}>${x} 分钟</option>`).join('')}</select></label>
      <label>运行倍速（可在课堂中随时调整）<select id="c-speed">${[1, 2, 5, 10, 20, 60].map((x) => `<option value="${x}" ${x === speed ? 'selected' : ''}>${x}×${x === 1 ? '（真实课堂节奏）' : ''}</option>`).join('')}</select></label>
      <label>最多发言轮次（安全上限）<input id="c-turns" type="number" min="5" max="400" value=""  placeholder="按课时自动"></label></div>
      <p class="small faint">“越活跃”不等于效果越好。相同 seed/配置/输入可复现调度抽样，不代表可复现模型文本。性格参数与头像独立。</p>
      <div class="small" style="margin:6px 0 4px;color:var(--gold)">运行方式</div>${modeCards(cat, 'c-exec')}
      <div class="estimate" id="c-est" style="margin-top:10px">…</div>`;
    const collect = (m) => ({ module: 'classroom', exec_mode: modeVal($('#c-exec', m)), config: { class_size: Number($('#c-size', m).value), organization: $('#c-org', m).value, group_size: Number($('#c-gs', m).value), freedom: $('#c-free', m).value, atmosphere: $('#c-atm', m).value, guidance: $('#c-guid', m).value, knowledge: $('#c-know', m).value, skepticism: $('#c-skep', m).value, cooperation: $('#c-coop', m).value, seed: $('#c-seed', m).value, class_minutes: Number($('#c-class', m).value), speed: Number($('#c-speed', m).value), ...($('#c-turns', m).value ? { max_turns: Number($('#c-turns', m).value) } : {}) } });
    const res = await modal({ title: '新建课堂 · 课堂试验场', wide: true, body,
      onMount: (m) => {
        const upd = async () => { try { const e = await post('/api/runs/estimate', collect(m)); $('#c-est', m).innerHTML = `将执行：<b>${esc(e.unit_label)}</b>（${e.stages.map(esc).join(' → ')}）· 输入：${esc(e.input_artifact.title)} v${e.input_artifact.version}<br>${e.exec_mode === 'model' ? `预计最多 <b>${e.max_calls}</b> 次调用，最多 <b>${e.max_credits}</b> 积分 · 当前可用 ${e.balance.available}` : '本地生成：不调用大模型，不消耗积分'}`; } catch (e) { $('#c-est', m).textContent = e.message; } };
        $$('select,input', m).forEach((el) => el.addEventListener('change', upd));
        bindModeCards($('#c-exec', m), () => { syncTopMode(); upd(); });
        $('#c-reseed', m).addEventListener('click', () => { $('#c-seed', m).value = seedGen(); upd(); });
        upd();
      },
      buttons: [{ label: '取消', value: null }, { label: '创建并开始', cls: 'primary', handler: async (m) => post('/api/runs', collect(m)) }] });
    if (!res) return;
    await attach(res); ctrl.play();
  }

  // ---------- 分组方式（下一次开课生效） ----------
  const gsel = $('#cl-groups'); const pref = groupPref();
  const profiles_ = cat.class_profiles || [];
  if (profiles_.length) gsel.insertAdjacentHTML('beforeend', `<optgroup label="按班级画像开课">${profiles_.map((cp) => `<option value="profile:${cp.profile_id}">画像：${esc(cp.name)}（${cp.n} 人 · ${cp.stats?.groups || '?'} 组）</option>`).join('')}</optgroup>`);
  const curProf = profiles_.find((cp) => cp.profile_id === profilePref());
  if (profilePref() && !curProf) { try { localStorage.removeItem('yz-class-profile'); } catch { /* ignore */ } }
  gsel.value = curProf ? `profile:${curProf.profile_id}` : GROUP_PRESETS.some(([c, g]) => c === pref.class_size && g === pref.group_size) ? `${pref.class_size}:${pref.group_size}` : 'custom';
  if (gsel.value === 'custom') gsel.querySelector('option[value=custom]').textContent = `${groupLabel(pref)}（自定义）`;
  $('.cl-gsel b').textContent = `${curProf ? curProf.n : pref.class_size}人`;
  gsel.addEventListener('change', async () => {
    let p;
    if (gsel.value.startsWith('profile:')) {
      const cp = profiles_.find((x) => `profile:${x.profile_id}` === gsel.value);
      try { localStorage.setItem('yz-class-profile', cp.profile_id); } catch { /* ignore */ }
      $('.cl-gsel b').textContent = `${cp.n}人`; toast(`已选择班级画像「${cp.name}」：${cp.n} 名学生智能体按导入数据生成，${active() ? '下一次开课生效' : '点击“开始上课”即按此开课'}`); drawTop(); return;
    }
    try { localStorage.removeItem('yz-class-profile'); } catch { /* ignore */ }
    if (gsel.value === 'custom') {
      p = await modal({ title: '自定义分组', body: `<div class="grid2"><label>班级人数<input id="cg-n" type="number" min="4" max="300" value="${groupPref().class_size}"></label><label>每组人数<input id="cg-g" type="number" min="2" max="12" value="${groupPref().group_size}"></label></div><p class="small muted">比赛演示建议 40 人 · 8 组 × 5 人。24、80、120、300 人等规模也可在这里设置。</p>`,
        buttons: [{ label: '取消', value: null }, { label: '确定', cls: 'primary', handler: async (m) => ({ class_size: Math.max(4, Math.min(300, Number($('#cg-n', m).value) || 40)), group_size: Math.max(2, Math.min(12, Number($('#cg-g', m).value) || 5)) }) }] });
      if (!p) { gsel.value = `${groupPref().class_size}:${groupPref().group_size}`; return; }
    } else { const [c, g] = gsel.value.split(':').map(Number); p = { class_size: c, group_size: g }; }
    try { localStorage.setItem('yz-groups', JSON.stringify(p)); } catch { /* ignore */ }
    $('.cl-gsel b').textContent = `${p.class_size}人`;
    toast(`已设为 ${p.class_size} 人 · ${groupLabel(p)}，${active() ? '下一次开课生效' : '点击“开始上课”即按此开课'}`);
    drawTop(); drawSide(); drawScene();
  });

  $('#new-run').addEventListener('click', async () => { if (ctrl?.run && ['running', 'awaiting_human'].includes(ctrl.run.status)) { toast('请先暂停或结束当前课堂', true); return; } if (!current) return toast('演课场暂无当前产物，请先从研课场导入', true); if (ctrl?.run && ['paused', 'ready'].includes(ctrl.run.status)) await post(`/api/runs/${ctrl.run.run_id}/finish`).catch(() => {}); setup(); });
  const syncTopMode = () => { const v = execPref(cat), el = $('#mode-top'); if (!el) return; el.dataset.value = v; $$('[data-mode]', el).forEach((x) => { x.classList.toggle('on', x.dataset.mode === v); x.setAttribute('aria-checked', String(x.dataset.mode === v)); }); };
  bindModeCards($('#mode-top'), (v) => {
    drawTop();
    const r = ctrl?.run;
    if (r && ['ready', 'running', 'paused', 'awaiting_human'].includes(r.status) && r.exec_mode !== v) toast(`已选择「${v === 'model' ? '大模型 API 运行' : '模拟演示'}」：本节课仍按原方式进行，下一次开课生效`);
    else toast(v === 'model' ? '已选择：大模型 API 运行（按成功调用扣积分）' : '已选择：模拟演示（不扣积分）');
  });
  if (job) jobTimer = setInterval(async () => {
    try { job = await get(`/api/jobs/${job.job_id}`); if (job.current_run_id !== run?.run_id) { clearInterval(jobTimer); job = null; toast('课堂已结束，任务继续执行后续步骤（见研课场的任务进度）'); } drawTop(); } catch { /* transient */ }
  }, 1500);
  $('#fb').addEventListener('click', async () => {
    try {
      const a = await post(`/api/runs/${run.run_id}/feedback`);
      const set = await modal({ title: '课堂反馈已生成', body: `<p><b>${esc(a.title)}</b>（v${a.version}，草稿）</p><p class="small muted">由本节课的课堂事件汇编：各环节计划与模拟用时、学生质疑与未解决问题、小组互动、课程思政自然生成点与修订建议；不评估真实学习效果。</p><p class="small">送回研课场后，各位教师智能体会依据这份反馈修订教案——这就是“研—演—评—改”的闭环。</p>`,
        buttons: [{ label: '稍后', value: false }, { label: '查看反馈', value: 'view' }, { label: '返回研课场继续改进 →', value: 'back', cls: 'primary' }] });
      if (set === 'view') navigate(`/library?id=${a.artifact_id}`);
      if (set === 'back') {
        const r = await post('/api/revise-from-feedback', { feedback_artifact_id: a.artifact_id, exec_mode: execPref(cat) });
        toast(`反馈已带回研课场，教研组开始依据反馈修订《${r.base.title}》`);
        navigate(`/seminar?run=${r.run_id}&play=1`);
      }
    } catch (e) { fail(e); }
  });
  const onResize = () => drawScene();
  window.addEventListener('resize', onResize);
  const onKey = (e) => { if (e.target.closest('input,textarea,select')) return; if (e.key === ' ') { e.preventDefault(); const b = !$('#pl-pause').disabled ? $('#pl-pause') : $('#pl-play'); if (!b.disabled) b.click(); } };
  document.addEventListener('keydown', onKey);
  let tick = 0; const timer = setInterval(() => { drawPlayerState(); if (++tick % 4 === 0) drawStages(); }, 250);

  if (pick) await attach(pick); else drawAll();
  tour('classroom', [
    { sel: '#pl-play', place: 'bottom', title: '开始上课', text: '从研课场导入教案后，直接点这里就能开课（默认 40 人 · 8 组 × 5 人）。' },
    { sel: '#pl-track', place: 'bottom', title: '播放器条', text: '暂停、下课、回退、快进；拖动进度条到已上过的部分可以回看，拖到后面会快进到那里。回看不改变课堂。' },
    { sel: '.cl-live-panel', place: 'right', title: '课堂实况', text: '只显示当前最重要的课堂事件：正在发言的学生、教师引导和最近几条互动；“查看完整记录”可展开全部。' },
    { sel: '.cl-data', place: 'left', title: '课堂实时数据', text: '6 项核心指标和小组活跃度都由本节课的模拟事件实时计算。' },
    { sel: '#scene', place: 'top', title: '8 个学习小组', text: '每组只显示一位代表和其余成员的状态点；点击小组查看 5 名成员的状态、发言次数和最近观点，也可以点名。' },
    { sel: '#cl-tools', place: 'bottom', title: '教师调控', text: '随机点名、指定小组发言、发起全班讨论：被点名的学生或小组代表会在下一步回应。' },
  ]);
  return () => { ctrl?.dispose(); composer.remove(); clearInterval(timer); clearInterval(jobTimer); window.removeEventListener('resize', onResize); document.removeEventListener('keydown', onKey); document.body.classList.remove('is-cl'); };
}
