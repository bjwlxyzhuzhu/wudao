// 通用“智能导入 / 导出”：选文件 → 自动识别表头并匹配字段（可手动调整）→ 逐行校验预览 → 导入；
// 导出 XLSX（中文表头 + 字段说明）/ CSV（字段键表头，便于 R/Python）/ SPSS（CSV + 语法）/ JSON，以及只有表头的导入模板。
import { post, download } from './api.js';
import { esc, $, $$, modal, toast, fail } from './ui.js';

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
export const exportUrl = (dataset, ctx, format) => `/api/io/export?${qs({ dataset, format, ...ctx })}`;
const readB64 = (f) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(f); });
const FORMATS = { xlsx: ['Excel（.xlsx）', '中文表头，另附“字段说明”工作表'], csv: ['CSV（UTF-8）', '字段键作表头，适合 R / Python / NVivo'], sps: ['SPSS', 'CSV + .sps 读取语法（变量标签、值标签）'], json: ['JSON', '含字段定义，适合程序处理'] };

/** Small toolbar: 导入 / 导出 / 模板. Returns HTML; call bindIo(root) after inserting. */
export const ioButtons = (dataset, ctx, { importLabel = '智能导入', exportLabel = '导出', template = true, canImport = true } = {}) =>
  `<span class="io-bar" data-io="${esc(dataset)}" data-ctx="${esc(JSON.stringify(ctx))}">${canImport ? `<button type="button" class="small io-imp" title="支持 .xlsx / .csv / .tsv / .json；表头可用自己的叫法">⇪ ${esc(importLabel)}</button>` : ''}<button type="button" class="small io-exp">⇩ ${esc(exportLabel)}</button>${template && canImport ? '<button type="button" class="small ghost io-tpl" title="下载只有表头与字段说明的空模板">模板</button>' : ''}</span>`;
export function bindIo(root, handlers = {}) {
  $$('.io-bar', root).forEach((bar) => {
    const dataset = bar.dataset.io, ctx = JSON.parse(bar.dataset.ctx || '{}'), h = handlers[dataset] || handlers['*'] || {};
    bar.querySelector('.io-imp')?.addEventListener('click', () => openImport({ dataset, ctx, ...h }));
    bar.querySelector('.io-exp')?.addEventListener('click', () => openExport({ dataset, ctx, title: h.title, formats: h.formats }));
    bar.querySelector('.io-tpl')?.addEventListener('click', () => download(exportUrl(dataset, ctx, 'template')));
  });
}

export async function openExport({ dataset, ctx, title = '导出数据', formats = ['xlsx', 'csv', 'sps', 'json'], note }) {
  await modal({ title, body: `${note ? `<p class="small muted">${esc(note)}</p>` : ''}<div class="io-formats">${formats.map((f) => `<button type="button" class="io-fmt" data-fmt="${f}"><b>${FORMATS[f][0]}</b><span class="small faint">${FORMATS[f][1]}</span></button>`).join('')}</div>
    <p class="small faint" style="margin-top:10px">被试相关数据只导出“已同意”的被试；未同意、已退出者不出现在导出文件中。</p>`,
  onMount: (m) => $$('[data-fmt]', m).forEach((b) => b.addEventListener('click', () => { download(exportUrl(dataset, ctx, b.dataset.fmt)); toast('已开始下载'); })) });
}

/**
 * Import wizard. onDone(result) after a server commit; for preview-only datasets (产物表格) onRecords(records, mode) receives normalized rows.
 */
