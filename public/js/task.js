// 新建任务向导：导入课程内容 → 选择要生成的成果 → 执行（服务端自动执行任务链，可暂停/继续）。
import { get, post, del } from './api.js';
import { esc, $, $$, toast, fail, modal, TYPE_NAME, modeCards, modeVal, bindModeCards } from './ui.js';

const GROUPS = [['课堂层面', ['lesson_plan', 'courseware']], ['评价层面', ['exercises', 'exam']], ['课程层面', ['syllabus', 'course_design', 'semester_plan', 'teaching_schedule']], ['专业层面', ['talent_plan']]];
const RUNNABLE = ['lesson_plan', 'courseware', 'exercises', 'exam'];
const b64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(file); });
const utf8b64 = (text) => { const bytes = new TextEncoder().encode(text); let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };

export async function openTaskWizard(cat, { onStarted, openAdvanced } = {}) {
  let mats = (await get('/api/materials')).materials;
  const chosen = new Set(mats.slice(0, 1).map((m) => m.material_id));
  let analysis = null, kpChosen = new Set(), outputs = new Set(['lesson_plan', 'exercises']);
  let freshImport = false; // 本次向导第一次导入新内容时，取消默认勾选的旧材料，避免新旧课程混在一起
  const takeNew = () => { if (!freshImport) { chosen.clear(); freshImport = true; } };
  const body = `<div class="wiz">
    <section class="wiz-sec"><h4><span class="wiz-n">1</span>导入课程内容</h4>
      <div class="row"><label class="inline" style="cursor:pointer"><span class="badge gold" style="padding:6px 12px">⬆ 上传讲义 / 大纲 / 课件 / 习题（DOCX · PPTX · XLSX · TXT）</span><input type="file" id="w-file" multiple accept=".docx,.pptx,.xlsx,.txt,.md,.csv" hidden></label>
        <select id="w-kind" style="width:auto" aria-label="材料类别">${Object.entries(cat.material_kinds).map(([k, v]) => `<option value="${k}" ${k === 'courseware' ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <button type="button" class="small ghost" id="w-paste-btn">或粘贴文字</button></div>
      <div id="w-paste" hidden style="margin-top:6px"><textarea id="w-text" rows="5" placeholder="把讲义、大纲或教材章节的文字粘贴到这里"></textarea><button type="button" class="small" id="w-paste-add" style="margin-top:4px">导入这段文字</button></div>
      <div id="w-mats" class="wiz-mats"></div>
      <p class="small faint" style="margin:4px 0 0">只保存从文件中提取的文字；手机号、身份证号、学号、邮箱会自动隐去。请勿上传学生名单、成绩等个人信息。</p>
      <div id="w-analysis"></div></section>
    <section class="wiz-sec"><h4><span class="wiz-n">2</span>要生成的成果</h4>
      <div class="wiz-outs">${GROUPS.map(([g, ks]) => `<div><div class="small faint">${g}</div>${ks.map((k) => `<label class="inline"><input type="checkbox" data-out="${k}" ${outputs.has(k) ? 'checked' : ''}> ${esc(TYPE_NAME[k] || k)}</label>`).join('')}</div>`).join('')}</div>
      <div class="grid3" style="margin-top:8px">
        <label>主成果（先研讨它，并用于演课场）<select id="w-primary"></select></label>
        <label>课时长度<select id="w-min">${cat.lesson_minutes.map((m) => `<option value="${m}" ${m === 45 ? 'selected' : ''}>${m} 分钟</option>`).join('')}</select></label>
        <label>执行节奏<select id="w-pace"><option value="fast">快速得到结果</option><option value="watch">边执行边观看（每步约 1.4 秒）</option></select></label>
        <label title="学情分析和模拟上课都以这份匿名班级画像为依据；在“智能体 → 学生智能体”导入">班级（学情依据）<select id="w-cp"><option value="">默认模拟班级（学情留待补充）</option>${(cat.class_profiles || []).map((p) => `<option value="${p.profile_id}">${esc(p.name)}（${p.n} 人）</option>`).join('')}</select></label></div>
      <label class="inline" style="margin-top:8px"><input type="checkbox" id="w-class" checked> 用主成果模拟上课，生成课堂反馈，并据此修订主成果</label>
      <details class="more"><summary>高级设置</summary><div class="grid3">
        <label>教学设计框架<select id="w-fw"><option value="">不使用框架</option>${cat.frameworks.map((f) => `<option value="${f.key}" ${f.key === 'boppps' ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label>
        <label>模拟班级人数<select id="w-size">${[24, 40, 120, 300].map((n) => `<option ${n === 40 ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>研讨知识点数（最多 8）<input id="w-kpn" type="number" min="1" max="8" value="4"></label></div>
        <p class="small faint">需要自定义研讨模式、席位或逐项填写课程信息时，可用 <a href="#" id="w-adv">自定义单次研讨</a>。</p></details></section>
    <section class="wiz-sec"><h4><span class="wiz-n">3</span>执行</h4>
      ${modeCards(cat, 'w-exec')}
      <div class="estimate" id="w-est" style="margin-top:8px">请先导入课程内容</div></section></div>`;
  const collect = (m) => ({
    material_ids: [...chosen], kp_ids: kpChosen.size ? [...kpChosen] : undefined, kp_limit: Number($('#w-kpn', m).value) || 4,
    outputs: [$('#w-primary', m).value, ...[...outputs].filter((x) => x !== $('#w-primary', m).value)].filter(Boolean),
    class_minutes: Number($('#w-min', m).value), classroom: $('#w-class', m).checked, revise: $('#w-class', m).checked, pace: $('#w-pace', m).value,
    exec_mode: modeVal($('#w-exec', m)), framework_key: $('#w-fw', m).value || null, class_size: Number($('#w-size', m).value),
    course: analysis ? Object.fromEntries($$('[data-cg]', m).map((el) => [el.dataset.cg, el.value])) : undefined, class_profile_id: $('#w-cp', m).value || undefined,
  });
  const res = await modal({ title: '新建任务：导入课程内容后自动执行', wide: true, body,
    onMount: (m) => {
      const drawMats = () => {
        $('#w-mats', m).innerHTML = mats.length ? mats.map((x) => `<label class="inline small wiz-mat"><input type="checkbox" data-mat="${x.material_id}" ${chosen.has(x.material_id) ? 'checked' : ''}><b>${esc(x.filename)}</b><span class="badge">${esc(x.kind_name)}</span><span class="faint">${x.n_chars} 字</span>${Object.keys(x.pii_flags || {}).length ? '<span class="badge warn">个人信息已隐去</span>' : ''}<button type="button" class="small ghost" data-delmat="${x.material_id}" aria-label="删除">✕</button></label>`).join('') : '<p class="small faint">还没有导入内容。</p>';
        $$('[data-mat]', m).forEach((cb) => cb.addEventListener('change', () => { cb.checked ? chosen.add(cb.dataset.mat) : chosen.delete(cb.dataset.mat); kpChosen.clear(); analyse(); }));
        $$('[data-delmat]', m).forEach((b) => b.addEventListener('click', async (ev) => { ev.preventDefault(); await del(`/api/materials/${b.dataset.delmat}`); chosen.delete(b.dataset.delmat); mats = mats.filter((x) => x.material_id !== b.dataset.delmat); drawMats(); analyse(); }));
      };
      const drawPrimary = () => {
        const sel = $('#w-primary', m), keep = sel.value;
        sel.innerHTML = [...outputs].map((k) => `<option value="${k}">${esc(TYPE_NAME[k] || k)}</option>`).join('');
        if (outputs.has(keep)) sel.value = keep;
        const runnable = RUNNABLE.includes(sel.value);
        $('#w-class', m).disabled = !runnable; if (!runnable) $('#w-class', m).checked = false;
      };
      const analyse = async () => {
        if (!chosen.size) { analysis = null; $('#w-analysis', m).innerHTML = ''; return estimate(); }
        $('#w-analysis', m).innerHTML = '<p class="small faint">正在解析…</p>';
        try { analysis = await post('/api/knowledge/analyze', { material_ids: [...chosen] }); } catch (e) { $('#w-analysis', m).innerHTML = `<div class="notice red small">${esc(e.message)}</div>`; return; }
        const c = analysis.course, n = Number($('#w-kpn', m).value) || 4;
        if (!kpChosen.size) analysis.knowledge_points.slice(0, n).forEach((k) => kpChosen.add(k.id));
        $('#w-analysis', m).innerHTML = `<div class="wiz-card"><div class="small" style="color:var(--gold);margin-bottom:4px">识别结果（可修改）：${analysis.stats.sections} 个章节 · ${analysis.stats.knowledge_points} 个知识点（${analysis.stats.definitions} 个有明确定义）· ${analysis.stats.ideology_sentences} 处已有思政表述</div>
          <div class="grid3">${[['name', '课程名称'], ['major', '专业'], ['audience', '授课对象'], ['unit', '本次单元'], ['hours', '总学时'], ['goal_value', '价值目标']].map(([k, l]) => `<label>${l}<input data-cg="${k}" value="${esc(c[k] ?? '')}"></label>`).join('')}</div>
          <div class="small" style="margin:8px 0 4px">选择要重点研讨的知识点（教研组会逐个讨论讲解要点、难点、思政融入与检测题）：</div>
          <div class="kp-list">${analysis.knowledge_points.map((k) => `<label class="kp ${kpChosen.has(k.id) ? 'on' : ''}"><input type="checkbox" data-kp="${k.id}" ${kpChosen.has(k.id) ? 'checked' : ''}><span><b>${esc(k.term)}</b> <span class="badge ${k.kind === 'definition' ? 'cyan' : 'warn'}">${k.kind === 'definition' ? '有定义' : k.kind === 'topic' ? '仅标题' : '章节'}</span> <span class="badge">${esc(k.ideology)}</span><br><span class="faint">${esc(k.definition.slice(0, 60))}${k.definition.length > 60 ? '…' : ''}</span><br><span class="faint" style="font-size:max(12px, calc(11px * var(--fs)))">${esc(k.source)}</span></span></label>`).join('') || '<p class="small faint">未识别到知识点。请导入含定义或章节标题的讲义/大纲。</p>'}</div></div>`;
        $$('[data-kp]', m).forEach((cb) => cb.addEventListener('change', () => { if (cb.checked && kpChosen.size >= 8) { cb.checked = false; return toast('最多选择 8 个知识点', true); } cb.checked ? kpChosen.add(cb.dataset.kp) : kpChosen.delete(cb.dataset.kp); cb.closest('.kp').classList.toggle('on', cb.checked); estimate(); }));
        estimate();
      };
      const estimate = async () => {
        if (!chosen.size) { $('#w-est', m).textContent = '请先导入课程内容'; return; }
        if (!outputs.size) { $('#w-est', m).textContent = '请至少选择一项成果'; return; }
        try {
          const e = await post('/api/jobs/estimate', collect(m));
          $('#w-est', m).innerHTML = `<div>将依次执行：</div><ol class="small" style="margin:4px 0 6px 18px;padding:0">${e.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>${e.exec_mode === 'model' ? `预计最多 <b>${e.max_calls}</b> 次大模型调用，最多 <b>${e.max_credits}</b> 积分 · 当前可用 ${e.balance.available}` : '本地生成：不调用大模型，不消耗积分。每一步都会保存结果，可随时暂停与继续。'}`;
        } catch (e) { $('#w-est', m).textContent = e.message; }
      };
      const uploadFiles = async (files) => {
        for (const f of files) {
          if (f.size > 15 * 1024 * 1024) { fail(new Error(`${f.name} 超过 15MB`)); continue; }
          try { const mt = await post('/api/materials', { filename: f.name, kind: $('#w-kind', m).value, data_base64: await b64(f) }); takeNew(); mats.unshift(mt); chosen.add(mt.material_id); toast(`已导入《${mt.filename}》${mt.n_chars} 字`); } catch (e) { fail(e); }
        }
        kpChosen.clear(); drawMats(); analyse();
      };
      $('#w-file', m).addEventListener('change', (ev) => { uploadFiles([...ev.target.files]); ev.target.value = ''; });
      $('#w-paste-btn', m).addEventListener('click', () => { $('#w-paste', m).hidden = !$('#w-paste', m).hidden; });
      $('#w-paste-add', m).addEventListener('click', async () => {
        const text = $('#w-text', m).value.trim(); if (text.length < 20) return toast('请粘贴至少 20 字的课程内容', true);
        try { const mt = await post('/api/materials', { filename: `粘贴内容-${new Date().toLocaleDateString('zh-CN').replace(/\//g, '')}.txt`, kind: $('#w-kind', m).value, data_base64: utf8b64(text) }); takeNew(); mats.unshift(mt); chosen.add(mt.material_id); $('#w-text', m).value = ''; $('#w-paste', m).hidden = true; kpChosen.clear(); drawMats(); analyse(); } catch (e) { fail(e); }
      });
      $$('[data-out]', m).forEach((cb) => cb.addEventListener('change', () => { cb.checked ? outputs.add(cb.dataset.out) : outputs.delete(cb.dataset.out); drawPrimary(); estimate(); }));
      bindModeCards($('#w-exec', m), () => { const top = document.querySelector('#mode-top'); if (top) { const v = modeVal($('#w-exec', m)); top.dataset.value = v; top.querySelectorAll('[data-mode]').forEach((x) => { x.classList.toggle('on', x.dataset.mode === v); x.setAttribute('aria-checked', String(x.dataset.mode === v)); }); } });
      ['#w-primary', '#w-min', '#w-class', '#w-exec', '#w-fw', '#w-size', '#w-pace'].forEach((s) => $(s, m).addEventListener('change', () => { drawPrimary(); estimate(); }));
      $('#w-kpn', m).addEventListener('change', () => { kpChosen.clear(); analyse(); });
      $('#w-adv', m).addEventListener('click', (ev) => { ev.preventDefault(); m.querySelector('.actions button').click(); openAdvanced?.(); });
      drawMats(); drawPrimary(); analyse();
    },
    buttons: [{ label: '取消', value: null }, { label: '开始执行', cls: 'primary', handler: async (m) => {
      if (!chosen.size) { toast('请先导入课程内容', true); return false; }
      return post('/api/jobs', collect(m));
    } }] });
  if (res?.job_id) { toast('任务已开始执行，可随时暂停'); onStarted?.(res); }
}

const ICON = { done: '✓', running: '⟳', pending: '○', error: '!' };
export function jobPanelHtml(job) {
  const st = { running: ['cyan', '执行中'], paused: ['warn', '已暂停'], completed: ['green', '已完成'], failed: ['red', '出错'], cancelled: ['', '已取消'] }[job.status] || ['', job.status];
  const a = job.analysis;
  return `<div class="job"><div class="row" style="gap:6px"><b style="color:var(--screen-strong)">任务进度</b><span class="badge ${st[0]}">${st[1]}</span><span class="badge">${job.config.exec_mode === 'model' ? '大模型生成' : '本地生成 · 不计费'}</span><span class="grow"></span>
    ${job.status === 'running' ? '<button class="small" data-job="pause">暂停</button>' : ''}${['paused', 'failed'].includes(job.status) ? '<button class="small gold" data-job="resume">继续</button>' : ''}${['running', 'paused', 'failed'].includes(job.status) ? '<button class="small ghost" data-job="cancel">取消</button>' : ''}</div>
    ${job.error ? `<div class="notice small" style="margin-top:6px">${esc(job.error)}</div>` : ''}
    ${a ? `<div class="small faint" style="margin-top:4px">课程：${esc(a.course?.name || '—')} · ${a.stats?.knowledge_points ?? 0} 个知识点</div>` : ''}
    <ol class="job-steps">${job.steps.map((s) => `<li class="${s.status}"><span class="ic" aria-hidden="true">${ICON[s.status] || '○'}</span><div><b>${esc(s.label)}</b>${s.message ? `<div class="small faint">${esc(s.message)}</div>` : ''}
      ${s.artifacts?.length ? `<div class="row" style="gap:4px;margin-top:2px">${s.artifacts.map((x) => `<a class="badge gold" href="/library?id=${x.artifact_id}" data-link="/library?id=${x.artifact_id}">${esc(x.title)} · v${x.version}</a>`).join('')}</div>` : ''}
      ${s.key === 'classroom' && s.status === 'running' ? '<a class="small" href="/classroom" data-link="/classroom">去演课场观看 ›</a>' : ''}</div></li>`).join('')}</ol>
    ${job.status === 'completed' ? '<p class="small" style="color:var(--green)">全部完成。以上成果均已保存到产物库，请逐一审阅；本地生成的内容依据导入材料组织，出处已标注。</p>' : ''}</div>`;
}
export function bindJobPanel(root, job, onChange) {
  $$('[data-job]', root).forEach((b) => b.addEventListener('click', async () => {
    if (b.dataset.job === 'cancel' && !confirm('取消后未完成的步骤不再执行，已生成的成果保留。确定取消？')) return;
    try { onChange(await post(`/api/jobs/${job.job_id}/${b.dataset.job}`)); } catch (e) { fail(e); }
  }));
}
