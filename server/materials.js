// Teaching material upload: text extraction (docx/pptx/xlsx/txt/md/csv), PII screening, storage of extracted text only.
import { createHash } from 'node:crypto';
import { one, all, run, id, now, check, fail, audit, json } from './db.js';
import { unzip } from './zip.js';

export const MATERIAL_KINDS = {
  talent_plan: '人才培养方案', syllabus: '教学大纲', semester_design: '学期教学设计', course_design: '课程教学设计',
  schedule: '教学计划进度', courseware: '课件', exercises: '习题/试卷', case: '思政案例材料', other: '其他',
};
const EXT = ['docx', 'pptx', 'xlsx', 'txt', 'md', 'csv'];
const MAX_BYTES = 15 * 1024 * 1024, MAX_CHARS = 200000;

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
function docxText(files) {
  const xml = files['word/document.xml']?.toString('utf8');
  if (!xml) throw new Error('DOCX 中缺少正文');
  return unxml(xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<\/w:tc>/g, '\t').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function pptxText(files) {
  const slides = Object.keys(files).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => +a.match(/\d+/)[0] - +b.match(/\d+/)[0]);
  if (!slides.length) throw new Error('PPTX 中没有幻灯片');
  return slides.map((k, i) => {
    const xml = files[k].toString('utf8');
    const paras = xml.split('</a:p>').map((p) => unxml((p.match(/<a:t>([^<]*)<\/a:t>/g) || []).map((t) => t.slice(5, -6)).join(''))).filter((t) => t.trim());
    return `【第${i + 1}页】\n${paras.join('\n')}`;
  }).join('\n\n');
}
function xlsxText(files) {
  const ss = files['xl/sharedStrings.xml']?.toString('utf8') || '';
  const strings = (ss.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) => unxml((si.match(/<t[^>]*>([^<]*)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const sheets = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  return sheets.map((k) => {
    const xml = files[k].toString('utf8');
    return (xml.match(/<row[\s\S]*?<\/row>/g) || []).map((row) => (row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []).map((c) => {
      const v = (c.match(/<v>([^<]*)<\/v>/) || [])[1] ?? (c.match(/<t[^>]*>([^<]*)<\/t>/) || [])[1] ?? '';
      return / t="s"/.test(c) ? strings[+v] ?? '' : unxml(v);
    }).join('\t')).join('\n');
  }).join('\n\n');
}
function plainText(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

/** Screen extracted text for personal data that should not be uploaded (ID cards, phone numbers, emails, student numbers). */
export function piiScan(text) {
  const flags = {};
  const count = (k, re) => { const m = text.match(re); if (m) flags[k] = m.length; };
  count('身份证号', /(?<!\d)\d{17}[\dXx](?!\d)/g);
  count('手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/g);
  count('邮箱', /[\w.+-]+@[\w-]+\.[\w.]+/g);
  count('疑似学号', /学号[:：\s]*\d{6,}/g);
  return flags;
}
/** Redact PII before the text is used in prompts, previews or skeletons. */
export function redact(text) {
  return text.replace(/(?<!\d)\d{17}[\dXx](?!\d)/g, '[身份证号已隐去]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已隐去]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[邮箱已隐去]').replace(/(学号[:：\s]*)\d{6,}/g, '$1[已隐去]');
}

export function extractText(filename, buf) {
  const ext = String(filename).toLowerCase().split('.').pop();
  check(EXT.includes(ext), 400, 'unsupported_type', `暂不支持 .${ext}。支持 ${EXT.join('/')}；PDF、旧版 .doc/.ppt 请另存为 DOCX/PPTX 后上传`);
  check(buf.length > 0 && buf.length <= MAX_BYTES, 400, 'bad_size', '文件为空或超过 15MB');
  let text;
  try {
    if (ext === 'docx') text = docxText(unzip(buf));
    else if (ext === 'pptx') text = pptxText(unzip(buf));
    else if (ext === 'xlsx') text = xlsxText(unzip(buf));
    else text = plainText(buf);
  } catch (e) { fail(400, 'extract_failed', `无法读取文件内容：${e.message}`); }
  text = text.replace(/\r\n?/g, '\n').trim();
  check(text.length >= 2, 400, 'empty_text', '未从文件中提取到文字（扫描版文档需先做文字识别）');
  return { ext, text: text.slice(0, MAX_CHARS), truncated: text.length > MAX_CHARS };
}

export function uploadMaterial(db, user, { filename, kind, data_base64 }) {
  filename = String(filename || '').replace(/[\\/]/g, '_').slice(0, 120);
  check(filename, 400, 'bad_name', '缺少文件名');
  check(Object.hasOwn(MATERIAL_KINDS, kind), 400, 'bad_kind', '请选择材料类别');
  const buf = Buffer.from(String(data_base64 || ''), 'base64');
  const { ext, text, truncated } = extractText(filename, buf);
  const pii = piiScan(text);
  const material_id = id('mat');
  run(db, 'INSERT INTO materials(material_id,owner_id,kind,filename,ext,size,sha256,text,n_chars,pii_flags,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    material_id, user.user_id, kind, filename, ext, buf.length, createHash('sha256').update(buf).digest('hex'), text, text.length, JSON.stringify(pii), now());
  audit(db, { actor: user, action: 'material_uploaded', target_type: 'material', target_id: material_id, detail: { ext, size: buf.length, n_chars: text.length, pii } });
  return { ...publicMaterial(one(db, 'SELECT * FROM materials WHERE material_id=?', material_id)), truncated };
}
export function publicMaterial(m) {
  return { material_id: m.material_id, kind: m.kind, kind_name: MATERIAL_KINDS[m.kind], filename: m.filename, ext: m.ext, size: m.size, n_chars: m.n_chars,
    pii_flags: json(m.pii_flags, {}), preview: redact(m.text.slice(0, 400)), created_at: m.created_at };
}
export const listMaterials = (db, user) => all(db, 'SELECT * FROM materials WHERE owner_id=? ORDER BY created_at DESC', user.user_id).map(publicMaterial);
export function deleteMaterial(db, user, mid) {
  const m = one(db, 'SELECT * FROM materials WHERE material_id=? AND owner_id=?', mid, user.user_id);
  check(m, 404, 'not_found', '材料不存在');
  run(db, 'DELETE FROM materials WHERE material_id=?', mid);
  audit(db, { actor: user, action: 'material_deleted', target_type: 'material', target_id: mid });
}
/** Owned materials for a run; text is PII-redacted before any use. */
export function loadMaterials(db, user, ids) {
  if (!Array.isArray(ids) || !ids.length) return [];
  check(ids.length <= 10, 400, 'too_many', '每次研讨最多引用 10 份材料');
  return ids.map((mid) => {
    const m = one(db, 'SELECT * FROM materials WHERE material_id=? AND owner_id=?', mid, user.user_id);
    if (!m) fail(404, 'not_found', '材料不存在或无权访问');
    return { material_id: m.material_id, kind: m.kind, kind_name: MATERIAL_KINDS[m.kind], filename: m.filename, text: redact(m.text) };
  });
}

// ---- ideology vocabulary and lightweight reading of materials for demo mode (no model) ----
export const BASE_IDEOLOGY_TERMS = ['课程思政', '立德树人', '社会主义核心价值观', '家国情怀', '爱国', '工匠精神', '劳模精神', '科学精神', '创新精神', '职业道德', '职业规范', '职业素养',
  '工程伦理', '科技伦理', '社会责任', '工程责任', '责任担当', '诚信', '法治', '规范意识', '质量意识', '质量责任', '安全意识', '公共安全', '公共利益', '生态文明', '绿色发展',
  '可持续发展', '文化自信', '奉献精神', '团队协作', '集体主义', '国家标准', '价值判断', '价值冲突', '价值观', '思政', '伦理', '责任'];
export function ideologyTerms(course = {}) {
  const extra = String(course.ideology_elements || '').split(/[、,，;；\s]+/).map((x) => x.trim()).filter((x) => x.length >= 2 && x.length <= 12);
  return [...new Set([...extra, ...BASE_IDEOLOGY_TERMS])].sort((a, b) => b.length - a.length);
}
export const matchTerms = (text, terms) => terms.filter((t) => String(text || '').includes(t));

export function readMaterial(m, terms) {
  const lines = m.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const headings = lines.filter((l) => l.length <= 40 && /^(第[一二三四五六七八九十\d]+[章节单元周讲部分]|[一二三四五六七八九十]+[、.．]|\d+(\.\d+)*[、.．\s]|【第\d+页】|项目[一二三四五六七八九十\d]|模块[一二三四五六七八九十\d]|任务[一二三四五六七八九十\d])/.test(l)).slice(0, 30);
  const sentences = m.text.split(/(?<=[。！？；\n])/).map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 8 && s.length <= 200);
  const ideology = sentences.filter((s) => terms.some((t) => s.includes(t))).slice(0, 20);
  const key = sentences.filter((s) => /目标|要求|重点|难点|能够|掌握|理解|案例|任务|考核|评价/.test(s)).slice(0, 20);
  return { headings, ideology, key, n_lines: lines.length };
}
