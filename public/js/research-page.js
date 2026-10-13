// 科研数据中心（/research）：研究项目 → 被试与知情同意 → 量表与测试 → 话语编码 → 评分一致性 → 数据包导出。
// 只呈现研究者实际采集/导入的数据与据此计算的指标；空白处如实显示“尚无数据”。
import { get, post, put, del, downloadPost } from './api.js';
import { esc, $, $$, toast, fail, modal, confirmBox, fmtTime, MODULE_NAME, TYPE_NAME } from './ui.js';
import { ioButtons, bindIo, openImport } from './smart-io.js';

const TABS = [['overview', '研究设计'], ['participants', '被试与知情同意'], ['instruments', '量表与测试'], ['coding', '话语编码'], ['irr', '评分一致性'], ['export', '数据包导出']];
const ST = { ok: ['✓', 'green'], warn: ['!', 'warn'], todo: ['○', 'red'], na: ['–', ''] };
const SRC = { validated: 'green', adapted: 'cyan', self_developed: 'warn', placeholder: 'red' };
const num = (x, d = 3) => (x == null ? '—' : Number(x).toFixed(d));

export async function renderResearch(root, { navigate, query }) {
  const meta = await get('/api/research/meta');
  let projects = (await get('/api/research/projects')).projects;
  const pid = query.p && projects.some((p) => p.project_id === query.p) ? query.p : projects[0]?.project_id;
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : 'overview';
  const go = (p, t = tab, extra = '') => navigate(`/research?p=${p || ''}&tab=${t}${extra}`, true);
  root.innerHTML = `<div class="rs-page"><aside class="rs-side panel"><div class="row"><h2 style="margin:0">研究项目</h2><span class="grow"></span><button class="small primary" id="rs-new">＋ 新建</button></div>
      <div class="rs-quick"><button class="small" data-link="/rating">人工评分（可盲评）</button><button class="small" data-link="/export">平台过程数据导出</button></div>
      <div class="rs-plist">${projects.map((p) => `<button class="rs-pitem ${p.project_id === pid ? 'on' : ''}" data-p="${p.project_id}"><b>${esc(p.title)}</b><span class="small faint">${esc(p.code)} · ${esc(p.field || '')} · ${p.n_participants} 名被试</span></button>`).join('') || '<div class="small faint">还没有研究项目</div>'}</div>
      <p class="small faint rs-note">科研数据中心用于管理你<b>实际采集</b>的研究数据：被试、问卷量表、测试、访谈/课堂转录编码、评分。平台不生成、不补齐任何研究数据；模拟智能体产生的对话只能作为“平台过程”数据，并在导出中标注。</p></aside>
    <section class="rs-main" id="rs-main">${pid ? '' : `<div class="panel rs-empty"><h2>从一个研究项目开始</h2><p class="muted">把研究问题、研究设计、组别与时间点、伦理信息写清楚后，被试、量表、测试和编码数据都挂在项目下，导出时自动带上组别与时间点，并生成 SPSS / R 可直接读取的数据包。</p><button class="primary" id="rs-new2">新建研究项目</button></div>`}</section></div>`;
  const newProject = async () => {
    const v = await modal({ title: '新建研究项目', body: `<div style="display:grid;gap:10px"><label>研究题目 *<input id="np-t" placeholder="如：多智能体数字教研对教师课程思政教学设计能力的影响"></label>
      <div class="grid2"><label>项目编码<input id="np-c" placeholder="如 CSR2026（字母数字）"></label><label>学科领域<select id="np-f">${meta.fields.map((f) => `<option>${esc(f)}</option>`).join('')}</select></label></div>
      <label>研究设计<select id="np-d">${Object.entries(meta.designs).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
      <p class="small faint">组别、时间点、伦理信息等可在创建后的“研究设计”页补充。</p></div>`,
    buttons: [{ label: '取消', value: null }, { label: '创建', cls: 'primary', handler: (m) => post('/api/research/projects', { title: $('#np-t', m).value, code: $('#np-c', m).value, body: { field: $('#np-f', m).value, design: $('#np-d', m).value,
      conditions: [{ code: 'EXP', label: '实验组' }, { code: 'CTL', label: '对照组' }].filter(() => ['quasi_prepost', 'rct'].includes($('#np-d', m).value)), timepoints: [{ code: 'T0', label: '前测' }, { code: 'T1', label: '后测' }].filter(() => !['case', 'content'].includes($('#np-d', m).value)) } }) }] });
    if (v?.project) go(v.project.project_id, 'overview');
  };
  $('#rs-new').addEventListener('click', newProject); $('#rs-new2')?.addEventListener('click', newProject);
  $$('[data-p]', root).forEach((b) => b.addEventListener('click', () => go(b.dataset.p, tab)));
  if (!pid) return;
  let v = await get(`/api/research/projects/${pid}`);
  const main = $('#rs-main');
  const reload = async () => { v = await get(`/api/research/projects/${pid}`); draw(); };
  const draw = () => {
    const p = v.project;
    main.innerHTML = `<div class="rs-head"><div><h1>${esc(p.title)}</h1><div class="small faint">${esc(p.code)} · ${esc(p.body.field)} · ${esc(meta.designs[p.body.design])} · 更新于 ${fmtTime(p.updated_at)}</div></div><span class="grow"></span>
        <div class="rs-flow" title="只统计已登记的被试">${[['登记', v.flow.registered], ['已同意', v.flow.consented], ['待确认', v.flow.pending], ['退出', v.flow.withdrawn]].map(([l, n]) => `<span><b>${n}</b>${l}</span>`).join('')}</div></div>
      <nav class="agp-tabs rs-tabs" role="tablist">${TABS.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</nav>
      <div id="rs-tab" class="rs-tab"></div>`;
    $$('[data-tab]', main).forEach((b) => b.addEventListener('click', () => go(pid, b.dataset.tab)));
    ({ overview, participants, instruments, coding, irr, export: exportTab })[tab]($('#rs-tab', main));
  };

  // ---------- 研究设计 ----------
  async function overview(el) {
    const p = v.project, b = p.body;
    const runs = (await get('/api/runs')).runs.filter((r) => r.started_at);
    const lines = (arr, f) => (arr || []).map(f).join('\n');
    el.innerHTML = `<div class="editor"><form class="panel" id="pf"><h2>研究设计</h2>
      <div class="grid2"><label>研究题目<input name="title" value="${esc(p.title)}"></label><label>项目编码<input name="code" value="${esc(p.code)}"></label></div>
      <div class="grid3"><label>学科领域<select name="field">${meta.fields.map((f) => `<option ${f === b.field ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label>
        <label>研究设计<select name="design">${Object.entries(meta.designs).map(([k, x]) => `<option value="${k}" ${k === b.design ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>
        <label>项目状态<select name="status">${[['planning', '设计中'], ['collecting', '采集中'], ['analysing', '分析中'], ['closed', '已结题']].map(([k, l]) => `<option value="${k}" ${k === p.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <label>研究问题（每行一个）<textarea name="rqs" rows="3" placeholder="RQ1：……">${esc(lines(b.rqs, (x) => x))}</textarea></label>
      <label>研究假设（可选，每行一个）<textarea name="hypotheses" rows="2">${esc(lines(b.hypotheses, (x) => x))}</textarea></label>
      <div class="grid2"><label>组别（每行：编码=名称=说明）<textarea name="conditions" rows="3" placeholder="EXP=实验组=使用平台开展研课\nCTL=对照组=常规教研">${esc(lines(b.conditions, (c) => [c.code, c.label, c.description].filter(Boolean).join('=')))}</textarea></label>
        <label>时间点（每行：编码=名称=日期）<textarea name="timepoints" rows="3" placeholder="T0=前测=2026-09-01\nT1=后测=2026-12-20">${esc(lines(b.timepoints, (t) => [t.code, t.label, t.date].filter(Boolean).join('=')))}</textarea></label></div>
      <div class="grid2"><label>分析单位<input name="unit_of_analysis" value="${esc(b.unit_of_analysis)}" placeholder="如：教师个体 / 教研组 / 课堂话轮"></label><label>抽样与样本量依据<input name="sampling" value="${esc(b.sampling)}" placeholder="如：方便抽样；G*Power 估计每组至少 n=…"></label></div>
      <label>设计说明<textarea name="design_note" rows="2">${esc(b.design_note)}</textarea></label>
      <fieldset class="rs-fs"><legend>伦理与知情同意</legend><div class="grid3"><label>伦理委员会<input name="e_body" value="${esc(b.ethics?.body)}"></label><label>批准号<input name="e_number" value="${esc(b.ethics?.number)}"></label><label>批准日期<input name="e_date" type="date" value="${esc(b.ethics?.date)}"></label></div>
        <div class="grid2"><label>知情同意书版本<input name="e_consent" value="${esc(b.ethics?.consent_version)}" placeholder="如 V1.1（2026-08-20）"></label><label>若申请豁免，理由<input name="e_exempt" value="${esc(b.ethics?.exempt_reason)}"></label></div></fieldset>
      <label>预注册（链接或编号，可选）<input name="prereg" value="${esc(b.prereg)}" placeholder="如 OSF 链接"></label>
      <label>AI 使用声明<textarea name="ai_disclosure" rows="2" placeholder="如：本研究使用“研思智境”平台的多智能体模拟生成教研对话，仅作为干预工具；所有学生数据来自真实施测；论文写作未使用生成式 AI 生成结论。">${esc(b.ai_disclosure)}</textarea></label>
      <label>数据可得性声明<textarea name="data_availability" rows="2" placeholder="如：去标识化数据可向通讯作者合理申请获得。">${esc(b.data_availability)}</textarea></label>
      <details class="rs-fs"><summary>关联的平台运行（过程数据，导出时放在 platform/ 下，已假名化）</summary><div class="rs-runs">${runs.map((r) => `<label class="inline small"><input type="checkbox" data-run="${r.run_id}" ${b.run_ids?.includes(r.run_id) ? 'checked' : ''}>${MODULE_NAME[r.module]} · ${fmtTime(r.created_at)} · ${r.exec_mode === 'model' ? '真实模型' : '本地生成'}</label>`).join('') || '<span class="small faint">暂无运行</span>'}</div></details>
      <div class="row" style="margin-top:10px"><button class="primary" type="submit">保存研究设计</button><span class="grow"></span><button type="button" class="ghost" id="pdel" style="color:var(--red)">删除项目</button></div></form>
      <aside class="side"><div class="panel"><h2>发表前自检</h2><p class="small faint">常见审稿关注点（非某一期刊的官方清单）。</p><ul class="rs-check">${v.checklist.map((c) => `<li class="${c.status}"><span class="badge ${ST[c.status][1]}">${ST[c.status][0]}</span><div><b>${esc(c.label)}</b><div class="small faint">${esc(c.detail)}</div></div></li>`).join('')}</ul></div>
        <div class="panel"><h2>被试流程</h2><div class="small">登记 ${v.flow.registered} → 已同意 ${v.flow.consented}（拒绝 ${v.flow.declined}、待确认 ${v.flow.pending}、退出 ${v.flow.withdrawn}）</div>${v.flow.by_condition.map((c) => `<div class="small">· ${esc(c.label)}（${esc(c.code)}）：${c.n}</div>`).join('')}${v.flow.unassigned ? `<div class="small" style="color:var(--warn)">· 已同意但未分组：${v.flow.unassigned}</div>` : ''}</div></aside></div>`;
    const parse = (s, keys) => s.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const parts = l.split(/[=＝]/).map((x) => x.trim()); return Object.fromEntries(keys.map((k, i) => [k, parts[i] || ''])); });
    $('#pf').addEventListener('submit', async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      try {
        v = await put(`/api/research/projects/${pid}`, { title: f.title, code: f.code, status: f.status, body: { field: f.field, design: f.design, rqs: f.rqs.split('\n').map((x) => x.trim()).filter(Boolean), hypotheses: f.hypotheses.split('\n').map((x) => x.trim()).filter(Boolean),
          conditions: parse(f.conditions, ['code', 'label', 'description']), timepoints: parse(f.timepoints, ['code', 'label', 'date']), unit_of_analysis: f.unit_of_analysis, sampling: f.sampling, design_note: f.design_note,
          ethics: { body: f.e_body, number: f.e_number, date: f.e_date, consent_version: f.e_consent, exempt_reason: f.e_exempt }, prereg: f.prereg, ai_disclosure: f.ai_disclosure, data_availability: f.data_availability,
          run_ids: $$('[data-run]', el).filter((x) => x.checked).map((x) => x.dataset.run) } });
        toast('研究设计已保存'); draw();
      } catch (err) { fail(err); }
    });
    $('#pdel').addEventListener('click', async () => { if (!(await confirmBox('删除研究项目', `<p>将删除项目“${esc(p.title)}”及其全部被试、量表、作答、编码数据，不可恢复。</p><p class="small muted">建议先在“数据包导出”下载备份。</p>`, '确认删除', 'danger'))) return; try { await del(`/api/research/projects/${pid}`); navigate('/research', true); } catch (e) { fail(e); } });
  }

  // ---------- 被试 ----------
  function participants(el) {
    const conds = v.project.body.conditions || [];
    el.innerHTML = `<div class="panel"><div class="row"><h2 style="margin:0">被试名册（${v.participants.length}）</h2><span class="grow"></span>${ioButtons('participants', { project_id: pid }, { importLabel: '导入名册' })}</div>
      <p class="small muted">只用研究编码（如 P001），不要录入姓名、学号、手机号；导入时这些列会被自动忽略。知情同意状态决定数据能否进入分析：<b>只有“已同意”的被试</b>进入分析与导出。被试随时可以退出，退出后可一键删除其全部研究数据。</p>
      ${v.participants.length ? `<div class="scroll-x"><table class="data"><thead><tr><th>编码</th><th>身份</th><th>组别</th><th>班级/批次</th><th>小组</th><th>性别</th><th>年龄</th><th>前测</th><th>知情同意</th><th>同意日期</th><th></th></tr></thead><tbody>
        ${v.participants.map((x) => `<tr class="${x.consent === 'consented' ? '' : 'rs-dim'}"><td class="mono">${esc(x.code)}</td><td>${esc({ student: '学生', teacher: '教师', expert: '专家', other: '其他' }[x.role] || '—')}</td>
          <td><select data-cond="${x.participant_id}" aria-label="组别"><option value="">未分组</option>${conds.map((c) => `<option value="${esc(c.code)}" ${c.code === x.condition ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></td>
          <td>${esc(x.cohort || '')}</td><td>${esc(x.grp || '')}</td><td>${esc({ f: '女', m: '男', other: '其他', undisclosed: '不愿透露' }[x.gender] || '')}</td><td>${x.age ?? ''}</td><td>${x.prior_score ?? ''}</td>
          <td><select data-consent="${x.participant_id}" aria-label="知情同意">${Object.entries(meta.consent_names).map(([k, l]) => `<option value="${k}" ${k === x.consent ? 'selected' : ''}>${l}</option>`).join('')}</select></td><td class="small">${esc(x.consent_date || '')}${x.withdrawn_at ? `<br><span style="color:var(--warn)">退出 ${fmtTime(x.withdrawn_at)}</span>` : ''}</td>
          <td>${x.consent === 'withdrawn' ? `<button class="small ghost" data-purge="${x.participant_id}" title="删除该被试的全部作答与话语数据">删除其数据</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">尚未登记被试。点“导入名册”，用 Excel/CSV 一次导入。</div>'}</div>`;
    bindIo(el, { participants: { title: '导入被试名册', hint: '需要一列研究编码；可包含组别、班级、小组、性别、年龄、前测成绩、知情同意状态与日期。姓名/学号/手机号等列会被自动忽略。', onDone: reload } });
    $$('[data-consent]', el).forEach((s) => s.addEventListener('change', async () => { try { await put(`/api/research/participants/${s.dataset.consent}`, { consent: s.value }); toast(s.value === 'withdrawn' ? '已记录退出：该被试的数据不再进入分析与导出' : '已更新'); reload(); } catch (e) { fail(e); } }));
    $$('[data-cond]', el).forEach((s) => s.addEventListener('change', async () => { try { await put(`/api/research/participants/${s.dataset.cond}`, { condition: s.value }); toast('已更新组别'); } catch (e) { fail(e); } }));
    $$('[data-purge]', el).forEach((b) => b.addEventListener('click', async () => {
      const ok = await modal({ title: '删除退出被试的研究数据', body: '<p>将永久删除该被试的全部问卷/测试作答、转录话语及其编码，名册中保留“已退出”记录用于报告被试流程。</p><label class="inline"><input type="checkbox" id="pg-ok"> 我确认删除，且不可恢复</label>',
        buttons: [{ label: '取消', value: false }, { label: '删除', cls: 'danger', handler: (m) => { if (!$('#pg-ok', m).checked) { toast('请勾选确认', true); return false; } return true; } }] });
      if (!ok) return; try { const r = await post(`/api/research/participants/${b.dataset.purge}/purge`, { confirm: true }); toast(`已删除作答 ${r.responses_deleted} 条、话语 ${r.units_deleted} 条`); reload(); } catch (e) { fail(e); }
    }));
  }

  // ---------- 量表与测试 ----------
  async function instruments(el) {
    const sel = query.i && v.instruments.some((i) => i.instrument_id === query.i) ? query.i : v.instruments[0]?.instrument_id;
    el.innerHTML = `<div class="rs-inst"><div class="panel"><div class="row"><h2 style="margin:0">量表与测试</h2><span class="grow"></span><button class="small" id="in-new">＋ 新建</button></div>
      <div class="rs-ilist">${v.instruments.map((i) => `<button class="rs-iitem ${i.instrument_id === sel ? 'on' : ''}" data-inst="${i.instrument_id}"><b>${esc(i.name)}</b><span class="row" style="gap:4px"><span class="badge">${i.kind === 'scale' ? '量表' : '测试'}</span><span class="badge ${SRC[i.body.source_status]}">${esc(v.source_status[i.body.source_status]?.split('（')[0])}</span></span><span class="small faint">${i.n_items} 题${i.n_placeholders ? ` · <span style="color:var(--red)">占位 ${i.n_placeholders}</span>` : ''} · 作答 ${i.n_responses} 份</span></button>`).join('') || '<div class="small faint">尚无量表或测试</div>'}</div></div>
      <div id="in-detail"></div></div>`;
    $$('[data-inst]', el).forEach((b) => b.addEventListener('click', () => go(pid, 'instruments', `&i=${b.dataset.inst}`)));
    $('#in-new').addEventListener('click', async () => {
      const exams = (await get('/api/artifacts')).artifacts.filter((a) => ['exam', 'exercises'].includes(a.type));
      let made = null; const done = (m, x) => { made = x.instrument.instrument_id; m.querySelector('.actions button').click(); };
      await modal({ title: '新建量表或测试', wide: true, body: `<div class="rs-newgrid">
        <div class="panel"><h3>自建</h3><label>类型<select id="ni-k"><option value="scale">量表 / 问卷（李克特）</option><option value="test">测试（有答案键）</option></select></label><label>名称<input id="ni-n"></label>
          <div class="grid2"><label>编码<input id="ni-c" placeholder="如 SE"></label><label>等级（量表）<input id="ni-s" value="1-5"></label></div>
          <label>来源性质<select id="ni-src">${Object.entries(v.source_status).map(([k, l]) => `<option value="${k}" ${k === 'self_developed' ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label><label>来源引用（原版/改编必填）<input id="ni-cite"></label>
          <button class="primary" id="ni-go" style="margin-top:8px">创建</button></div>
        <div class="panel"><h3>结构模板（题项为占位，需粘贴原量表题项）</h3>${Object.entries(meta.skeletons).map(([k, s]) => `<button class="rs-sk" data-sk="${k}"><b>${esc(s.name)}</b><span class="small faint">${esc(s.dims.map((d) => `${d.code}×${d.n}`).join(' '))}</span><span class="small faint">${esc(s.citation)}</span></button>`).join('')}
          <p class="small faint">平台不收录量表原文（版权与翻译效度问题）；模板只给出维度结构与题数，并在导出与自检中标为“占位”。</p></div>
        <div class="panel"><h3>从产物库试卷生成测试</h3>${exams.length ? exams.map((a) => `<button class="rs-sk" data-ex="${a.artifact_id}"><b>${esc(a.title)}</b><span class="small faint">${esc(TYPE_NAME[a.type])} v${a.version}</span></button>`).join('') : '<div class="small faint">产物库中还没有模拟试卷或练习</div>'}</div></div>`,
        onMount: (m) => {
          $('#ni-go', m).addEventListener('click', async () => { const [lo, hi] = $('#ni-s', m).value.split(/[-—~～,，]/).map(Number); try { const x = await post('/api/research/instruments', { project_id: pid, kind: $('#ni-k', m).value, name: $('#ni-n', m).value, code: $('#ni-c', m).value, scale: [lo, hi], source_status: $('#ni-src', m).value, citation: $('#ni-cite', m).value }); done(m, x); } catch (e) { fail(e); } });
          $$('[data-sk]', m).forEach((b) => b.addEventListener('click', async () => { try { const x = await post('/api/research/instruments', { project_id: pid, skeleton: b.dataset.sk }); done(m, x); } catch (e) { fail(e); } }));
          $$('[data-ex]', m).forEach((b) => b.addEventListener('click', async () => { try { const x = await post('/api/research/instruments', { project_id: pid, artifact_id: b.dataset.ex }); done(m, x); } catch (e) { fail(e); } }));
        }, buttons: [{ label: '关闭', value: null }] });
      if (made) go(pid, 'instruments', `&i=${made}`);
    });
    if (!sel) return;
    const d = await get(`/api/research/instruments/${sel}`); const inst = d.instrument, scale = inst.kind === 'scale';
    const tps = v.project.body.timepoints || [];
    const box = $('#in-detail', el);
    box.innerHTML = `<div class="panel"><div class="row"><h2 style="margin:0">${esc(inst.name)}</h2><span class="badge">${esc(inst.code)}</span><span class="badge ${SRC[inst.body.source_status]}">${esc(v.source_status[inst.body.source_status])}</span><span class="grow"></span><button class="small ghost" id="in-del" style="color:var(--red)">删除</button></div>
      ${inst.body.citation ? `<p class="small faint">来源：${esc(inst.body.citation)}</p>` : ''}${d.items.some((x) => x.placeholder) ? '<div class="notice red" style="margin:6px 0">含占位题项：请用“导入题项”粘贴原量表题项（同一题项编码会被更新），替换前不可用于正式施测。</div>' : ''}
      <h3 class="rs-h3">① 题项（${d.items.length}）${ioButtons(scale ? 'scale_items' : 'test_items', { instrument_id: sel }, { importLabel: '导入题项' })}</h3>
      <div class="scroll-x" style="max-height:36vh"><table class="data"><thead><tr><th>编码</th><th>${scale ? '维度' : '题型'}</th><th>内容</th>${scale ? '<th>反向</th>' : '<th>答案</th><th>分值</th><th>认知层次</th>'}<th></th></tr></thead><tbody>
        ${d.items.map((x) => `<tr class="${x.placeholder ? 'rs-ph' : ''}"><td class="mono">${esc(x.code)}</td><td>${esc(scale ? x.dimension || '' : d.qtypes[x.qtype] || x.qtype || '')}</td><td class="small">${esc(x.text)}</td>${scale ? `<td>${x.reverse ? '<span class="badge warn">反向</span>' : ''}</td>` : `<td>${esc(x.answer || '')}</td><td>${x.points ?? ''}</td><td>${esc(d.blooms[x.cognitive_level] || '')}</td>`}<td><button class="small ghost" data-delitem="${x.item_id}" aria-label="删除题项 ${esc(x.code)}">✕</button></td></tr>`).join('')}</tbody></table></div>
      <h3 class="rs-h3">② 作答数据（${d.n_response_sets} 份）${ioButtons('responses', { instrument_id: sel }, { importLabel: '导入作答' })}${!scale ? '<button class="small ghost" id="in-rescore">按答案键重新计分</button>' : ''}</h3>
      <p class="small faint">宽表：一行 = 一名被试在一个时间点的作答；列为题项（表头写题项编码、Q1、第1题均可识别）。时间点：${tps.map((t) => `${esc(t.code)}=${esc(t.label)}`).join('，') || '<span style="color:var(--red)">未设置，请先在“研究设计”填写</span>'}。被试编码须已在名册中登记。</p>
      <h3 class="rs-h3">③ 分析 <button class="small primary" id="in-an">计算</button></h3><div id="in-res" class="small faint">点击“计算”：${scale ? '各维度 Cronbach α（含校正题总相关、删题后 α）与各组×时间点描述统计' : '难度、区分度、校正题总相关、KR-20/α 与总分描述统计'}。只统计已同意被试的完整作答。</div></div>`;
    bindIo(box, { '*': { onDone: () => go(pid, 'instruments', `&i=${sel}`) }, responses: { title: '导入作答数据', hint: `一行一名被试一个时间点。必须有“被试编码”列；时间点列可写 ${tps.map((t) => `${t.code} 或 ${t.label}`).join('、')}。${scale ? `量表取值须在 ${inst.body.scale?.join('—')} 之间。` : '客观题填学生作答（如 B、ACD、对），主观题填得分。'}`, onDone: () => go(pid, 'instruments', `&i=${sel}`) } });
    $('#in-del').addEventListener('click', async () => { if (!(await confirmBox('删除', `<p>删除“${esc(inst.name)}”及其全部题项和作答？</p>`, '删除', 'danger'))) return; await del(`/api/research/instruments/${sel}`); go(pid, 'instruments'); });
    $$('[data-delitem]', box).forEach((b) => b.addEventListener('click', async () => { try { await del(`/api/research/items/${b.dataset.delitem}`); go(pid, 'instruments', `&i=${sel}`); } catch (e) { fail(e); } }));
    $('#in-rescore')?.addEventListener('click', async () => { const r = await post(`/api/research/instruments/${sel}/rescore`); toast(`已重新计分 ${r.rescored} 条`); });
    $('#in-an').addEventListener('click', async () => {
      try {
        const a = await get(`/api/research/instruments/${sel}/analysis`);
        const head = `<p>已同意被试的作答 ${a.n_sets} 份${a.excluded_unconsented ? `；${a.excluded_unconsented} 名未同意/未登记被试的作答已排除` : ''}${a.instrument.placeholders ? `；<b style="color:var(--red)">含 ${a.instrument.placeholders} 个占位题项</b>` : ''}。${esc(a.scoring_note)}</p>`;
        if (!a.n_sets) { $('#in-res', box).innerHTML = `${head}<div class="empty">尚无可分析的作答数据</div>`; return; }
        $('#in-res', box).innerHTML = head + (scale ? `
          <h4>信度（Cronbach α）</h4><table class="data"><tr><th>时间点</th><th>维度</th><th>题数</th><th>n</th><th>α</th><th>判断</th><th>题项（校正题总相关 / 删题后 α）</th></tr>${a.reliability.map((r) => `<tr><td>${esc(r.timepoint)}</td><td>${esc(r.dimension)}</td><td>${r.k}</td><td>${r.n}</td><td><b>${num(r.alpha)}</b></td><td>${esc(r.interpretation)}${r.note ? `<br><span class="faint">${esc(r.note)}</span>` : ''}</td><td class="small">${r.items.map((x) => `${esc(x.item)}${x.reverse ? '(R)' : ''} ${num(x.citc, 2)}/${num(x.alpha_if_deleted, 2)}`).join('；')}</td></tr>`).join('')}</table>
          <h4>描述统计（维度均分）</h4><table class="data"><tr><th>时间点</th><th>组别</th><th>维度</th><th>n</th><th>M</th><th>SD</th><th>最小</th><th>最大</th></tr>${a.descriptives.filter((x) => x.n).map((x) => `<tr><td>${esc(x.timepoint)}</td><td>${esc(x.condition)}</td><td>${esc(x.dimension)}</td><td>${x.n}</td><td>${num(x.mean, 2)}</td><td>${num(x.sd, 2)}</td><td>${num(x.min, 2)}</td><td>${num(x.max, 2)}</td></tr>`).join('')}</table>` : `
          ${a.item_analysis.map((t) => `<h4>${esc(t.timepoint)}：n=${t.n}${t.reliability ? ` · ${t.reliability.kr20 != null ? `KR-20=${num(t.reliability.kr20)}` : `α=${num(t.reliability.alpha)}`}` : ''}${t.note ? ` · ${esc(t.note)}` : ''}</h4>
            ${t.items?.length ? `<table class="data"><tr><th>题</th><th>满分</th><th>难度 P</th><th>区分度 D</th><th>校正题总相关</th><th>提示</th></tr>${t.items.map((x) => `<tr><td>${esc(x.item)}</td><td>${x.max}</td><td>${num(x.difficulty_p, 2)}</td><td>${num(x.discrimination_d, 2)}</td><td>${num(x.corrected_r, 2)}</td><td style="color:var(--warn)">${esc(x.flag)}</td></tr>`).join('')}</table>` : ''}`).join('')}
          <h4>总分描述（满分 ${a.max_total}）</h4><table class="data"><tr><th>时间点</th><th>组别</th><th>n</th><th>M</th><th>SD</th><th>中位数</th></tr>${a.totals.filter((x) => x.n).map((x) => `<tr><td>${esc(x.timepoint)}</td><td>${esc(x.condition)}</td><td>${x.n}</td><td>${num(x.mean, 2)}</td><td>${num(x.sd, 2)}</td><td>${num(x.median, 2)}</td></tr>`).join('')}</table>`)
          + `<p class="faint">${esc(a.thresholds)}</p><p class="faint">平台只提供描述统计与信度/题目分析；组间差异、前后测变化请导出后在 SPSS / R 中做推断统计并报告效应量。</p>`;
      } catch (e) { fail(e); }
    });
  }

  // ---------- 话语编码 ----------
  async function coding(el) {
    const cbSel = query.cb && v.codebooks.some((c) => c.codebook_id === query.cb) ? query.cb : v.codebooks[0]?.codebook_id;
    el.innerHTML = `<div class="grid2 rs-cod"><div class="panel"><div class="row"><h2 style="margin:0">话语单元（${v.units.n}）</h2><span class="grow"></span>${ioButtons('units', { project_id: pid }, { importLabel: '导入转录' })}</div>
        <p class="small muted">导入真实课堂 / 教研活动的转录文本（一行一个话轮：课次、序号、说话人编码、内容）。手机号、身份证号等会被自动隐去。${v.units.simulated ? `<br><b style="color:var(--warn)">其中 ${v.units.simulated} 条来自平台模拟（智能体生成），导出时标注 is_simulated，不能作为真实课堂证据。</b>` : ''}</p>
        <div class="row"><button class="small" id="u-runs">从平台运行导入（模拟对话）</button><button class="small ghost" id="u-del">删除某场次</button></div></div>
      <div class="panel"><div class="row"><h2 style="margin:0">编码表</h2><span class="grow"></span><button class="small" id="cb-new">＋ 新建编码表</button></div>
        <div class="row" style="gap:6px;margin-top:6px">${v.codebooks.map((c) => `<button class="small ${c.codebook_id === cbSel ? 'primary' : ''}" data-cb="${c.codebook_id}">${esc(c.name)}（${c.n_codes} 码 · ${c.coders.length} 位编码者）</button>`).join('') || '<span class="small faint">尚无编码表</span>'}</div></div></div>
      <div id="cb-detail"></div>`;
    bindIo(el, { units: { title: '导入话语转录', hint: '需要“课次/场次”和“内容”两列；序号缺省时按顺序编号；说话人请用编码（T、S01…），不要用真名。', onDone: reload } });
    $$('[data-cb]', el).forEach((b) => b.addEventListener('click', () => go(pid, 'coding', `&cb=${b.dataset.cb}`)));
    $('#cb-new').addEventListener('click', async () => {
      const r = await modal({ title: '新建编码表', body: `<label>名称<input id="cb-n" placeholder="如 IRF、课程思政话语类型"></label><label>编码方式<select id="cb-m"><option value="exclusive">互斥：每个单元 1 个代码（计算 Cohen κ / Krippendorff α）</option><option value="multi">多选：每个单元可有多个代码（逐代码计算 α；适合 ENA）</option></select></label><label>理论框架 / 来源<input id="cb-f" placeholder="如 Sinclair & Coulthard (1975) IRF"></label>`,
        buttons: [{ label: '取消', value: null }, { label: '创建', cls: 'primary', handler: (m) => post('/api/research/codebooks', { project_id: pid, name: $('#cb-n', m).value, mode: $('#cb-m', m).value, framework: $('#cb-f', m).value }) }] });
      if (r?.codebook) go(pid, 'coding', `&cb=${r.codebook.codebook_id}`);
    });
    $('#u-runs').addEventListener('click', async () => {
      const runs = (await get('/api/runs')).runs.filter((r) => r.started_at);
      const r = await modal({ title: '从平台运行导入话语单元', wide: true, body: `<div class="notice">这些对话由智能体模拟产生（或含真人教师输入），只能用于研究平台/模拟过程本身，<b>不能当作真实课堂或真实学生的证据</b>。导入后标记为“平台模拟”。</div><div class="rs-runs" style="margin-top:8px">${runs.map((x) => `<label class="inline small"><input type="checkbox" data-r="${x.run_id}">${MODULE_NAME[x.module]} · ${fmtTime(x.created_at)} · ${x.exec_mode === 'model' ? '真实模型' : '本地生成'}</label>`).join('') || '暂无运行'}</div>`,
        buttons: [{ label: '取消', value: null }, { label: '导入', cls: 'primary', handler: (m) => post(`/api/research/projects/${pid}/units-from-runs`, { run_ids: $$('[data-r]', m).filter((x) => x.checked).map((x) => x.dataset.r) }) }] });
      if (r) { toast(`已导入 ${r.added} 条话语单元`); reload(); }
    });
    $('#u-del').addEventListener('click', async () => {
      if (!cbSel && !v.units.n) return toast('没有话语单元', true);
      const s = await modal({ title: '删除场次', body: '<label>场次/课次编码（留空删除全部）<input id="ud-s"></label><p class="small muted">该场次的话语单元及其所有编码都会删除。</p>', buttons: [{ label: '取消', value: null }, { label: '删除', cls: 'danger', handler: (m) => post(`/api/research/projects/${pid}/units-delete`, { session: $('#ud-s', m).value || undefined }) }] });
      if (s) { toast(`已删除 ${s.deleted} 条`); reload(); }
    });
    if (!cbSel) return;
    const box = $('#cb-detail', el);
    let coder = ''; try { coder = localStorage.getItem('yz-coder') || ''; } catch { /* storage unavailable */ }
    let session = query.s || '', offset = 0;
    const drawCb = async () => {
      const cv = await get(`/api/research/codebooks/${cbSel}/coding?coder=${encodeURIComponent(coder)}&session=${encodeURIComponent(session)}&offset=${offset}`);
      session = cv.session || '';
      box.innerHTML = `<div class="panel"><div class="row"><h2 style="margin:0">${esc(cv.codebook.name)}</h2><span class="badge">${cv.codebook.mode === 'multi' ? '多选编码' : '互斥编码'}</span>${cv.codebook.framework ? `<span class="small faint">${esc(cv.codebook.framework)}</span>` : ''}<span class="grow"></span>${ioButtons('codes', { codebook_id: cbSel }, { importLabel: '导入代码' })}${ioButtons('codings', { codebook_id: cbSel }, { importLabel: '导入编码结果', exportLabel: '导出编码', template: false })}<button class="small ghost" id="cb-del" style="color:var(--red)">删除编码表</button></div>
        <div class="rs-codes">${cv.codes.map((c) => `<span class="rs-code" title="${esc([c.definition, c.include_rule && `纳入：${c.include_rule}`, c.exclude_rule && `排除：${c.exclude_rule}`, c.example && `例：${c.example}`].filter(Boolean).join('\n'))}"><b>${esc(c.code)}</b> ${esc(c.label)}${c.category ? `<i>${esc(c.category)}</i>` : ''}</span>`).join('') || '<span class="small faint">尚无代码：先导入编码表（代码、名称、定义、纳入/排除规则、示例）</span>'}</div>
        <div class="rs-coderbar"><label class="inline">编码者假名 <input id="cd-coder" value="${esc(coder)}" placeholder="如 C1" style="width:90px"></label><span class="badge cyan" title="你只能看到自己的编码，看不到其他编码者的结果">盲编</span>
          <label class="inline">场次 <select id="cd-s">${cv.sessions.map((s) => `<option value="${esc(s.session)}" ${s.session === session ? 'selected' : ''}>${esc(s.session)}（${s.n}${s.source === 'platform_event' ? ' · 模拟' : ''}）</option>`).join('')}</select></label>
          <span class="small faint">${cv.total ? `第 ${offset + 1}—${Math.min(offset + cv.units.length, cv.total)} / ${cv.total} 条` : ''}</span><span class="grow"></span><button class="small" id="cd-prev" ${offset ? '' : 'disabled'}>上一页</button><button class="small" id="cd-next" ${offset + cv.units.length < cv.total ? '' : 'disabled'}>下一页</button></div>
        ${!coder ? '<div class="notice">请先填写编码者假名（每位编码者用不同假名，独立完成后再计算一致性）。</div>' : ''}
        <div class="rs-units" data-coder="${esc(coder)}">${cv.units.map((u) => `<div class="rs-unit ${u.source === 'platform_event' ? 'sim' : ''}"><div class="small faint">#${u.seq} · ${esc(u.speaker || '')}${u.speaker_role ? `（${esc(u.speaker_role)}）` : ''}${u.stage ? ` · ${esc(u.stage)}` : ''}</div><div>${esc(u.text)}</div>
          <div class="rs-chips">${cv.codes.map((c) => `<button class="chip ${u.mine.includes(c.code) ? 'on' : ''}" data-u="${u.unit_id}" data-code="${esc(c.code)}" ${coder ? '' : 'disabled'} aria-pressed="${u.mine.includes(c.code)}">${esc(c.code)}</button>`).join('')}</div></div>`).join('') || '<div class="empty">该场次没有话语单元</div>'}</div>
        <h3 class="rs-h3">一致性与序列 <button class="small primary" id="cd-irr">计算编码者一致性</button><button class="small" id="cd-seq">滞后序列分析</button></h3><div id="cd-res"></div></div>`;
      bindIo(box, { '*': { onDone: drawCb } });
      $('#cd-coder', box).addEventListener('change', (e) => { coder = e.target.value.trim(); $('.rs-units', box).innerHTML = '<div class="small faint">正在切换编码者…</div>'; try { localStorage.setItem('yz-coder', coder); } catch { /* storage unavailable */ } drawCb(); });
      $('#cd-s', box)?.addEventListener('change', (e) => { session = e.target.value; offset = 0; drawCb(); });
      $('#cd-prev', box).addEventListener('click', () => { offset = Math.max(0, offset - 60); drawCb(); });
      $('#cd-next', box).addEventListener('click', () => { offset += 60; drawCb(); });
      $('#cb-del', box).addEventListener('click', async () => { if (!(await confirmBox('删除编码表', '<p>删除编码表及其全部编码结果？</p>', '删除', 'danger'))) return; await del(`/api/research/codebooks/${cbSel}`); go(pid, 'coding'); });
      $$('.chip[data-u]', box).forEach((b) => b.addEventListener('click', async () => {
        const wrap = b.parentElement; const multi = cv.codebook.mode === 'multi';
        const on = !b.classList.contains('on');
        if (!multi) $$('.chip', wrap).forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
        b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
        try { await post('/api/research/codings', { codebook_id: cbSel, unit_id: b.dataset.u, coder, codes: $$('.chip.on', wrap).map((x) => x.dataset.code) }); } catch (e) { fail(e); drawCb(); }
      }));
      $('#cd-irr', box).addEventListener('click', async () => {
        const r = await get(`/api/research/codebooks/${cbSel}/irr`);
        $('#cd-res', box).innerHTML = r.note ? `<div class="notice">${esc(r.note)}（当前编码者：${esc(r.coders.join('、') || '无')}）</div>` : `<p class="small">编码者：${esc(r.coders.join('、'))}；被至少两人编码的单元 ${r.n_units_shared} / ${r.n_units_coded}</p>
          ${r.krippendorff ? `<p>Krippendorff α（名义）= <b>${num(r.krippendorff.alpha)}</b> · ${esc(r.krippendorff.interpretation)}</p><table class="data"><tr><th>编码者对</th><th>n</th><th>一致率</th><th>Cohen κ</th><th>判断</th></tr>${r.pairs.map((x) => `<tr><td>${esc(x.a)} × ${esc(x.b)}</td><td>${x.n}</td><td>${num(x.percent_agreement)}</td><td><b>${num(x.kappa)}</b></td><td>${esc(x.interpretation)}</td></tr>`).join('')}</table>` : ''}
          ${r.per_code ? `<table class="data"><tr><th>代码</th><th>Krippendorff α</th><th>判断</th></tr>${r.per_code.map((x) => `<tr><td>${esc(x.code)} ${esc(x.label)}</td><td>${num(x.alpha)}</td><td>${esc(x.interpretation)}</td></tr>`).join('')}</table>` : ''}
          ${r.disagreements.length ? `<details><summary class="small" style="cursor:pointer;color:var(--gold)">分歧单元（${r.disagreements.length}，用于讨论后修订编码规则）</summary>${r.disagreements.map((d) => `<div class="small">${esc(d.text)} — ${esc(Object.entries(d.codes).map(([c, x]) => `${c}:${x.join('+')}`).join('；'))}</div>`).join('')}</details>` : ''}<p class="small faint">${esc(r.thresholds)}</p>`;
      });
      $('#cd-seq', box).addEventListener('click', async () => {
        const r = await get(`/api/research/codebooks/${cbSel}/sequence${coder ? `?coder=${encodeURIComponent(coder)}` : ''}`);
        const sig = r.lag.cells.filter((c) => c.observed && c.z != null).sort((a, b) => b.z - a.z);
        $('#cd-res', box).innerHTML = `<p class="small">依据：${esc(r.basis)}；${r.n_units} 个已编码单元，${r.lag.n_transitions} 次相邻转移。</p><table class="data"><tr><th>前 → 后</th><th>观察</th><th>期望</th><th>调整残差 z</th></tr>${sig.slice(0, 20).map((c) => `<tr><td>${esc(c.from)} → ${esc(c.to)}</td><td>${c.observed}</td><td>${num(c.expected, 2)}</td><td style="${c.z > 1.96 ? 'color:var(--green);font-weight:700' : ''}">${num(c.z, 2)}</td></tr>`).join('')}</table><p class="small faint">${esc(r.lag.note)}。完整矩阵与 ENA 格式数据在“数据包导出”中。</p>`;
      });
    };
    drawCb();
  }

  // ---------- 评分一致性 ----------
  async function irr(el) {
    const rubrics = (await get('/api/rubrics')).rubrics;
    let rid = query.r || rubrics[0]?.rubric_id;
    const drawR = async () => {
      const r = await get(`/api/research/rating-irr?rubric_id=${rid}`);
      el.innerHTML = `<div class="panel"><div class="row"><h2 style="margin:0">评分者一致性</h2><select id="ir-r" style="width:auto">${rubrics.map((x) => `<option value="${x.rubric_id}" ${x.rubric_id === rid ? 'selected' : ''}>${esc(x.name)} v${x.version}</option>`).join('')}</select><span class="grow"></span>${ioButtons('ratings', { rubric_id: rid }, { importLabel: '导入外部评分' })}<button class="small" data-link="/rating?blind=1">去盲评</button></div>
        <p class="small muted">多位评价者用不同假名、在“人工评分”页打开<b>盲评模式</b>独立评分（看不到发言者身份、生成方式与他人评分），或把线下评分表导入。这里按每个维度计算加权 κ（2 人）、Krippendorff α（有序）和 ICC(2,1)。</p>
        ${r.note ? `<div class="notice">${esc(r.note)}（当前评价者：${esc(r.raters.join('、') || '无')}）</div>` : `<p class="small">评价者：${esc(r.raters.join('、'))}；被评对象 ${r.n_targets} 个</p><table class="data"><tr><th>维度</th><th>共同评分对象</th><th>加权 κ</th><th>Krippendorff α</th><th>ICC(2,1)</th><th>判断</th></tr>${r.dimensions.map((d) => `<tr><td>${esc(d.label)}</td><td>${d.n_shared}</td><td>${num(d.weighted_kappa)}</td><td><b>${num(d.krippendorff_ordinal)}</b></td><td>${num(d.icc2_1)}</td><td class="small">${esc(d.alpha_interpretation)}${d.icc2_1 != null ? `；ICC ${esc(d.icc_interpretation)}` : d.icc_note ? `<br><span class="faint">${esc(d.icc_note)}</span>` : ''}</td></tr>`).join('')}</table><p class="small faint">${esc(r.thresholds)}</p>`}</div>`;
      $('#ir-r', el).addEventListener('change', (e) => { rid = e.target.value; drawR(); });
      bindIo(el, { ratings: { title: '导入外部评分', hint: '一行 = 一位评价者对一个对象（事件ID或产物ID）的评分；各维度一列，可填分数或“未评/不适用/证据不足”。', onDone: drawR } });
    };
    if (!rid) { el.innerHTML = '<div class="empty">没有量规</div>'; return; }
    drawR();
  }

  // ---------- 导出 ----------
  function exportTab(el) {
    el.innerHTML = `<div class="grid2"><div class="panel"><h2>项目数据包（ZIP）</h2><p class="small muted">包含：被试（仅已同意）、工具与题项、长表与宽表作答（附 SPSS 语法）、信度与题目分析、话语单元、编码、ENA 与滞后序列数据、一致性结果、R 读取脚本、数据字典、README（被试流程、伦理、声明）与 SHA-256 清单。</p>
        <label class="inline"><input type="checkbox" id="x-text"> 包含话语正文（默认省略；共享前请确认已去标识化）</label><label class="inline"><input type="checkbox" id="x-plat" checked> 包含关联的平台运行过程数据（${v.project.body.run_ids?.length || 0} 次）</label>
        <button class="primary" id="x-go" style="margin-top:10px">下载项目数据包</button></div>
      <div class="panel"><h2>单表导出</h2><p class="small muted">每张表都可导出 Excel / CSV / SPSS / JSON；导入模板只有表头与字段说明，不含示例数据。</p>
        <div class="rs-xlist"><div><b>被试名册</b>${ioButtons('participants', { project_id: pid }, { canImport: false })}</div><div><b>话语单元</b>${ioButtons('units', { project_id: pid }, { canImport: false })}</div>
        ${v.instruments.map((i) => `<div><b>${esc(i.name)} · 题项</b>${ioButtons(i.kind === 'scale' ? 'scale_items' : 'test_items', { instrument_id: i.instrument_id }, { canImport: false })}</div><div><b>${esc(i.name)} · 作答</b>${ioButtons('responses', { instrument_id: i.instrument_id }, { canImport: false })}</div>`).join('')}
        ${v.codebooks.map((c) => `<div><b>${esc(c.name)} · 编码</b>${ioButtons('codings', { codebook_id: c.codebook_id }, { canImport: false })}</div>`).join('')}</div>
        <p class="small faint">平台过程数据（运行、对话、调度、产物、评分）的完整导出在顶栏“数据导出”。</p></div></div>`;
    bindIo(el);
    $('#x-go').addEventListener('click', async () => { try { await downloadPost(`/api/research/projects/${pid}/package`, { include_text: $('#x-text').checked, include_platform: $('#x-plat').checked }, `research-${v.project.code}.zip`); toast('已开始下载'); } catch (e) { fail(e); } });
  }

  draw();
}
