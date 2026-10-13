// Render artifacts to neutral blocks → printable HTML and editable DOCX (WordprocessingML).
import { zip } from './zip.js';
import { studentView, derivedViews } from './artifacts.js';
import { COURSE_FIELDS } from './templates.js';

const TYPE_NAME = { talent_plan: '人才培养方案（课程思政融入）', course_design: '课程教学设计', teaching_schedule: '教学计划进度表', syllabus: '思政版教学大纲', semester_plan: '学期教学设计', lesson_plan: '单课教案', courseware: '课程思政课件', exercises: '模拟练习', exam: '模拟试卷', reflection_report: '教学反思报告', classroom_feedback: '课堂反馈', legacy_plan: '旧版方案（迁移）' };
export const DOCX_TYPES = ['talent_plan', 'course_design', 'teaching_schedule', 'syllabus', 'semester_plan', 'lesson_plan', 'exercises', 'exam', 'reflection_report', 'classroom_feedback', 'legacy_plan'];

/** variant: 'teacher' (full) | 'student' (teacher-only columns removed; exam → student paper) | 'answers' (exam answer paper) */
export function blocks(a, variant = 'teacher') {
  const body = variant === 'student' ? studentView(a.body) : a.body;
  const out = [];
  const suffix = a.type === 'exam' ? (variant === 'student' ? '（学生卷）' : variant === 'answers' ? '（教师答案卷）' : '') : '';
  out.push({ h: 1, text: `${a.title}${suffix}` });
  if (variant !== 'student') out.push({ note: `${TYPE_NAME[a.type] || a.type} · 第 ${a.version} 版 · ${a.status === 'saved' ? '已保存' : '草稿'}${body.framework ? ` · 框架：${body.framework.name}${body.with_pdca ? '+PDCA' : ''}` : ''} · ${a.artifact_id}` });
  if (body.ai_assisted || /AI|演示/.test(body.notice || '')) out.push({ note: body.notice || 'AI 辅助草案，须经教师审核后使用。' });
  if (a.type === 'exam' && variant !== 'teacher') return out.concat(examPaper(body, variant));
  const course = COURSE_FIELDS.filter(([k]) => body.course?.[k] != null && body.course[k] !== '').map(([k, label]) => [label, String(body.course[k])]);
  if (course.length && variant !== 'student') { out.push({ h: 2, text: '课程信息' }); out.push({ table: { head: ['项目', '内容'], rows: course } }); }
  if (body.framework && Object.keys(body.framework.fields || {}).length && variant !== 'student') {
    out.push({ h: 2, text: `框架要素（${body.framework.name}）` });
    out.push({ table: { head: ['要素', '内容'], rows: Object.entries(body.framework.fields).map(([k, v]) => [k, v]) } });
  }
  const stepLabel = (v) => (body.framework?.steps || []).find(([k]) => k === v)?.[1] || v;
  for (const s of body.sections) {
    out.push({ h: 2, text: s.title + (s.author && variant !== 'student' ? `　〔${s.author}〕` : '') });
    if (s.kind === 'text') { for (const para of String(s.content || '').split(/\n+/)) if (para.trim()) out.push({ p: para }); if (!String(s.content || '').trim()) out.push({ p: '（空）' }); }
    else if (s.rows.length) out.push({ table: { head: s.columns.map((c) => c.label), rows: s.rows.map((r) => s.columns.map((c) => (c.type === 'stage' ? stepLabel(r[c.key]) : r[c.key]) ?? '')) } });
    else out.push({ p: '（无条目）' });
  }
  const dv = derivedViews(a.type, body);
  if (dv.alignment && variant !== 'student') { out.push({ h: 2, text: '目标—活动—评价一致性' }); out.push({ table: { head: ['目标', '类别', '支撑阶段', '评价所在阶段'], rows: dv.alignment.map((m) => [m.goal, m.category, m.activities.join('、') || '—', m.assessed_in.join('、') || '—']) } }); }
  if (dv.matrix && variant !== 'student') { out.push({ h: 2, text: '目标—内容—评价矩阵' }); out.push({ table: { head: ['目标', '类别', '内容单元', '考核项'], rows: dv.matrix.map((m) => [m.goal, m.category, m.content.join('、') || '—', m.assessment.join('、') || '—']) } }); }
  if (dv.blueprint && variant === 'teacher') { out.push({ h: 2, text: '双向细目表（分值）' }); out.push({ table: { head: ['目标', ...dv.blueprint.types], rows: dv.blueprint.rows.map((r) => [r.goal, ...r.cells.map(String)]) } }); }
  if (a.type === 'current_unit') void 0;
  return out;
}

