// 研课场工作台：上部「多智能体研讨区 + 研讨任务进度」，下部「数字教研圆桌」（默认 8 位教师智能体 + 协同核心），底部快捷工具。
// 所有状态来自真实运行数据（事件、编排游标、质询、任务步骤）；渲染组件见 seminar-view.js。
import { get, post, del, key } from './api.js';
import { esc, $, $$, toast, fail, modal, confirmBox, TYPE_NAME, tour, modeCards, modeVal, bindModeCards, modeSwitch } from './ui.js';
import { createController, statusBadge, isIdeo } from './stage.js';
import { openTaskWizard } from './task.js';
import { doTransfer } from './home.js';
import { playerHtml, drawPlayer, bindPlayer } from './player.js';
import { flyPacket, kindOf } from './fx.js';
import { FILTERS, filterEvents, msgHtml, agentStates, roundtableHtml, coreStatus, coreHtml, progressHtml, outcomeHtml, KIND_LABEL, stageTimeline, stagesHtml, stageLogHtml } from './seminar-view.js';

const ASK_KINDS = [['question', '提问'], ['challenge', '质疑'], ['supplement', '补充'], ['observation', '观察记录']];

export async function renderSeminar(root, { state, refreshMe, navigate, query }) {
  const cat = state.catalog;
  const roles = cat.agent_roles || cat.roles;
  const seatable = () => [...cat.fixed_teachers, ...cat.custom_slots.filter((k) => roles[k]?.enabled)];
  let seats = [...cat.default_seats], shape = 'oval';
  let job = null, jobTimer = null, terms = [], ctrl = null, names = {}, run = null, view = null, working = null, plan = null;
  let sideTab = 'progress', filter = 'all', streaming = null, mention = null, composing = false, stickBottom = true, reviewIdx = null, ffTarget = null;
  try { const s = JSON.parse(localStorage.getItem('yz-seats') || 'null'); if (s?.seats?.[0] === 'leader' && s.v === 2) { seats = s.seats.filter((k) => seatable().includes(k)); shape = s.shape || 'oval'; } } catch { /* ignore */ }
  const home = await get('/api/home');
  const current = home.current.seminar;
  const runs = (await get('/api/runs?module=seminar')).runs;
  const jobs = (await get('/api/jobs')).jobs;
  job = jobs.find((j) => ['running', 'paused'].includes(j.status)) || jobs[0] || null;
  const jobRun = job?.current_run_id && runs.find((r) => r.run_id === job.current_run_id);
  const pick = query.run ? runs.find((r) => r.run_id === query.run) : jobRun || runs.find((r) => ['running', 'paused', 'awaiting_human', 'ready'].includes(r.status)) || runs[0];
  const jobActive = () => job && ['running', 'paused'].includes(job.status);
  // 显示的研讨不属于这次任务（例如依据课堂反馈的修订）时，右侧显示这次研讨的进度而不是旧任务
  if (pick && job && !jobActive() && !(job.steps || []).some((s) => s.run_id === pick.run_id)) job = null;
  const runActive = () => ctrl?.run && ['ready', 'running', 'paused', 'awaiting_human'].includes(ctrl.run.status);
  let currentBody = null;
  if (!pick && current) { try { currentBody = (await get(`/api/artifacts/${current.artifact_id}`)).artifact.body; } catch { /* no access */ } }

  document.body.classList.add('is-sw');
  const simplePref = () => { try { return localStorage.getItem('yz-sw-simple') === '1'; } catch { return false; } };
  root.innerHTML = `<div class="sw">
    <div class="stage-top sw-top"><h1 class="sw-title">数字教研室<small>多智能体协同研课</small></h1><span id="st-badges" class="row" style="gap:6px"></span><span class="spacer"></span>
      ${modeSwitch(cat, 'mode-top')}
      <details class="sw-seats"><summary>席位设置 <b id="seat-n"></b></summary><div class="sw-seats-pop"><p class="small faint">勾选参加研讨的教师（至少 3 位）。组长固定主持；席位在新建任务时生效。自定义教师需先在 <a href="/agents" data-link="/agents">智能体中心</a> 设置。</p>
        <div class="sw-seat-list" id="seat-list"></div></div></details>
      <button id="sw-simple" class="ghost" aria-pressed="false" title="只保留研讨对话、任务进度和播放器，隐藏下方会议室">简洁视图</button>
      <button id="new-run">新建任务</button></div>
    <div class="sw-player">${playerHtml()}</div>
    <div class="sw-upper">
      <section class="sw-talk" aria-label="多智能体研讨区">
        <header class="sw-th"><div><h2>研讨对话 · 多智能体协同</h2><small>汇聚专业智慧，共研优质课堂</small></div><span class="sw-motto">立德树人</span></header>
        <div class="sw-filter" role="tablist" aria-label="筛选发言" id="sw-filter"></div>
        <div class="sw-live" id="subtitle" aria-live="polite"></div>
        <div class="sw-msgs" id="feed" tabindex="0" aria-label="研讨发言记录"></div>
        <form class="sw-input" id="sw-form" autocomplete="off">
          <div class="sw-chips" id="sw-chips"></div>
          <div class="sw-row"><textarea id="sw-text" rows="1" placeholder="继续输入您的观点，或 @ 某位智能教师……（Ctrl+Enter 发送）" aria-label="输入你的发言"></textarea><button type="submit" class="primary" id="sw-send">发送</button></div>
          <div class="sw-tools">
            <div class="sw-pop-wrap"><button type="button" class="ghost small" id="sw-at" aria-haspopup="true" aria-expanded="false">＠ 教师</button><div class="sw-pop" id="sw-at-pop" role="menu" hidden></div></div>
            <div class="sw-pop-wrap"><button type="button" class="ghost small" id="sw-cite" aria-haspopup="true" aria-expanded="false">引用材料</button><div class="sw-pop" id="sw-cite-pop" role="menu" hidden></div></div>
            <label class="ghost small sw-up" title="上传到课程材料库，新建任务时可选用">上传材料<input type="file" id="sw-file" multiple accept=".docx,.pptx,.xlsx,.txt,.md,.csv" hidden></label>
            <select id="sw-kind" aria-label="发言类型">${ASK_KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
            <span class="grow"></span><span class="small faint" id="sw-hint"></span></div>
        </form>
      </section>
      <aside class="sw-side" aria-label="研讨任务进度">
        <div class="sw-tabs" role="tablist" id="sw-tabs"></div>
        <div class="sw-side-body" id="side"></div>
      </aside>
    </div>
    <section class="room-frame sw-room" aria-label="数字教研室：协同研讨的智能教师">
      <i class="rf-c tl"></i><i class="rf-c tr"></i><i class="rf-c bl"></i><i class="rf-c br"></i><i class="rf-sweep" aria-hidden="true"></i>
      <div class="rf-plate"><span class="rf-led" id="rf-led"></span><b>数字教研室</b><span>研讨会议室 · 第 1 研讨桌</span><em id="rf-stage"></em></div>
      <div class="sw-table" id="scene"></div>
      <div class="stg-wrap" id="sw-stages"></div>
    </section>
    <nav class="sw-dock" aria-label="快捷工具">
      <button type="button" class="on" aria-current="page" data-dock="here">研课场</button>
      <button type="button" data-dock="import">导入课程内容</button>
      <button type="button" data-dock="map">知识点图谱</button>
      <button type="button" data-dock="lib">思政元素参考</button>
      <button type="button" data-dock="export">研讨记录导出</button>
      <button type="button" data-dock="transfer">送入演课场 →</button>
      <span class="grow"></span>
      <button type="button" class="participate primary" id="sw-join">参与研课 <span aria-hidden="true">→</span></button>
    </nav>
  </div>`;

  // ---------- helpers ----------
  const seatOf = (id) => (/^M\d+$/.test(id) ? Number(id.slice(1)) : 0);
  const roleOf = (id) => seats[seatOf(id)] || 'leader';
  // 回看：只显示到 reviewIdx 为止的发言；进度单位是组长编排的“步”（真人发言及对真人的回应不计步）
  const events = () => (reviewIdx == null ? ctrl?.events || [] : (ctrl?.events || []).slice(0, reviewIdx + 1));
  const stepCount = (evs) => { const h = new Set(evs.filter((e) => e.actor_type === 'human').map((e) => e.event_id)); return evs.filter((e) => e.actor_type !== 'human' && !(e.reply_to && h.has(e.reply_to))).length; };
  const totalSteps = () => plan?.steps?.length || 0;
  const liveStep = () => (ctrl?.run?.status === 'completed' ? totalSteps() : Math.min(view?.plan?.cursor ?? 0, totalSteps()));
  const headStep = () => (reviewIdx == null ? liveStep() : Math.min(stepCount(events()), totalSteps()));
  const cursor = () => (reviewIdx == null ? view?.plan?.cursor ?? 0 : headStep());
  const byId = () => new Map(events().map((e) => [e.event_id, e]));

  // ---------- 顶部 ----------
  const drawTop = () => {
    const r = ctrl?.run;
    $('#st-badges').innerHTML = `${current ? `<span class="badge gold" title="当前产物">当前：${esc(current.title)} · v${current.version}</span>` : '<span class="badge">暂无当前产物</span>'}${statusBadge(r)}${plan ? `<span class="badge">${esc(plan.mode_name)}</span>` : ''}`;
    const active = runActive();
    $('#pl-play').title = active || jobActive() ? '' : '导入课程内容，选择成果后自动执行';
    drawPlayerState();
    const locked = !!(r && !['completed', 'cancelled', 'failed'].includes(r.status));
    $('#seat-n').textContent = `${seats.length} 位`;
    $('#seat-list').innerHTML = seatable().map((k, i) => `<label class="inline small"><input type="checkbox" data-seat-key="${k}" ${seats.includes(k) ? 'checked' : ''} ${k === 'leader' || locked ? 'disabled' : ''}> ${esc(roles[k].person ? `${roles[k].person} · ${roles[k].title}` : roles[k].title)}</label>`).join('');
    $$('#seat-list [data-seat-key]').forEach((cb) => cb.addEventListener('change', () => {
      const k = cb.dataset.seatKey; const next = cb.checked ? seatable().filter((x) => seats.includes(x) || x === k) : seats.filter((x) => x !== k);
      if (next.length < 3) { cb.checked = true; return toast('至少保留 3 位教师', true); }
      seats = next; save(); drawScene(); drawTop();
    }));
    $('#rf-led').classList.toggle('on', !!(r && r.status === 'running') || (jobActive() && job.status === 'running'));
    const can = active || jobActive();
    $('#sw-send').disabled = !can; $('#sw-hint').textContent = can ? '' : '开始任务后即可参与研讨';
    $('#sw-join').disabled = false;
  };

  // ---------- 左：研讨对话 ----------
  const drawFilter = () => {
    const ev = events();
    $('#sw-filter').innerHTML = FILTERS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${filter === k}" class="${filter === k ? 'on' : ''}" data-f="${k}">${l}<span>${filterEvents(ev, k).length}</span></button>`).join('');
    $$('#sw-filter [data-f]').forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; stickBottom = true; drawFilter(); drawFeed(); }));
  };
  // 增量渲染：只追加新发言（新消息轻微进入），切换筛选或运行时整体重绘且不播放动画
  let feedKey = '', feedSeqs = [];
  const drawFeed = () => {
    const box = $('#feed'), ev = filterEvents(events(), filter).slice(-80);
    const ctx = { names, roleOf, seatOf, byId: byId(), terms, highlight: ev.at(-1)?.event_id };
    const k = `${run?.run_id}|${filter}|${reviewIdx == null ? 'live' : 'rv'}`, seqs = ev.map((e) => e.sequence);
    const prefix = k === feedKey && feedSeqs.length && feedSeqs.length <= seqs.length && feedSeqs.every((x, i) => x === seqs[i]);
    if (!ev.length) box.innerHTML = `<div class="sw-empty"><p>${ctrl ? '该类别暂无发言。' : '新建任务后，各位教师智能体会在这里围绕你的课程逐个知识点研讨：讲解、难点、思政融入、检测题与证据核查。'}</p></div>`;
    else if (prefix) {
      $$('.sw-msg.now', box).forEach((m) => m.classList.remove('now'));
      box.insertAdjacentHTML('beforeend', ev.slice(feedSeqs.length).map((e) => msgHtml(e, ctx).replace('class="sw-msg', 'class="sw-msg fresh')).join(''));
      box.querySelector(`.sw-msg[data-seq="${seqs.at(-1)}"]`)?.classList.add('now');
    } else box.innerHTML = ev.map((e) => msgHtml(e, ctx)).join('');
    feedKey = k; feedSeqs = ev.length ? seqs : [];
    if (stickBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
    drawFilter();
  };
  const drawLive = () => {
    const last = events().at(-1);
    $('#subtitle').innerHTML = streaming ? `<span class="sw-dotlive" aria-hidden="true"></span><b>${esc(names[streaming.actor_id] || streaming.actor_id)}</b> 正在发言：<span id="stream-text"></span>`
      : last ? `<span class="faint">最近：</span><b>${esc(last.actor_type === 'human' ? '你' : names[last.actor_id] || last.actor_id)}</b> · ${esc(KIND_LABEL[last.kind] || last.kind)}`
        : '<span class="faint">尚未开始研讨</span>';
  };

  // ---------- 右：任务进度 / 研讨成果 / 质询 / 编排 ----------
  const drawSide = () => {
    const nIdeo = events().filter((e) => isIdeo(e) || e.kind === 'ideology_link').length;
    $('#sw-tabs').innerHTML = [['progress', '研讨任务进度'], ['outcome', '研讨成果'], ['challenges', `质询 ${(view?.challenges || []).length || ''}`], ['plan', '进程记录']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${sideTab === k}" class="${sideTab === k ? 'on' : ''}" data-tab="${k}">${l.trim()}</button>`).join('');
    $$('#sw-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { sideTab = b.dataset.tab; drawSide(); }));
    const body = $('#side'), r = ctrl?.run;
    if (sideTab === 'progress') body.innerHTML = progressHtml({ job, run: r, plan, cursor: cursor(), working, names, seats, roles, phasesName: cat.phases, current });
    else if (sideTab === 'outcome') body.innerHTML = `${nIdeo ? `<p class="small faint" style="margin:0 0 8px">本次研讨出现课程思政相关发言 ${nIdeo} 条（按词表匹配，仅提示关注点）。</p>` : ''}${outcomeHtml(working || currentBody, terms, { roles, artifactId: r?.output_artifact_id || (!r && current?.artifact_id) })}`;
    else if (sideTab === 'challenges') body.innerHTML = (view?.challenges || []).map((c) => `<div class="sw-ch"><b>${esc(names[c.challenger] || c.challenger)}</b> → ${esc(names[c.target_actor] || c.target_actor || '')} · ${esc(c.target_ref || '')}<br><span class="small">${c.response_event_id ? '已回应' : '待回应'}${c.revision_event_id ? ' · 已修订' : ''} · 人工标记：${esc({ resolved: '已解决', partially_resolved: '部分解决', unresolved: '未解决' }[c.human_resolution] || '未标记')}</span>
      <div class="row" style="gap:4px;margin-top:4px">${[['resolved', '已解决'], ['partially_resolved', '部分'], ['unresolved', '未解决']].map(([k, l]) => `<button class="small ghost" data-res="${c.challenge_id}:${k}">${l}</button>`).join('')}</div></div>`).join('') || '<div class="sw-empty"><p>暂无质询。“交叉质询”“先协作后对抗”等研讨模式会产生质询；有回复不等于有效解决，请人工标记。</p></div>';
    else body.innerHTML = `${stageLogHtml(timeline())}<h4 class="sw-h4">组长编排</h4>` + (plan?.steps || []).map((s, i) => `<div class="sw-plan${i < cursor() ? ' done' : i === cursor() ? ' now' : ''}">${i + 1}. ${esc(roles[seats[s.seat]]?.name || '')} · ${esc(KIND_LABEL[s.kind] || s.kind)}${s.kp ? ` · ${esc((working?.knowledge || []).find((k) => k.id === s.kp)?.term || s.kp)}` : ''}${s.section ? ` · ${esc(working?.sections.find((x) => x.key === s.section)?.title || s.section)}` : ''}</div>`).join('') || '<div class="sw-empty"><p>开始研讨后显示组长编排的发言顺序。</p></div>';
    $$('[data-res]', body).forEach((b) => b.addEventListener('click', async () => { const [id, v] = b.dataset.res.split(':'); try { await post(`/api/challenges/${id}/resolve`, { resolution: v }); view = await get(`/api/runs/${run.run_id}`); drawSide(); } catch (e) { fail(e); } }));
    $$('[data-job]', body).forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.job === 'cancel' && !confirm('取消后未完成的步骤不再执行，已生成的成果保留。确定取消？')) return;
      try { job = await post(`/api/jobs/${job.job_id}/${b.dataset.job}`); if (job.status === 'running') startJobPoll(); drawAll(); } catch (e) { fail(e); }
    }));
    $('[data-act="new"]', body)?.addEventListener('click', newTask);
    $('#accept', body)?.addEventListener('click', async () => { try { const d = await post(`/api/runs/${r.run_id}/accept`); toast(`已确认为当前产物：${d.artifact.title} v${d.artifact.version}`); navigate('/seminar', true); } catch (e) { fail(e); } });
  };

  // ---------- 下：数字教研圆桌 ----------
  const agents = () => agentStates({ seats, roles, events: events(), plan, cursor: cursor(), run: ctrl?.run, streamingActor: streaming?.actor_id, challenges: view?.challenges || [] });
  const core = () => coreStatus({ run: ctrl?.run, plan, cursor: cursor(), events: events(), working, names, challenges: view?.challenges || [], job: jobActive() ? job : null });
  let introDone = false;
  const drawScene = () => {
    $('#scene').innerHTML = roundtableHtml(agents(), core());
    if (!introDone) { introDone = true; $('#scene').classList.add('intro'); setTimeout(() => $('#scene')?.classList.remove('intro'), 1400); }
    $$('#scene [data-agent]').forEach((b) => b.addEventListener('click', () => setMention(b.dataset.agent)));
  };
  // 只更新状态（避免整块重绘造成入场动画重复播放）
  const updateScene = () => {
    const list = agents(), scene = $('#scene');
    if ($$('[data-agent]', scene).length !== list.length) return drawScene();
    const html = roundtableHtml(list, core()), tmp = document.createElement('div'); tmp.innerHTML = html;
    list.forEach((a) => { const el = $(`[data-agent="${a.id}"]`, scene), nu = $(`[data-agent="${a.id}"]`, tmp); if (el && nu && el.outerHTML !== nu.outerHTML) { el.className = nu.className; el.setAttribute('aria-label', nu.getAttribute('aria-label')); el.innerHTML = nu.innerHTML; } });
    $('.sw-lines', scene).innerHTML = $('.sw-lines', tmp).innerHTML;
    $('#sw-core', scene).outerHTML = coreHtml(core());
  };

  // 研课八步进程条 + 预计完成时间
  const timeline = () => (ctrl?.run ? stageTimeline({ plan, cursor: reviewIdx == null ? view?.plan?.cursor ?? 0 : headStep(), events: events(), run: ctrl.run, phasesName: cat.phases }) : null);
  const drawStages = () => { const tl = timeline(); $('#sw-stages').innerHTML = stagesHtml(tl); const cur = tl?.list.find((x) => x.state === 'running'); $('#rf-stage').textContent = cur ? `当前：${cur.name}` : tl && tl.cur >= tl.total ? '研讨已完成' : ''; };
  // 发言动画：新发言从发言者飞向回应对象（或协同核心）
  const animateEvent = (e) => {
    const scene = $('#scene'); if (!scene) return;
    const from = e.actor_type === 'human' ? $('#sw-form') : $(`[data-agent="${e.actor_id}"]`, scene);
    const tgt = e.target_actor && $(`[data-agent="${e.target_actor}"]`, scene);
    const to = tgt || $('#sw-core', scene);
    if (e.actor_type === 'human') { const el = tgt || $('#sw-core', scene); el?.classList.add('pinged'); setTimeout(() => el?.classList.remove('pinged'), 1200); return; }
    flyPacket(scene, from, to, { kind: kindOf(e), label: KIND_LABEL[e.kind] || '' });
  };
  const drawAll = () => { drawTop(); drawLive(); drawFeed(); drawSide(); updateScene(); drawStages(); };

  // ---------- 输入区：@教师 / 引用材料 / 上传 / 发送 ----------
  const drawChips = () => { $('#sw-chips').innerHTML = mention ? `<span class="sw-chip">＠${esc(names[mention] || roles[roleOf(mention)]?.name || mention)}<button type="button" aria-label="取消 @" id="sw-unat">×</button></span>` : ''; $('#sw-unat')?.addEventListener('click', () => setMention(null)); };
  function setMention(id) {
    mention = id; drawChips();
    if (id) { const el = $(`#scene [data-agent="${id}"]`); el?.classList.add('pinged'); setTimeout(() => el?.classList.remove('pinged'), 1200); $('#sw-text').focus(); }
  }
  const closePops = () => { for (const [b, p] of [['#sw-at', '#sw-at-pop'], ['#sw-cite', '#sw-cite-pop']]) { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); } };
  $('#sw-at').addEventListener('click', (e) => {
    e.stopPropagation(); const pop = $('#sw-at-pop'), open = pop.hidden; closePops(); if (!open) return;
    pop.innerHTML = seats.map((r, i) => `<button type="button" role="menuitem" data-m="M${i}">＠${esc(names[`M${i}`] || roles[r]?.name || r)}<small>${esc(roles[r]?.duty || '')}</small></button>`).join('');
    pop.hidden = false; $('#sw-at').setAttribute('aria-expanded', 'true');
    $$('[data-m]', pop).forEach((b) => b.addEventListener('click', () => { setMention(b.dataset.m); closePops(); }));
  });
  $('#sw-cite').addEventListener('click', async (e) => {
    e.stopPropagation(); const pop = $('#sw-cite-pop'), open = pop.hidden; closePops(); if (!open) return;
    let mats = []; try { mats = (await get('/api/materials')).materials; } catch { /* ignore */ }
    pop.innerHTML = mats.length ? mats.slice(0, 12).map((m) => `<button type="button" role="menuitem" data-cite="${esc(m.filename)}">《${esc(m.filename)}》<small>${esc(m.kind_name)} · ${m.n_chars} 字</small></button>`).join('') : '<p class="small faint" style="margin:6px">还没有课程材料，可点“上传材料”。</p>';
    pop.hidden = false; $('#sw-cite').setAttribute('aria-expanded', 'true');
    $$('[data-cite]', pop).forEach((b) => b.addEventListener('click', () => { const t = $('#sw-text'); t.value = `${t.value}${t.value && !/\s$/.test(t.value) ? ' ' : ''}依据《${b.dataset.cite}》`; t.focus(); closePops(); }));
  });
  document.addEventListener('click', closePops);
  $('#sw-file').addEventListener('change', async (ev) => {
    for (const f of ev.target.files) {
      if (f.size > 15 * 1024 * 1024) { fail(new Error(`${f.name} 超过 15MB`)); continue; }
      const data_base64 = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(f); });
      try { const mt = await post('/api/materials', { filename: f.name, kind: 'courseware', data_base64 }); toast(`已加入课程材料《${mt.filename}》（${mt.n_chars} 字）${Object.keys(mt.pii_flags || {}).length ? '，个人信息已自动隐去' : ''}；新建任务时可选用，也可在发言中引用`); } catch (e) { fail(e); }
    }
    ev.target.value = '';
  });
  // 输入期间让出发言权（服务端最长保留 2 分钟），发送或清空后交还
  const setComposing = async (on) => {
    if (on === composing || !run || !['running', 'awaiting_human'].includes(ctrl?.run?.status)) { if (!on) composing = false; return; }
    composing = on;
    try { ctrl.run = await post(`/api/runs/${run.run_id}/composer`, { open: on }); } catch { /* run moved on */ }
  };
  $('#sw-text').addEventListener('input', (e) => { e.target.style.height = 'auto'; e.target.style.height = `${Math.min(120, e.target.scrollHeight)}px`; if (e.target.value.trim()) setComposing(true); if (e.target.value.endsWith('@')) { $('#sw-at').click(); } });
  $('#sw-text').addEventListener('blur', (e) => { if (!e.target.value.trim()) setComposing(false); });
  $('#sw-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#sw-form').requestSubmit(); } });
  $('#sw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('#sw-text').value.replace(/@$/, '').trim(); if (!text) return;
    if (!ctrl || !(runActive() || jobActive())) return toast('当前没有进行中的研讨，请先新建任务', true);
    $('#sw-send').disabled = true;
    try {
      const ev = await post(`/api/runs/${run.run_id}/human`, { text, kind: $('#sw-kind').value, target_actor: mention, idempotency_key: key('human') });
      ctrl.add(ev, true); $('#sw-text').value = ''; $('#sw-text').style.height = ''; stickBottom = true;
      toast(mention ? `已发言，${names[mention] || '被 @ 的教师'}将在下一步回应` : '已发言，教研组将回应');
      setMention(null); await setComposing(false); drawAll();
    } catch (err) { fail(err); } finally { $('#sw-send').disabled = false; drawTop(); }
  });
  $('#feed').addEventListener('scroll', () => { const b = $('#feed'); stickBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 40; });

  // ---------- 底部快捷工具 ----------
  $$('[data-dock]').forEach((b) => b.addEventListener('click', async () => {
    const k = b.dataset.dock;
    if (k === 'import') return $('#new-run').click();
    if (k === 'export') return navigate('/export');
    if (k === 'map') {
      try { const a = (await get('/api/artifacts?module=seminar')).artifacts.find((x) => x.type === 'knowledge_map'); if (a) navigate(`/library?id=${a.artifact_id}`); else toast('还没有知识点图谱：新建任务时会自动整理生成', true); } catch (e) { fail(e); }
      return;
    }
    if (k === 'lib') return modal({ title: '思政元素参考库', wide: true, body: `<p class="small muted" style="margin-top:0">只提供思考框架与引导问题，不收录政策原文；实际融入点由教研组结合课程内容逐个知识点研讨确定。</p><div class="grid2">${cat.ideology_library.map((g) => `<div class="hx-lib"><b>${esc(g.name)}</b><div class="row" style="gap:4px;margin:6px 0">${g.elements.map((x) => `<span class="badge">${esc(x)}</span>`).join('')}</div><ul>${g.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>`).join('')}</div>` });
    if (k === 'transfer') {
      if (!current) return toast('研课场还没有当前产物：请先完成研讨并确认为当前产物', true);
      return doTransfer('seminar', current, () => navigate('/classroom'));
    }
  }));
  $('#sw-join').addEventListener('click', () => { const t = $('#sw-text'); t.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); t.focus(); if (!(runActive() || jobActive())) toast('开始任务后即可参与研讨；可以先 @ 一位教师，或直接输入你的观点', false); });

  // ---------- 任务轮询：跟随服务端任务的当前研讨 ----------
  function startJobPoll() {
    clearInterval(jobTimer);
    jobTimer = setInterval(async () => {
      if (!job) return;
      try {
        job = await get(`/api/jobs/${job.job_id}`);
        if (job.current_run_id && job.current_run_id !== run?.run_id) {
          const v = await get(`/api/runs/${job.current_run_id}`);
          if (v.run.module === 'seminar') await attach(v.run, true);
        }
        drawTop(); if (sideTab === 'progress') drawSide(); updateScene();
        if (!jobActive()) { clearInterval(jobTimer); if (job.status === 'completed') toast('任务已全部完成，成果已保存到产物库'); }
      } catch { /* transient */ }
    }, 1000);
  }
  async function newTask() {
    await openTaskWizard(cat, { openAdvanced: setup, onStarted: (j) => { job = j; sideTab = 'progress'; drawAll(); startJobPoll(); } });
  }

  const attach = async (r, watch = false) => {
    ctrl?.dispose();
    run = r; streaming = null; stickBottom = true; reviewIdx = null; ffTarget = null;
    ctrl = createController({ runId: r.run_id, refreshMe, hooks: {
      onLoad: (v) => { view = v; terms = v.ideology_terms || []; plan = v.plan; working = v.working_body; names = Object.fromEntries(v.profiles.map((p) => [p.agent_id, p.name])); const cfg = v.run.config; if (cfg.seats) { seats = cfg.seats; shape = cfg.table_shape || 'oval'; } },
      onStart: (d) => { streaming = { actor_id: d.actor_id, kind: d.kind }; drawLive(); updateScene(); },
      onDelta: (d) => { const s = $('#stream-text'); if (s) s.textContent += d.delta; },
      onEvent: (e, live) => { if (live) { streaming = null; drawLive(); drawFeed(); updateScene(); drawStages(); if (reviewIdx == null) animateEvent(e); } },
      onFinal: async () => { view = await get(`/api/runs/${run.run_id}?after=${ctrl.lastSeq}`); plan = view.plan; working = view.working_body; ctrl.run = view.run; drawSide(); drawTop(); updateScene(); },
      onResync: (v) => { view = { ...view, ...v }; plan = v.plan; working = v.working_body; drawSide(); drawTop(); updateScene(); },
      onState: () => { drawTop(); drawSide(); updateScene(); },
      onPlay: () => drawTop(),
      onModelError: (d) => toast(`${d.message}（未扣分）。可在页面顶部改选「模拟演示」后新建任务。`, true),
      onEnd: () => toast('研讨已完成，已整合为草稿，请审阅后确认'),
    } });
    await ctrl.load();
    if (ctrl.run.status === 'awaiting_human' && !$('#sw-text').value.trim()) { try { ctrl.run = await post(`/api/runs/${r.run_id}/composer`, { open: false }); } catch { /* not ours to close */ } }
    if (watch || (job && job.current_run_id === r.run_id && jobActive())) ctrl.watch();
    drawScene(); drawAll();
  };

  async function setup() {
    const custom = (await get('/api/custom-modes')).modes;
    let mats = (await get('/api/materials')).materials;
    const chosen = new Set();
    const types = cat.artifact_types.filter((t) => !t.system_only);
    const GROUPS = [['专业层面', ['talent_plan']], ['课程层面', ['course_design', 'syllabus', 'semester_plan', 'teaching_schedule']], ['课堂层面', ['lesson_plan', 'courseware']], ['评价层面', ['exercises', 'exam', 'reflection_report']]];
    const ref = current ? await get(`/api/artifacts/${current.artifact_id}`).catch(() => null) : null;
    let lastCourse = {}; try { lastCourse = JSON.parse(localStorage.getItem('yz-course') || '{}'); } catch { /* ignore */ }
    const course = { ...lastCourse, ...(ref?.artifact.body.course || {}) };
    const defType = ref && types.some((t) => t.key === ref.artifact.type) ? ref.artifact.type : 'lesson_plan';
    const fwFields = (k) => (cat.frameworks.find((f) => f.key === k)?.fields || []).map(([fk, l, ph]) => `<label>${esc(l)}<input data-ff="${fk}" placeholder="${esc(ph || '')}"></label>`).join('');
    const EXAMPLE = { name: '机械质量检测', major: '机械制造及其自动化', audience: '大二本科', hours: 32, weeks: 16, prereq: '机械制图、公差与配合基础', unit: '零件尺寸检测与放行判断',
      goal_knowledge: '掌握尺寸公差、测量误差与放行判定方法', goal_ability: '能依据检测数据与规程作出有依据的放行或复检决定', goal_value: '在成本与安全冲突时坚持质量责任，理解检测数据真实性的职业要求',
      ideology_elements: '工程责任、质量意识、诚信、公共安全', cases: '某车企零部件质量问题召回案例（来源：待核查）', links: '测量误差分析；抽样检验', activities: '案例研讨、角色扮演（检验员/生产主管）', criteria: '判断依据完整、价值理由充分' };
    const matList = () => mats.length ? mats.map((m) => `<label class="inline small" style="display:flex;gap:6px;align-items:flex-start;margin:3px 0"><input type="checkbox" data-mat="${m.material_id}" ${chosen.has(m.material_id) ? 'checked' : ''}><span><b>${esc(m.filename)}</b> <span class="badge">${esc(m.kind_name)}</span> <span class="faint">${m.n_chars} 字</span>${Object.keys(m.pii_flags || {}).length ? ` <span class="badge warn" title="已在使用前自动隐去">检出个人信息：${Object.entries(m.pii_flags).map(([k, v]) => `${k}${v}`).join('、')}（已隐去）</span>` : ''}<br><span class="faint">${esc(m.preview.slice(0, 80))}…</span></span><button type="button" class="small ghost" data-delmat="${m.material_id}" aria-label="删除材料">✕</button></label>`).join('') : '<span class="faint small">尚未上传材料。可上传人才培养方案、教学大纲、学期教学设计、课程教学设计、教学计划进度表、课件、习题试卷等。</span>';
    const body = `<div class="grid3">
      <label>研讨对象（输出什么）<select id="s-type">${GROUPS.map(([g, ks]) => `<optgroup label="${g}">${ks.map((k) => types.find((t) => t.key === k)).filter(Boolean).map((t) => `<option value="${t.key}" ${t.key === defType ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label>课时长度（输出内容按此编排）<select id="s-min">${cat.lesson_minutes.map((m) => `<option value="${m}" ${Number(course.lesson_minutes || 45) === m ? 'selected' : ''}>${m} 分钟</option>`).join('')}</select></label>
      <label>研讨模式（怎样讨论）<select id="s-mode">${Object.entries(cat.modes).map(([k, m]) => `<option value="${k}">${esc(m.name)}</option>`).join('')}${custom.map((m) => `<option value="custom:${m.mode_id}">自定义：${esc(m.name)}</option>`).join('')}</select></label>
      <label>教学设计框架<select id="s-fw"><option value="">不使用框架</option>${cat.frameworks.map((f) => `<option value="${f.key}" ${f.key === 'boppps' ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
      <label>标题<input id="s-title" placeholder="如：零件放行判断·单课教案"></label>
      <label>参考产物（可选，如导入的课堂反馈）<select id="s-ref"><option value="">不参考</option>${ref ? `<option value="${ref.artifact.artifact_id}" selected>${esc(ref.artifact.title)} · ${esc(TYPE_NAME[ref.artifact.type] || '')} v${ref.artifact.version}</option>` : ''}</select></label></div>
      <div class="row" style="margin-top:6px"><label class="inline"><input type="checkbox" id="s-pdca"> 主框架 + PDCA 改进循环</label><span class="small faint" id="fw-note"></span><span class="grow"></span><button class="small ghost" type="button" id="s-custom">管理自定义模式</button></div>
      <div class="grid3" id="s-ff" style="margin-top:6px"></div>
      <fieldset class="panel" style="margin-top:10px;padding:12px;box-shadow:none"><legend class="small" style="color:var(--gold);padding:0 6px">研讨材料（可多选；教研组先研读，起草时引用并注明出处）</legend>
        <div class="row"><select id="up-kind" style="width:auto">${Object.entries(cat.material_kinds).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
        <label class="inline" style="cursor:pointer"><span class="badge gold" style="padding:6px 12px">⬆ 上传 DOCX / PPTX / XLSX / TXT</span><input type="file" id="up-file" multiple accept=".docx,.pptx,.xlsx,.txt,.md,.csv" hidden></label>
        <span class="small faint">PDF、旧版 .doc/.ppt 请先另存为 DOCX/PPTX；只保存提取的文字；请勿上传含学生个人信息的文件（系统会检测并自动隐去手机号、身份证号、学号、邮箱）。</span></div>
        <div id="mat-list" style="margin-top:8px;max-height:180px;overflow:auto">${matList()}</div></fieldset>
      <details class="more" open><summary>课程思政共用输入</summary><div class="row" style="margin:4px 0 8px"><button type="button" class="small" id="s-example">填入示例课程</button><span class="small faint">引用政策、标准或案例请注明来源；没有来源将标记“待核查”，不编造政策条文或文献。</span></div>
        <div class="grid3">${cat.course_fields.filter(([k]) => k !== 'lesson_minutes').map(([k, l, req, t]) => `<label>${esc(l)}${req ? ' *' : ''}<input data-c="${k}" ${t === 'number' ? 'inputmode="numeric"' : ''} value="${esc(course[k] ?? '')}"></label>`).join('')}</div>
        <details style="margin-top:8px"><summary class="small" style="cursor:pointer;color:var(--gold)">思政元素参考库（点击元素加入“思政元素”；只提供思考框架，不收录政策原文）</summary>
          <div class="grid2" style="margin-top:6px">${cat.ideology_library.map((g) => `<div class="small" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px"><b style="color:var(--ideo-strong)">${esc(g.name)}</b><div class="row" style="gap:4px;margin:4px 0">${g.elements.map((e) => `<button type="button" class="small" data-elem="${esc(e)}">${esc(e)}</button>`).join('')}</div><div class="faint">引导：${g.questions.map(esc).join(' ／ ')}</div></div>`).join('')}</div></details></details>
      <div class="small" style="margin:10px 0 4px;color:var(--gold)">运行方式</div>${modeCards(cat, 's-exec')}
      <div class="grid3"><label>质询段落数<input id="s-ch" type="number" min="1" max="6" value="3"></label><label>真人介入回应预算（次）<input id="s-hb" type="number" min="0" max="10" value="3"></label>
        <label title="学情分析以导入的匿名班级画像统计为依据；不选则学情分析留待补充，不会编造学情">学情依据（班级画像）<select id="s-cp"><option value="">未导入 · 学情留待补充</option>${(cat.class_profiles || []).map((p) => `<option value="${p.profile_id}">${esc(p.name)}（${p.n} 人）</option>`).join('')}</select></label></div>
      <div class="estimate" id="s-est" style="margin-top:10px">…</div>
      <p class="small faint">席位：${seats.map((r, i) => `${roles[r].name}${i === 0 ? '（主位）' : ''}`).join('、')}（可在页面顶部调整桌形与席位）</p>`;
    const collect = (m) => {
      const mode = $('#s-mode', m).value;
      const c = {}; $$('[data-c]', m).forEach((el) => { if (el.value !== '') c[el.dataset.c] = el.value; });
      c.lesson_minutes = Number($('#s-min', m).value);
      const ff = {}; $$('[data-ff]', m).forEach((el) => { ff[el.dataset.ff] = el.value; });
      return { module: 'seminar', exec_mode: modeVal($('#s-exec', m)), type: $('#s-type', m).value, framework_key: $('#s-fw', m).value || null, with_pdca: $('#s-pdca', m).checked,
        mode: mode.startsWith('custom:') ? 'cooperate' : mode, custom_mode_id: mode.startsWith('custom:') ? mode.slice(7) : undefined, course: c, framework_fields: ff,
        title: $('#s-title', m).value, reference_artifact_id: $('#s-ref', m).value || null, seats, table_shape: shape, challenge_limit: Number($('#s-ch', m).value), human_reply_budget: Number($('#s-hb', m).value),
        material_ids: [...chosen], class_profile_id: $('#s-cp', m).value || undefined };
    };
    const res = await modal({ title: '新建研讨', wide: true, body,
      onMount: (m) => {
        const upd = async () => {
          const fw = $('#s-fw', m).value; const keep = Object.fromEntries($$('[data-ff]', m).map((el) => [el.dataset.ff, el.value]));
          $('#s-ff', m).innerHTML = fwFields(fw); $$('[data-ff]', m).forEach((el) => { if (keep[el.dataset.ff]) el.value = keep[el.dataset.ff]; });
          $('#fw-note', m).textContent = cat.frameworks.find((f) => f.key === fw)?.note || '';
          try { const e = await post('/api/runs/estimate', collect(m)); $('#s-est', m).innerHTML = `${chosen.size ? `先研读 ${chosen.size} 份材料；` : ''}${e.exec_mode === 'model' ? `预计最多 <b>${e.max_calls}</b> 次调用，最多 <b>${e.max_credits}</b> 积分（费率 ${e.rate}/次；含真人回应预算）· 当前可用 ${e.balance.available}${e.capped ? ' · 已按单任务上限截断' : ''}` : `本地生成：${e.steps} 步编排，不调用大模型，不消耗积分`} · 输出按 ${$('#s-min', m).value} 分钟课时编排`; }
          catch (e) { $('#s-est', m).textContent = e.message; }
        };
        const bindMats = () => {
          $$('[data-mat]', m).forEach((cb) => cb.addEventListener('change', () => { cb.checked ? chosen.add(cb.dataset.mat) : chosen.delete(cb.dataset.mat); upd(); }));
          $$('[data-delmat]', m).forEach((b) => b.addEventListener('click', async (ev) => { ev.preventDefault(); try { await del(`/api/materials/${b.dataset.delmat}`); chosen.delete(b.dataset.delmat); mats = mats.filter((x) => x.material_id !== b.dataset.delmat); $('#mat-list', m).innerHTML = matList(); bindMats(); upd(); } catch (e) { fail(e); } }));
        };
        $('#up-file', m).addEventListener('change', async (ev) => {
          for (const f of ev.target.files) {
            if (f.size > 15 * 1024 * 1024) { fail(new Error(`${f.name} 超过 15MB`)); continue; }
            const data_base64 = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(f); });
            try {
              const mt = await post('/api/materials', { filename: f.name, kind: $('#up-kind', m).value, data_base64 });
              mats.unshift(mt); chosen.add(mt.material_id);
              toast(`已读取《${mt.filename}》${mt.n_chars} 字${Object.keys(mt.pii_flags || {}).length ? '，检出个人信息已自动隐去' : ''}`);
            } catch (e) { fail(e); }
          }
          ev.target.value = ''; $('#mat-list', m).innerHTML = matList(); bindMats(); upd();
        });
        $('#s-example', m).addEventListener('click', () => { for (const [k, v] of Object.entries(EXAMPLE)) { const el = $(`[data-c="${k}"]`, m); if (el) el.value = v; } if (!$('#s-title', m).value) $('#s-title', m).value = '零件放行判断·课程思政设计'; upd(); });
        $$('[data-elem]', m).forEach((b) => b.addEventListener('click', () => { const el = $('[data-c="ideology_elements"]', m); const cur = el.value.split(/[、,，]/).map((x) => x.trim()).filter(Boolean); if (!cur.includes(b.dataset.elem)) cur.push(b.dataset.elem); el.value = cur.join('、'); b.classList.add('gold'); }));
        bindModeCards($('#s-exec', m), syncTopMode);
        ['#s-type', '#s-fw', '#s-mode', '#s-exec', '#s-pdca', '#s-ch', '#s-hb', '#s-ref', '#s-min'].forEach((s) => $(s, m).addEventListener('change', upd));
        $('#s-custom', m).addEventListener('click', manageModes);
        bindMats(); upd();
      },
      buttons: [{ label: '取消', value: null }, { label: '创建并开始', cls: 'primary', handler: async (m) => { const b = collect(m); try { localStorage.setItem('yz-course', JSON.stringify(b.course)); } catch { /* ignore */ } return post('/api/runs', b); } }] });
    if (!res) return;
    await attach(res);
    ctrl.play();
  }

  async function manageModes() {
    const list = (await get('/api/custom-modes')).modes;
    const seq = [];
    await modal({ title: '自定义研讨模式', body: `<p class="small muted">按顺序点击阶段组成模式（组长整合自动放在最后）。可保存多个模板。</p>
      <div class="row" style="gap:4px">${Object.entries(cat.phases).map(([k, l]) => `<button class="small" data-ph="${k}">${esc(l)}</button>`).join('')}</div>
      <p id="seq" class="small" style="min-height:20px;color:var(--gold)"></p><label>名称<input id="mn"></label>
      <h4 style="margin-top:12px;font-size:calc(13px * var(--fs))">已保存（${list.length}）</h4>${list.map((m) => `<div class="row small"><b>${esc(m.name)}</b><span class="faint">${m.phases.map((p) => cat.phases[p]).join(' → ')}</span><span class="grow"></span><button class="small ghost" data-delmode="${m.mode_id}">删除</button></div>`).join('') || '<span class="faint small">暂无</span>'}`,
      onMount: (m) => {
        $$('[data-ph]', m).forEach((b) => b.addEventListener('click', () => { seq.push(b.dataset.ph); $('#seq', m).textContent = seq.map((p) => cat.phases[p]).join(' → '); }));
        $$('[data-delmode]', m).forEach((b) => b.addEventListener('click', async () => { await del(`/api/custom-modes/${b.dataset.delmode}`); b.closest('.row').remove(); }));
      },
      buttons: [{ label: '关闭', value: null }, { label: '保存模式', cls: 'primary', handler: async (m) => { await post('/api/custom-modes', { name: $('#mn', m).value, phases: seq }); toast('已保存，重新打开“新建研讨”后可选择'); } }] });
  }

  // ---------- controls ----------
  $('#new-run').addEventListener('click', async () => {
    if (jobActive()) { toast('当前任务尚未结束：可先暂停或取消', true); return; }
    if (ctrl?.run && ['running', 'awaiting_human'].includes(ctrl.run.status) && !ctrl.watching) { toast('请先暂停或结束当前研讨', true); return; }
    newTask();
  });
  // ---------- 播放器条：开始/继续 · 暂停 · 结束 · 回退 · 快进 · 进度条（回看 / 快进） ----------
  const phaseMarks = () => { const st = plan?.steps || [], wk = working?.knowledge || []; const out = []; st.forEach((x, i) => { if (i && x.phase !== st[i - 1].phase) out.push({ at: i, label: cat.phases[x.phase] || x.phase }); else if (i && x.kp && x.kp !== st[i - 1].kp) out.push({ at: i, label: `知识点「${wk.find((k) => k.id === x.kp)?.term || x.kp}」`, minor: true }); }); return out; };
  function drawPlayerState() {
    const r = ctrl?.run, act = runActive(), J = jobActive(), total = totalSteps(), head = headStep();
    const st = (plan?.steps || [])[Math.min(head, Math.max(0, total - 1))];
    const kp = st?.kp && (working?.knowledge || []).find((k) => k.id === st.kp);
    const state = !r && !J ? 'idle' : ffTarget != null ? 'ff' : reviewIdx != null ? 'review' : J ? (job.status === 'running' ? 'job' : 'paused') : r && ['completed', 'cancelled', 'failed'].includes(r.status) ? 'ended' : ctrl.playing ? 'live' : 'paused';
    drawPlayer(root, {
      playLabel: reviewIdx != null ? '回到实时' : J ? '继续任务' : act ? (r.status === 'ready' ? '开始研讨' : '继续研讨') : '新建任务',
      canPlay: reviewIdx != null ? true : J ? job.status !== 'running' : !act || (!ctrl.playing && ffTarget == null),
      canPause: J ? job.status === 'running' : !!(ctrl?.playing || ffTarget != null),
      canEnd: J || !!act, endLabel: J ? '结束任务' : '结束研讨',
      canBack: !!r && (ctrl.events.length > 0) && head > 0,
      canFwd: !!r && ffTarget == null && (reviewIdx != null || (!!act && !J)),
      total: r ? total : 0, live: r ? liveStep() : 0, head: r ? head : 0, marks: phaseMarks(),
      timeText: r ? `第 ${head}/${total} 步` : '尚未开始', stageText: st && r ? `${cat.phases[st.phase] || st.phase}${kp ? ` · 「${kp.term}」` : ''}` : '',
      state,
    });
  }
  async function review(step) {
    if (!ctrl?.run) return;
    ffTarget = null;
    if (ctrl.playing) await ctrl.pause();
    const ev = ctrl.events; let i = -1, n = 0; const h = new Set();
    for (let k = 0; k < ev.length; k++) { const e = ev[k]; if (e.actor_type === 'human') h.add(e.event_id); else if (!(e.reply_to && h.has(e.reply_to))) n++; if (n > step) break; i = k; }
    reviewIdx = step >= liveStep() ? null : i;
    stickBottom = true; drawAll();
  }
  async function fastForward(step) {
    if (jobActive()) return toast('任务自动执行中：可以回看已发生的研讨，不能快进', true);
    if (!runActive()) return toast('本次研讨已结束，无法快进', true);
    if (ctrl.run.exec_mode === 'model' && !(await confirmBox('快进', '<p>快进会连续调用大模型生成教师发言，按成功调用扣积分。继续吗？</p>', '继续快进'))) return;
    reviewIdx = null;
    if (ctrl.playing) await ctrl.pause();
    ffTarget = Math.min(step, totalSteps()); drawAll();
    while (ffTarget != null && (view?.plan?.cursor ?? 0) < ffTarget && runActive() && !ctrl.stopped) {
      const r = await ctrl.single();
      if (r === 'end' || r === 'error') break;
      if (r === 'busy') await new Promise((ok) => setTimeout(ok, 150));
    }
    ffTarget = null;
    if (runActive() && !ctrl.playing) await ctrl.pause(); // 快进停在目标位置：服务端也记为暂停
    drawAll();
  }
  bindPlayer(root, {
    total: () => (ctrl?.run ? totalSteps() : 0), format: (v) => { const i = Math.round(v), st = (plan?.steps || [])[Math.min(i, totalSteps() - 1)]; return `第 ${i} 步${st ? ` · ${cat.phases[st.phase] || st.phase}` : ''}`; },
    seek: (v) => { const t = Math.round(v); if (!ctrl?.run) return; if (t <= liveStep()) review(t); else fastForward(t); },
    back: () => { const h = headStep(), t = [0, ...phaseMarks().map((m) => m.at)].reverse().find((a) => a < h) ?? 0; review(t); },
    fwd: () => { const h = headStep(), t = phaseMarks().map((m) => m.at).find((a) => a > h) ?? totalSteps(); if (reviewIdx != null && t < liveStep()) review(t); else if (reviewIdx != null) { reviewIdx = null; drawAll(); } else fastForward(t); },
    play: async () => {
      if (reviewIdx != null) { reviewIdx = null; drawAll(); if (!jobActive() && runActive() && !ctrl.playing) ctrl.play(); return; }
      if (jobActive()) { try { job = await post(`/api/jobs/${job.job_id}/resume`); startJobPoll(); drawAll(); } catch (e) { fail(e); } return; }
      if (!runActive()) return newTask();
      if (!ctrl.playing) ctrl.play();
    },
    pause: async () => {
      ffTarget = null;
      if (jobActive()) { try { job = await post(`/api/jobs/${job.job_id}/pause`); drawAll(); } catch (e) { fail(e); } return; }
      if (ctrl?.playing) await ctrl.pause();
      drawTop();
    },
    end: async () => {
      if (jobActive()) {
        if (!(await confirmBox('结束任务', '<p>结束后未完成的步骤不再执行，已生成的成果保留在产物库。确定结束？</p>', '结束任务', 'danger'))) return;
        try { job = await post(`/api/jobs/${job.job_id}/cancel`); drawAll(); } catch (e) { fail(e); } return;
      }
      if (!runActive()) return;
      if (!(await confirmBox('结束研讨', '<p>结束本次研讨？已完成的发言与段落会保留，并整合为草稿。</p>', '结束研讨'))) return;
      ffTarget = null; reviewIdx = null; await ctrl.finish(); drawAll();
    },
  });
  function syncTopMode() { const el = $('#mode-top'), v = localStorageMode(); if (!el) return; el.dataset.value = v; $$('[data-mode]', el).forEach((x) => { x.classList.toggle('on', x.dataset.mode === v); x.setAttribute('aria-checked', String(x.dataset.mode === v)); }); }
  function localStorageMode() { try { return localStorage.getItem('yz-exec-mode') === 'model' && cat.model_available ? 'model' : 'demo'; } catch { return 'demo'; } }
  bindModeCards($('#mode-top'), (v) => toast(v === 'model' ? '已选择：大模型 API 运行（按成功调用扣积分），新建任务时生效' : '已选择：模拟演示（不扣积分），新建任务时生效'));
  const save = () => { try { localStorage.setItem('yz-seats', JSON.stringify({ v: 2, seats, shape })); } catch { /* ignore */ } };
  const onKey = (e) => { if (e.target.closest('input,textarea,select')) return; if (e.key === ' ') { e.preventDefault(); const b = !$('#pl-pause').disabled ? $('#pl-pause') : $('#pl-play'); if (!b.disabled) b.click(); } };
  document.addEventListener('keydown', onKey);

  const applySimple = (on) => { document.body.classList.toggle('sw-simple', on); const b = $('#sw-simple'); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '完整视图' : '简洁视图'; b.title = on ? '显示下方的数字教研会议室与研讨进程条' : '只保留研讨对话、任务进度和播放器，隐藏下方会议室'; };
  applySimple(simplePref());
  $('#sw-simple').addEventListener('click', () => { const on = !document.body.classList.contains('sw-simple'); try { localStorage.setItem('yz-sw-simple', on ? '1' : '0'); } catch { /* storage unavailable */ } applySimple(on); if (!on) drawScene?.(); });
  if (pick) await attach(pick); else { drawScene(); drawAll(); }
  if (query.play && pick && ['ready', 'paused'].includes(pick.status)) ctrl?.play?.();
  // 课堂反馈已带回（例如用首页 ← 箭头），但还没开始修订：给出一键修订入口
  if (current?.type === 'classroom_feedback' && !runActive() && !jobActive()) {
    const bar = document.createElement('div'); bar.className = 'fb-back';
    bar.innerHTML = `<span>课堂反馈《${esc(current.title)}》已带回研课场。</span><button class="primary" id="fb-revise">依据这份反馈修订原产物 →</button>`;
    root.querySelector('.sw-player')?.before(bar);
    $('#fb-revise').addEventListener('click', async () => {
      try { const r = await post('/api/revise-from-feedback', { exec_mode: modeVal($('#mode-top')) }); toast(`开始依据反馈修订《${r.base.title}》`); navigate(`/seminar?run=${r.run_id}&play=1`); } catch (e) { fail(e); }
    });
  }
  drawChips();
  if (job?.status === 'running') startJobPoll();
  tour('seminar', [
    { sel: '.sw-talk', place: 'right', title: '多智能体研讨区', text: '各位教师智能体按分工发言，并互相回应、质询、核查；课程思政与证据提醒会以标签标出，可用上方筛选。' },
    { sel: '.sw-side', place: 'left', title: '研讨任务进度', text: '显示真实的“已完成步数/总步数”和当前环节；“研讨成果”页实时呈现教学目标与思政要点。' },
    { sel: '#scene', place: 'top', title: '数字教研圆桌', text: '谁在发言、谁在思考、谁发现了证据缺口，一目了然；点击教师即可 @ 他/她。' },
    { sel: '#sw-form', place: 'top', title: '你也是教研团队成员', text: '随时输入观点或 @ 某位智能教师，被点名的教师会在下一步回应；输入期间研讨会暂时让出发言权。' },
    { sel: '#new-run', place: 'bottom', title: '新建任务', text: '导入讲义、大纲、课件等课程内容，选择要生成的成果和课时，系统自动执行；可随时暂停与继续。' },
  ]);
  const stgTimer = setInterval(() => { if (ctrl?.run?.status === 'running' || jobActive()) drawStages(); }, 1000);
  return () => { clearInterval(stgTimer); ctrl?.dispose(); clearInterval(jobTimer); document.removeEventListener('keydown', onKey); document.removeEventListener('click', closePops); document.body.classList.remove('is-sw'); if (composing && run) post(`/api/runs/${run.run_id}/composer`, { open: false }).catch(() => {}); };
}
