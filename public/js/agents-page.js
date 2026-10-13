// 智能体中心：教师智能体（8 位固定 + 2 位自定义）的形象、设定与资料训练；学生智能体的形象与群体画像导入。
import { get, put, post, del } from './api.js';
import { esc, $, $$, toast, fail, modal, confirmBox, fmtTime } from './ui.js';
import { avatar3d, studentLook, fileToAvatar, setAgentRegistry, orbImg, sisiAvatar } from './avatar3d.js';

const b64 = (file) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(file); });
const portraitOf = (r) => (r.avatar ? orbImg(r.avatar) : avatar3d(r, { tone: 't' }));
const pct = (v) => `${Math.round((v || 0) * 100)}%`;

export async function renderAgents(root, { state, navigate, query, invalidate }) {
  let data = await get('/api/agents');
  let tab = ['students', 'assistant'].includes(query.tab) ? query.tab : 'teachers';
  const sync = () => { invalidate?.(); setAgentRegistry({ roles: data.roles, studentAvatars: data.student_avatars }); };

  root.innerHTML = `<div class="agp">
    <div class="agp-head"><div><h1>智能体中心</h1><p>研课场与演课场中的每一位教师、学生智能体都有固定的姓名与形象。你可以更换形象、设置自定义教师，并导入真实教学数据让智能体更像你的教研团队和你的学生。</p></div></div>
    <div class="agp-tabs" role="tablist"><button type="button" data-tab="teachers">教师智能体</button><button type="button" data-tab="students">学生智能体</button><button type="button" data-tab="assistant">客服数字人 · 思思</button></div>
    <div id="agp-body"></div></div>`;
  const draw = () => {
    $$('.agp-tabs [data-tab]').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', String(b.dataset.tab === tab)); });
    if (tab === 'teachers') drawTeachers(); else if (tab === 'assistant') drawAssistant(); else drawStudents();
  };
  $$('.agp-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; history.replaceState(null, '', `/agents${tab === 'teachers' ? '' : `?tab=${tab}`}`); draw(); }));

  // ---------------- 客服数字人思思 ----------------
  let lastTrain = null;
  async function drawAssistant() {
    const body = $('#agp-body');
    body.innerHTML = '<div class="small faint">正在读取思思的训练状态…</div>';
    let st; try { st = await get('/api/assistant/status'); } catch (e) { body.innerHTML = `<div class="notice red">${esc(e.message)}</div>`; return; }
    const t = lastTrain;
    const v = t ? t.validation : st.validation;
    body.innerHTML = `<div class="sisi-center">
      <section class="panel sisi-card"><div class="sisi-stage">${sisiAvatar()}</div>
        <h2>思思 <small>数字客服 · 平台使用问答</small></h2>
        <p class="small">思思出现在每个页面的右下角。平台所有功能与业务流程的说明文档都是她的知识库：提问时先检索知识库，再由平台共享的大模型组织成简洁的回答，并注明来源；回答可以语音朗读。</p>
        <div class="row" style="gap:6px;flex-wrap:wrap"><span class="badge ${st.model_enabled && st.model_available ? 'green' : 'warn'}">${st.model_enabled && st.model_available ? `大模型：${esc(st.model_name || '已配置')}` : st.model_enabled ? '未配置大模型 · 本地知识库回答' : '管理员已设为仅本地知识库'}</span><span class="badge">不扣积分</span><span class="badge">每人每小时 ${st.hourly_limit} 次大模型问答</span></div>
        <p class="small faint" style="margin:8px 0">训练方式：${esc(st.method)}。API Key 只在服务器使用，不会发送到浏览器。</p>
        <div class="row" style="gap:8px"><button class="primary" id="sisi-train">重新训练</button><button id="sisi-talk">和思思对话</button></div>
        <p class="small faint" style="margin-top:8px">${st.trained_at ? `上次训练：${fmtTime(st.trained_at)}` : '平台启动时已自动完成训练'}</p></section>
      <section class="panel sisi-train"><h3>训练过程与结果</h3>
        ${t ? `<ol class="trv-pipe" style="grid-template-columns:repeat(${t.stages.length},minmax(0,1fr))">${t.stages.map((s) => `<li class="done"><span class="trv-node">✓</span><b>${esc(s.label)}</b><small>${esc(s.detail)}</small></li>`).join('')}</ol>` : '<p class="small faint">点“重新训练”可以查看每个阶段的处理过程。</p>'}
        <div class="trv-stats">${[['说明文档', st.stats.docs], ['知识片段', st.stats.chunks], ['索引项', st.stats.terms], ['验证命中', v ? `${v.hit}/${v.total}` : '—']].map(([l, n]) => `<div><b>${n ?? '—'}</b><span>${l}</span></div>`).join('')}</div>
        <h4>知识来源</h4><table class="data"><tr><th>文档</th><th>片段数</th><th>字数</th></tr>${(t?.sources || st.sources).map((s) => `<tr><td>《${esc(s.doc)}》${s.missing ? ' <span class="badge warn">缺失</span>' : ''}</td><td>${s.chunks}</td><td>${s.chars}</td></tr>`).join('')}</table>
        ${t ? `<h4>检索验证（前 3 条片段中出现期望内容即算命中）</h4><table class="data"><tr><th>验证问题</th><th>最相关片段</th><th>结果</th></tr>${t.validation.items.map((x) => `<tr><td>${esc(x.question)}</td><td class="small">${esc(x.top)}</td><td>${x.ok ? '<span class="badge green">命中</span>' : '<span class="badge warn">未命中</span>'}</td></tr>`).join('')}</table>` : ''}
      </section></div>`;
    $('#sisi-train').addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = '训练中…'; try { lastTrain = await post('/api/assistant/train'); toast(`训练完成：${lastTrain.stats.chunks} 个知识片段，验证命中 ${lastTrain.validation.hit}/${lastTrain.validation.total}`); drawAssistant(); } catch (err) { fail(err); e.target.disabled = false; e.target.textContent = '重新训练'; } });
    $('#sisi-talk').addEventListener('click', () => window.dispatchEvent(new CustomEvent('yz:sisi-open')));
  }

  // ---------------- 教师 ----------------
  function card(k) {
    const r = data.roles[k], custom = data.custom.includes(k), on = !custom || r.enabled;
    return `<article class="agc${on ? '' : ' agc-off'}" data-k="${k}">
      <div class="agc-portrait">${portraitOf(r)}<div class="agc-badge">${custom ? '<span class="gold">自定义</span>' : '<span>固定成员</span>'}${r.docs ? `<span class="green">已训练 · ${r.docs} 份资料</span>` : ''}${custom && !on ? '<span>未启用</span>' : ''}</div></div>
      <div class="agc-body"><h3>${esc(r.person || (custom ? '（未命名）' : ''))}<small>${esc(r.title)}</small></h3><p>${esc(r.duty || (custom ? '可设置为专业课教师、专业博导、企业工程师等，并填写专属提示词。' : ''))}</p>
        ${r.style?.summary ? `<div class="agc-style">${esc(r.style.summary)}</div>` : ''}
        <div class="agc-actions">${custom ? `<button type="button" class="small primary" data-act="edit">${on ? '编辑设定' : '设置并启用'}</button>` : ''}
          <button type="button" class="small" data-act="train">导入数据训练</button>
          <label class="small agc-up" style="cursor:pointer"><span class="ghost" style="display:inline-block;padding:5px 10px;border:1px solid var(--line);border-radius:8px">更换形象</span><input type="file" accept="image/png,image/jpeg,image/webp" data-act="avatar" hidden></label>
          ${r.avatar ? '<button type="button" class="small ghost" data-act="reset">恢复默认形象</button>' : ''}</div></div></article>`;
  }
  function drawTeachers() {
    $('#agp-body').innerHTML = `<p class="small faint" style="margin:0 0 10px">所有人物都以 3D 水晶圆球中的仿真形象呈现：教师为暖金玻璃球，学生为冰晶蓝玻璃球。形象由本地渲染生成、参数固定，与能力无关，无需上传任何照片。如确有需要，也可以上传已获授权的图片，同样会放进水晶球中。</p>
      <div class="agp-grid">${[...data.fixed, ...data.custom].map(card).join('')}</div>`;
    $$('#agp-body .agc').forEach((el) => {
      const k = el.dataset.k;
      $('[data-act="edit"]', el)?.addEventListener('click', () => editCustom(k));
      $('[data-act="train"]', el).addEventListener('click', () => openTraining(k));
      $('[data-act="reset"]', el)?.addEventListener('click', async () => { try { data.roles[k] = await put(`/api/agents/${k}`, { avatar: null }); sync(); drawTeachers(); } catch (e) { fail(e); } });
      $('[data-act="avatar"]', el).addEventListener('change', async (ev) => { const f = ev.target.files[0]; if (!f) return; try { data.roles[k] = await put(`/api/agents/${k}`, { avatar: await fileToAvatar(f) }); sync(); drawTeachers(); toast('形象已更新'); } catch (e) { fail(e); } });
    });
  }
  async function editCustom(k) {
    const r = data.roles[k];
    const res = await modal({ title: `自定义教师：${r.title}`, wide: true, body: `<div class="grid3">
        <label>从模板开始<select id="ce-preset"><option value="">（不使用模板）</option>${data.presets.map((p, i) => `<option value="${i}">${esc(p.title)}</option>`).join('')}</select></label>
        <label>角色名称 *<input id="ce-title" maxlength="20" value="${esc(r.custom && r.enabled ? r.title : '')}" placeholder="如：专业博导"></label>
        <label>姓名（虚构）<input id="ce-person" maxlength="12" value="${esc(r.person || '')}" placeholder="如：顾怀瑾"></label></div>
      <label>职责（一句话）<input id="ce-duty" maxlength="60" value="${esc(r.duty || '')}" placeholder="如：学科前沿、研究方法与学术规范"></label>
      <label>专属提示词（大模型运行时作为该教师的角色设定；本地生成时用于确定发言视角）<textarea id="ce-prompt" rows="6" maxlength="1500" placeholder="描述这位教师的身份、经验、关注点和发言方式">${esc(r.prompt || '')}</textarea></label>
      <label class="inline"><input type="checkbox" id="ce-on" ${r.enabled || !r.custom ? 'checked' : ''}> 启用（可在研课场“席位设置”中让其入席）</label>
      <p class="small faint">提示词只能描述角色，不能要求忽略平台规则；平台的真实性要求（不编造政策、数据与文献）始终优先。</p>`,
      onMount: (m) => $('#ce-preset', m).addEventListener('change', (e) => { const p = data.presets[e.target.value]; if (!p) return; $('#ce-title', m).value = p.title; $('#ce-duty', m).value = p.duty; $('#ce-prompt', m).value = p.prompt; }),
      buttons: [{ label: '取消', value: null }, { label: '保存', cls: 'primary', handler: async (m) => put(`/api/agents/${k}`, { title: $('#ce-title', m).value, person: $('#ce-person', m).value, duty: $('#ce-duty', m).value, prompt: $('#ce-prompt', m).value, enabled: $('#ce-on', m).checked }) }] });
    if (res) { data.roles[k] = res; sync(); drawTeachers(); toast('已保存；在研课场的“席位设置”中勾选即可入席'); }
  }

  // ---------------- 资料训练（可视化） ----------------
  async function openTraining(k) {
    const r = data.roles[k];
    let detail = await get(`/api/agents/${k}`), files = [], poll = null;
    const body = `<div class="trv">
      <div class="notice small">这里的“训练”是<b>知识与风格注入</b>：把你导入的真实教学资料去标识化、切分入库并提取表达风格；研讨时，这位教师会检索并引用自己的资料（本地生成直接引用原文，大模型模式写入提示词）。<b>不会修改大模型本身的参数。</b></div>
      <div><b class="small" style="color:var(--red)">数据采集原则（请逐条阅读）</b><ul class="principles" style="margin-top:6px">${data.principles.map(([t, d]) => `<li><b>${esc(t)}</b>${esc(d)}</li>`).join('')}</ul></div>
      <div class="row" style="gap:10px;align-items:center"><label class="inline" style="cursor:pointer"><span class="badge gold" style="padding:6px 12px">⬆ 选择资料（DOCX/PPTX/XLSX/TXT，可多选）</span><input type="file" id="tr-files" multiple accept=".docx,.pptx,.xlsx,.txt,.md,.csv" hidden></label>
        <select id="tr-kind" style="width:auto"><option>教案</option><option>讲稿/说课稿</option><option>课堂实录（已脱敏）</option><option>评课/教研发言</option><option>论文/专著（有权使用部分）</option><option>其他教学资料</option></select>
        <span class="small faint" id="tr-picked">未选择文件</span></div>
      <label class="inline"><input type="checkbox" id="tr-consent"> 我已阅读并遵守以上数据采集原则，资料来源合法、已去除学生个人信息</label>
      <div id="tr-vis"></div>
      <div id="tr-docs"></div></div>`;
    const drawDocs = (m) => { $('#tr-docs', m).innerHTML = detail.docs.length ? `<b class="small">已导入的资料（${detail.docs.length}）</b><table class="data" style="margin-top:4px"><thead><tr><th>文件</th><th>类别</th><th>字数</th><th>隐去个人信息</th><th>导入时间</th><th></th></tr></thead><tbody>${detail.docs.map((d) => `<tr><td>${esc(d.filename)}</td><td>${esc(d.kind || '')}</td><td>${d.n_chars}</td><td>${Object.values(d.pii_flags || {}).reduce((a, b) => a + b, 0) || '—'}</td><td class="small">${fmtTime(d.created_at)}</td><td><button type="button" class="small ghost" data-del="${d.doc_id}">撤回</button></td></tr>`).join('')}</tbody></table>` : '<p class="small faint">还没有导入资料。</p>';
      $$('[data-del]', m).forEach((b) => b.addEventListener('click', async () => { if (!(await confirmBox('撤回资料', '<p>删除后该资料不再参与这位教师的发言。</p>', '删除', 'danger'))) return; try { await del(`/api/agents/${k}/docs/${b.dataset.del}`); detail = await get(`/api/agents/${k}`); drawDocs(m); } catch (e) { fail(e); } })); };
    const drawVis = (m, t) => { $('#tr-vis', m).innerHTML = t ? trainingVis(t, data.stages) : ''; };
    await modal({ title: `导入数据训练：${r.person ? `${r.person} · ` : ''}${r.title}`, wide: true, body,
      onMount: (m) => {
        drawDocs(m); if (detail.latest) drawVis(m, detail.latest);
        $('#tr-files', m).addEventListener('change', (e) => { files = [...e.target.files]; $('#tr-picked', m).textContent = files.length ? `${files.length} 份：${files.map((f) => f.name).join('、').slice(0, 80)}` : '未选择文件'; });
      },
      buttons: [{ label: '关闭', value: null }, { label: '开始训练', cls: 'primary', handler: async (m) => {
        if (!files.length) { toast('请先选择资料', true); return false; }
        if (!$('#tr-consent', m).checked) { toast('请先确认数据采集原则', true); return false; }
        const payload = []; for (const f of files) { if (f.size > 15 * 1024 * 1024) { toast(`${f.name} 超过 15MB`, true); return false; } payload.push({ filename: f.name, kind: $('#tr-kind', m).value, data_base64: await b64(f) }); }
        let t; try { t = await post(`/api/agents/${k}/train`, { consent: true, files: payload }); } catch (e) { fail(e); return false; }
        drawVis(m, t); m.querySelector('.actions button:last-child').disabled = true;
        clearInterval(poll);
        poll = setInterval(async () => {
          try {
            t = await get(`/api/agents/${k}/trainings/${t.train_id}`); drawVis(m, t);
            if (t.status !== 'running') { clearInterval(poll); m.querySelector('.actions button:last-child').disabled = false; detail = await get(`/api/agents/${k}`); drawDocs(m); data = await get('/api/agents'); sync(); if (t.status === 'done') toast('训练完成：这位教师之后的研讨发言会引用这些资料'); }
          } catch { /* transient */ }
        }, 400);
        return false;
      } }] });
    clearInterval(poll); drawTeachers();
  }

  // ---------------- 学生 ----------------
  function drawStudents() {
    const list = data.students;
    $('#agp-body').innerHTML = `<div class="grid2" style="align-items:start;gap:16px">
      <section class="panel"><h2 style="margin-top:0">学生群体画像</h2>
        <p class="small muted">导入一个班级的匿名画像表（CSV / XLSX），系统会识别字段、标准化、按先修水平异质分组，并把每一行分配给一名学生智能体（代号保留，姓名不进入平台）。开课时在演课场选择这份画像即可。</p>
        <div class="row" style="gap:8px"><button type="button" class="primary" id="cp-import">导入群体数据</button><button type="button" class="ghost" id="cp-template">下载模板（CSV）</button></div>
        <div id="cp-list" style="margin-top:10px"></div></section>
      <section class="panel"><h2 style="margin-top:0">学生智能体形象 <small class="faint" style="font-size:.6em">（前 40 名固定姓名）</small></h2>
        <p class="small muted">点击学生可上传形象图片；也可一次选择多张图片，文件名写成“S01.jpg”或学生姓名（如“赵子涵.png”）会自动对应。</p>
        <label class="inline" style="cursor:pointer"><span class="badge gold" style="padding:6px 12px">⬆ 批量上传学生形象</span><input type="file" id="stu-bulk" multiple accept="image/png,image/jpeg,image/webp" hidden></label>
        <div class="stu-grid" style="margin-top:10px">${list.map((s, i) => `<button type="button" class="stu-card" data-seat="${i}"><span class="cl-ava">${data.student_avatars[i] ? orbImg(data.student_avatars[i]) : avatar3d(studentLook(i, s.gender), { tone: 's' })}</span><b>${esc(s.name)}</b><small>S${String(i + 1).padStart(2, '0')} · 第${Math.floor(i / 5) + 1}组</small></button>`).join('')}</div></section></div>`;
    drawProfiles();
    $('#cp-import').addEventListener('click', importProfile);
    $('#cp-template').addEventListener('click', () => {
      const rows = ['代号,前测成绩,兴趣方向,发言活跃度,质疑倾向,合作倾向,常见误解', 'S01,82,工程应用,高,中,高,', 'S02,65,数据分析,中,低,中,把公差和偏差混为一谈', 'S03,48,案例讨论,低,低,高,不会读公差标注', 'S04,91,理论推导,中,高,中,'];
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`﻿${rows.join('\n')}\n`], { type: 'text/csv' })); a.download = '学生群体画像模板.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $$('.stu-card').forEach((b) => b.addEventListener('click', () => pickOne(Number(b.dataset.seat))));
    $('#stu-bulk').addEventListener('change', async (e) => {
      let n = 0;
      for (const f of e.target.files) {
        const base = f.name.replace(/\.[a-z]+$/i, '').trim(), m = base.match(/^S?0*(\d{1,3})$/i);
        const seat = m ? Number(m[1]) - 1 : list.findIndex((s) => s.name === base);
        if (seat < 0 || seat >= 300) continue;
        try { await put(`/api/student-avatars/${seat}`, { avatar: await fileToAvatar(f, 192) }); n++; } catch (err) { fail(err); }
      }
      data = await get('/api/agents'); sync(); drawStudents(); toast(`已对应 ${n} 名学生的形象${n < e.target.files.length ? `（${e.target.files.length - n} 个文件名无法对应）` : ''}`);
    });
  }
  function pickOne(seat) {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/jpeg,image/webp';
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { await put(`/api/student-avatars/${seat}`, { avatar: await fileToAvatar(f, 192) }); data = await get('/api/agents'); sync(); drawStudents(); } catch (e) { fail(e); } };
    inp.click();
  }
  function drawProfiles() {
    const ps = data.class_profiles;
    $('#cp-list').innerHTML = ps.length ? `<table class="data"><thead><tr><th>画像</th><th>人数</th><th>分组</th><th>导入时间</th><th></th></tr></thead><tbody>${ps.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td>${p.n}</td><td>${p.stats?.groups || '—'} 组 × ${p.group_size}</td><td class="small">${fmtTime(p.created_at)}</td><td><div class="row" style="gap:4px;flex-wrap:nowrap"><button type="button" class="small" data-view="${p.profile_id}">查看</button><button type="button" class="small primary" data-use="${p.profile_id}">用于开课</button><button type="button" class="small ghost" data-rm="${p.profile_id}">删除</button></div></td></tr>`).join('')}</tbody></table>` : '<p class="small faint">还没有班级画像。未导入时，学生智能体使用系统按设置随机生成的参数。</p>';
    $$('[data-view]').forEach((b) => b.addEventListener('click', async () => showProfile(await get(`/api/class-profiles/${b.dataset.view}`), false)));
    $$('[data-use]').forEach((b) => b.addEventListener('click', () => { try { localStorage.setItem('yz-class-profile', b.dataset.use); } catch { /* ignore */ } toast('已选择：演课场下一次开课将使用这份画像'); navigate('/classroom'); }));
    $$('[data-rm]').forEach((b) => b.addEventListener('click', async () => { if (!(await confirmBox('删除班级画像', '<p>删除后不再用于新开的课堂，已结束的课堂记录不受影响。</p>', '删除', 'danger'))) return; try { await del(`/api/class-profiles/${b.dataset.rm}`); data = await get('/api/agents'); drawProfiles(); } catch (e) { fail(e); } }));
  }
  async function importProfile() {
    let file = null;
    const res = await modal({ title: '导入学生群体数据', wide: true, body: `<div class="trv">
      <div><b class="small" style="color:var(--red)">学生数据采集原则</b><ul class="principles" style="margin-top:6px">${data.student_principles.map(([t, d]) => `<li><b>${esc(t)}</b>${esc(d)}</li>`).join('')}</ul></div>
      <div class="grid3"><label>画像名称<input id="cp-name" placeholder="如：机械 2301 班 · 2025 秋"></label><label>每组人数<input id="cp-gs" type="number" min="2" max="12" value="5"></label>
        <label>文件（CSV / XLSX）<input id="cp-file" type="file" accept=".csv,.xlsx,.txt"></label></div>
      <p class="small faint">可识别的列：代号、前测/先修成绩（0—100 或 优良中差/A—E）、兴趣方向、发言活跃度、质疑倾向、合作倾向（高中低或 1—5）、常见误解/备注。姓名、学号列会被丢弃。</p>
      <label class="inline"><input type="checkbox" id="cp-consent"> 我已阅读并遵守以上原则，数据已匿名化，仅用于教学模拟</label></div>`,
      onMount: (m) => $('#cp-file', m).addEventListener('change', (e) => { file = e.target.files[0]; }),
      buttons: [{ label: '取消', value: null }, { label: '导入并分配', cls: 'primary', handler: async (m) => {
        if (!file) { toast('请选择文件', true); return false; }
        if (!$('#cp-consent', m).checked) { toast('请先确认学生数据采集原则', true); return false; }
        return post('/api/class-profiles', { consent: true, filename: file.name, name: $('#cp-name', m).value || file.name.replace(/\.[a-z]+$/i, ''), group_size: Number($('#cp-gs', m).value) || 5, data_base64: await b64(file) });
      } }] });
    if (!res) return;
    data = await get('/api/agents'); drawProfiles(); showProfile(res, true);
  }
  async function showProfile(p, animate) {
    const names = data.students;
    await modal({ title: `班级画像：${p.name}`, wide: true, body: `<div class="trv">
      <ol class="trv-pipe cp-pipe" style="grid-template-columns:repeat(${p.stages.length},minmax(0,1fr))">${p.stages.map((s, i) => `<li class="${animate ? '' : 'done'}" data-i="${i}"><span class="trv-node">${i + 1}</span><b>${esc(s.label)}</b><small>${esc(s.detail)}</small></li>`).join('')}</ol>
      <div class="trv-charts"><div class="trv-box"><h4>先修水平分布</h4>${histBars(p.stats.dist?.prior)}<h4 style="margin-top:8px">发言活跃度分布</h4>${histBars(p.stats.dist?.express, 'blue')}</div>
        <div class="trv-box"><h4>各组平均先修水平（异质分组）</h4>${(p.stats.group_means || []).map((v, i) => `<div class="trv-bar"><span>第${i + 1}组</span><i><em style="width:${v}%"></em></i><span>${v}</span></div>`).join('')}</div></div>
      <div class="trv-box"><h4>分配结果（画像行 → 学生智能体）</h4><div class="cp-assign"><table class="data"><thead><tr><th>学生智能体</th><th>组</th><th>画像代号</th><th>先修</th><th>表达</th><th>质疑</th><th>合作</th><th>兴趣</th><th>常见误解</th></tr></thead><tbody>
        ${p.rows.map((r, i) => `<tr><td>${esc(i < names.length ? names[i].name : `第${i + 1}位`)}</td><td>第${Math.floor(i / p.group_size) + 1}组</td><td>${esc(r.code)}</td><td>${pct(r.prior)}</td><td>${pct(r.express)}</td><td>${pct(r.skeptic)}</td><td>${pct(r.coop)}</td><td>${esc(r.interests.join('、') || '—')}</td><td>${esc(r.note || '—')}</td></tr>`).join('')}</tbody></table></div></div>
      ${animate ? '<p class="trv-note">各阶段的结果由服务器实际计算得出；为便于观察，依次展开显示。</p>' : ''}</div>`,
      onMount: (m) => { if (!animate) return; $$('.cp-pipe li', m).forEach((li, i) => { setTimeout(() => li.classList.add('running'), i * 420); setTimeout(() => { li.classList.remove('running'); li.classList.add('done'); }, i * 420 + 380); }); },
      buttons: [{ label: '关闭', value: null }, { label: '用于开课', cls: 'primary', handler: async () => { try { localStorage.setItem('yz-class-profile', p.profile_id); } catch { /* ignore */ } navigate('/classroom'); } }] });
  }
  draw();
}

function histBars(b = [0, 0, 0, 0, 0], cls = '') {
  const max = Math.max(1, ...b), lab = ['0—20%', '20—40%', '40—60%', '60—80%', '80—100%'];
  return b.map((v, i) => `<div class="trv-bar ${cls}"><span>${lab[i]}</span><i><em style="width:${(v / max) * 100}%"></em></i><span>${v} 人</span></div>`).join('');
}
export function trainingVis(t, stages) {
  const done = t.stages.filter((s) => s.status === 'done').length, st = t.stats || {};
  const flow = `${Math.min(92, (done / t.stages.length) * 92)}%`;
  const ICON = { pending: '', running: '', done: '✓', error: '!' };
  const bars = (items, key, max) => items.map((x) => `<div class="trv-bar"><span>${esc(x.term)}</span><i><em style="width:${(x[key] / max) * 100}%"></em></i><span>${x[key]}</span></div>`).join('');
  const sty = st.style;
  return `<div class="trv-box"><h4>训练过程 ${t.status === 'running' ? '<span class="badge cyan">进行中</span>' : t.status === 'done' ? '<span class="badge green">已完成</span>' : t.status === 'failed' ? '<span class="badge red">未完成</span>' : ''}</h4>
    <div style="position:relative"><ol class="trv-pipe">${t.stages.map((s, i) => `<li class="${s.status}"><span class="trv-node">${ICON[s.status] || i + 1}</span><b>${esc(s.label)}</b><small>${esc(s.detail || (s.status === 'pending' ? '等待中' : s.status === 'running' ? '处理中…' : ''))}</small></li>`).join('')}</ol><i class="trv-flow" style="width:${flow}"></i></div>
    <p class="trv-note">每个阶段都是真实处理；为便于观察，每个阶段至少展示 ${(t.min_stage_ms / 1000).toFixed(1)} 秒。</p></div>
    <div class="trv-stats"><div><b>${st.files ?? '—'}</b><span>资料份数</span></div><div><b>${st.chars ?? '—'}</b><span>抽取字数</span></div><div><b>${st.pii_total ?? '—'}</b><span>隐去个人信息</span></div><div><b>${st.removed_lines ?? '—'}</b><span>清洗掉的行</span></div><div><b>${st.chunks ?? '—'}</b><span>新增知识片段</span></div><div><b>${st.coverage != null ? `${st.coverage}%` : '—'}</b><span>检索验证命中率</span></div></div>
    ${st.terms?.length || sty ? `<div class="trv-charts"><div class="trv-box"><h4>高频主题（出现次数）</h4>${st.terms?.length ? bars(st.terms.slice(0, 10), 'count', Math.max(...st.terms.map((x) => x.count))) : '<p class="small faint">—</p>'}</div>
      <div class="trv-box"><h4>表达风格（占全部句子的比例）</h4>${sty ? [['提问推进', sty.question_pct], ['举例说明', sty.example_pct], ['引导思考', sty.guide_pct], ['及时小结', sty.summary_pct], ['思政表述', sty.ideology_pct]].map(([l, v]) => `<div class="trv-bar blue"><span>${l}</span><i><em style="width:${Math.min(100, v * 2)}%"></em></i><span>${v}%</span></div>`).join('') + `<p class="small faint" style="margin:6px 0 0">共 ${sty.sentences} 句，平均句长 ${sty.avg_len} 字</p>` : ''}</div></div>` : ''}
    ${t.profile ? `<div class="agc-style"><b>人设画像：</b>${esc(t.profile.summary)}</div>` : ''}
    ${st.verify?.length ? `<div class="trv-box"><h4>检索验证</h4><table class="data"><tbody>${st.verify.map((v) => `<tr><td style="width:90px"><b>${esc(v.query)}</b></td><td class="small">${v.hit ? esc(v.hit) : '<span class="faint">未命中</span>'}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
}