function examPaper(body, variant) {
  const out = [];
  const ins = body.sections.find((s) => s.key === 'instructions');
  if (ins?.content) { out.push({ h: 2, text: '考试说明' }); for (const p of ins.content.split(/\n+/)) if (p.trim()) out.push({ p }); }
  const qs = body.sections.find((s) => s.key === 'questions')?.rows || [];
  const total = qs.reduce((a, q) => a + (Number(q.score) || 0), 0);
  out.push({ h: 2, text: `试题（共 ${qs.length} 题，满分 ${total} 分）` });
  qs.forEach((q, i) => {
    out.push({ p: `${q.no || i + 1}.（${q.qtype || '题目'}，${q.score || '?'} 分）${q.stem || ''}`, bold: true });
    if (q.options) for (const o of String(q.options).split(/\n+/)) if (o.trim()) out.push({ p: o });
    if (variant === 'student') out.push({ p: ' ' });
    if (variant === 'answers') {
      out.push({ p: `参考答案：${q.answer || '（未填写）'}` });
      if (q.analysis) out.push({ p: `解析：${q.analysis}` });
      if (q.rubric) out.push({ p: `评分标准：${q.rubric}` });
      if (q.goal_refs) out.push({ p: `对应目标：${q.goal_refs}` });
    }
  });
  return out;
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function toHtml(a, variant = 'teacher') {
  const b = blocks(a, variant);
  const body = b.map((x) => x.h ? `<h${x.h}>${escHtml(x.text)}</h${x.h}>` : x.note ? `<p class="note">${escHtml(x.note)}</p>` : x.p != null ? `<p${x.bold ? ' class="q"' : ''}>${escHtml(x.p)}</p>`
    : `<table><thead><tr>${x.table.head.map((h) => `<th>${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${x.table.rows.map((r) => `<tr>${r.map((c) => `<td>${escHtml(c).replace(/\n/g, '<br>')}</td>`).join('')}</tr>`).join('')}</tbody></table>`).join('\n');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escHtml(a.title)}</title><style>
body{font-family:"Songti SC","SimSun","Noto Serif SC",serif;max-width:900px;margin:32px auto;padding:0 24px;color:#1a1a1a;line-height:1.7}
h1{font-size:22px;text-align:center}h2{font-size:16px;border-left:4px solid #9b2335;padding-left:8px;margin-top:24px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}th,td{border:1px solid #888;padding:4px 6px;vertical-align:top;text-align:left}th{background:#f3ece4}
.note{color:#7a4b18;font-size:12px}.q{font-weight:600;margin-top:12px}@media print{body{margin:0}}</style></head><body>${body}</body></html>`;
}

// ---- DOCX ----
const x = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const run = (text, { bold = false, size, color } = {}) => String(text).split('\n').map((line, i) => `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ''}</w:rPr>${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${x(line)}</w:t></w:r>`).join('');
const para = (text, opts = {}) => `<w:p><w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ''}${opts.center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${run(text, opts)}</w:p>`;
function table(head, rows) {
  const n = head.length, w = Math.floor(9000 / n);
  const cell = (t, hdr) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${hdr ? '<w:shd w:val="clear" w:color="auto" w:fill="F3ECE4"/>' : ''}</w:tcPr>${para(t, { bold: hdr, size: 20 })}</w:tc>`;
  const border = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="888888"/>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders><w:tblLayout w:type="autofit"/></w:tblPr><w:tblGrid>${head.map(() => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`
    + `<w:tr><w:trPr><w:tblHeader/></w:trPr>${head.map((h) => cell(h, true)).join('')}</w:tr>${rows.map((r) => `<w:tr>${r.map((c) => cell(c, false)).join('')}</w:tr>`).join('')}</w:tbl>${para('')}`;
}

export function toDocx(a, variant = 'teacher') {
  const b = blocks(a, variant);
  const bodyXml = b.map((q) => q.h ? para(q.text, { style: `Heading${q.h}`, center: q.h === 1 }) : q.note ? para(q.note, { color: '7A4B18', size: 18 }) : q.p != null ? para(q.p, { bold: q.bold }) : table(q.table.head, q.table.rows)).join('');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${bodyXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1300" w:bottom="1440" w:left="1300" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const font = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/>';
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr>${font}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`
    + `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>`
    + `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style></w:styles>`;
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(a.title)}</dc:title><dc:creator>研思智境平台导出</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>` },
  ];
  return zip(files);
}