export async function openImport({ dataset, ctx, title, hint, onDone, onRecords }) {
  let file = null, b64 = '', pv = null, busy = false;
  const state = { sheet: 0, header_row: 0, mapping: null };
  const run = async (m) => {
    if (!file || busy) return; busy = true; $('#io-pv', m).innerHTML = '<div class="small faint">正在识别表头与校验…</div>';
    try { pv = await post('/api/io/preview', { dataset, ctx, filename: file.name, data_base64: b64, sheet: state.sheet, header_row: state.header_row, mapping: state.mapping }); draw(m); }
    catch (e) { $('#io-pv', m).innerHTML = `<div class="notice red">${esc(e.message)}</div>`; pv = null; }
    busy = false;
  };
  const draw = (m) => {
    const opts = (sel) => `<option value="">— 不导入 —</option>${pv.fields.map((f) => `<option value="${esc(f.key)}" ${sel === f.key ? 'selected' : ''}>${esc(f.label)}${f.required ? ' *' : ''}</option>`).join('')}`;
    const conf = (x) => (!x.field ? '' : x.score == null ? '<span class="badge">手动</span>' : x.score >= 0.95 ? '<span class="badge green">精确</span>' : x.score >= 0.8 ? '<span class="badge cyan">高</span>' : '<span class="badge warn">请核对</span>');
    $('#io-pv', m).innerHTML = `
      ${pv.sheets.length > 1 ? `<label class="inline small">工作表 <select id="io-sheet">${pv.sheets.map((s, i) => `<option value="${i}" ${i === pv.sheet ? 'selected' : ''}>${esc(s.name)}（${s.rows} 行）</option>`).join('')}</select></label>` : ''}
      <label class="inline small">表头在第 <input id="io-hr" type="number" min="1" max="20" value="${pv.header_row + 1}" style="width:64px"> 行</label>
      <div class="io-sum"><span class="badge">共 ${pv.n_rows} 行</span><span class="badge green">可导入 ${pv.n_valid}</span>${pv.n_errors ? `<span class="badge red">有问题 ${pv.n_errors}</span>` : ''}${pv.unmapped_required.length ? `<span class="badge red">缺少必填：${esc(pv.unmapped_required.join('、'))}</span>` : ''}</div>
      ${pv.ignored_pii_columns.length ? `<div class="notice" style="margin:6px 0">已自动忽略疑似个人身份信息列：${esc(pv.ignored_pii_columns.join('、'))}（不会读入平台）</div>` : ''}
      ${Object.keys(pv.pii_values || {}).length ? `<div class="notice" style="margin:6px 0">内容中检测到 ${esc(Object.entries(pv.pii_values).map(([k, v]) => `${k}${v}处`).join('、'))}：请确认这些列不导入，或在源文件中删除后再导入。</div>` : ''}
      <div class="scroll-x" style="max-height:38vh"><table class="data io-map"><thead><tr><th>你的表头</th><th>样例值</th><th>对应字段</th><th>匹配</th></tr></thead><tbody>
        ${pv.mapping.map((x) => `<tr><td><b>${esc(x.column)}</b></td><td class="small faint">${esc(pv.sample.slice(0, 3).map((r) => r[x.index] ?? '').filter((v) => v !== '').join(' ｜ ').slice(0, 60))}</td><td><select data-map="${x.index}" aria-label="“${esc(x.column)}”对应的字段">${opts(x.field)}</select></td><td>${conf(x)}${x.how && !x.field ? `<span class="small faint">${esc(x.how)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
      ${pv.n_errors ? `<details class="io-errs" open><summary class="small" style="color:var(--warn);cursor:pointer">问题行（显示前 ${Math.min(pv.errors.length, 200)} 条）</summary><div style="max-height:22vh;overflow:auto">${pv.errors.map((e) => `<div class="small">第 ${e.row} 行：${esc(e.messages.join('；'))}</div>`).join('')}</div></details>` : ''}
      <details class="small" style="margin-top:6px"><summary style="cursor:pointer;color:var(--gold)">字段说明</summary><table class="data"><tr><th>字段</th><th>类型</th><th>说明</th></tr>${pv.fields.map((f) => `<tr><td>${esc(f.label)}${f.required ? ' *' : ''}</td><td>${esc(f.type)}</td><td class="faint">${esc(f.help || (f.options ? `可选：${f.options.join(' / ')}` : ''))}</td></tr>`).join('')}</table></details>
      ${pv.preview_only ? `<div class="row" style="margin-top:8px"><label class="inline small"><input type="radio" name="io-mode" value="append" checked> 追加到表格末尾</label><label class="inline small"><input type="radio" name="io-mode" value="replace"> 替换表格现有行</label></div>`
        : `<div class="row" style="margin-top:8px"><label class="inline small"><input type="radio" name="io-mode" value="upsert" checked> 按编码更新已有记录，新增其余</label><label class="inline small"><input type="radio" name="io-mode" value="append"> 只新增（已有编码跳过）</label>${pv.n_errors ? '<label class="inline small"><input type="checkbox" id="io-skip"> 跳过有问题的行</label>' : ''}</div>`}`;
    $('#io-sheet', m)?.addEventListener('change', (e) => { state.sheet = Number(e.target.value); state.header_row = 0; state.mapping = null; run(m); });
    $('#io-hr', m).addEventListener('change', (e) => { state.header_row = Math.max(0, Number(e.target.value) - 1); state.mapping = null; run(m); });
    $$('[data-map]', m).forEach((s) => s.addEventListener('change', () => { state.mapping = pv.mapping.map((x) => $(`[data-map="${x.index}"]`, m).value || null); run(m); }));
  };
  const res = await modal({ title: title || '智能导入', wide: true,
    body: `<div class="io-drop"><label class="io-file"><input type="file" id="io-file" accept=".xlsx,.csv,.tsv,.txt,.json"><span>选择文件（.xlsx / .csv / .tsv / .json）</span></label>
      <button type="button" class="small ghost" id="io-tpl">下载空模板</button></div>
      <p class="small muted" style="margin:6px 0">${esc(hint || '表头可以用你自己的叫法，系统会按同义词和相似度自动对应字段；“请核对”的列建议手动确认。导入前逐行校验，有问题的行不会写入。')}</p>
      <div id="io-pv"></div>`,
    onMount: (m) => {
      $('#io-tpl', m).addEventListener('click', () => download(exportUrl(dataset, ctx, 'template')));
      $('#io-file', m).addEventListener('change', async (e) => { file = e.target.files[0]; if (!file) return; if (file.size > 20 * 1024 * 1024) { fail(new Error('文件超过 20MB')); return; } b64 = await readB64(file); state.sheet = 0; state.header_row = 0; state.mapping = null; $('.io-file span', m).textContent = file.name; run(m); });
    },
    buttons: [{ label: '取消', value: null }, { label: onRecords ? '填入表格' : '确认导入', cls: 'primary', handler: async (m) => {
      if (!pv) { toast('请先选择文件', true); return false; }
      const mode = $('input[name="io-mode"]:checked', m)?.value;
      if (pv.preview_only) { if (!pv.records.length) { toast('没有可导入的有效行', true); return false; } onRecords?.(pv.records, mode, ctx); toast(`已填入 ${pv.records.length} 行，请检查后保存`); return { records: pv.records.length }; }
      const r = await post('/api/io/commit', { dataset, ctx, filename: file.name, data_base64: b64, sheet: state.sheet, header_row: state.header_row, mapping: state.mapping, mode, skip_invalid: !!$('#io-skip', m)?.checked });
      toast(`导入完成：新增 ${r.inserted}，更新 ${r.updated}，跳过 ${r.skipped}${r.skipped_invalid ? `，未通过校验 ${r.skipped_invalid}` : ''}`);
      return r;
    } }] });
  if (res && onDone) onDone(res);
  return res;
}
