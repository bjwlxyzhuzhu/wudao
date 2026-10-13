// Tabular I/O shared by every importable/exportable table: CSV/TSV/XLSX reading (true cell grid), CSV/XLSX writing,
// smart header→field mapping (synonyms + fuzzy), typed coercion/validation, and SPSS syntax generation.
import { unzip, zip } from './zip.js';
import { fail } from './db.js';

// ---------- reading ----------
function decodeText(buf) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return utf8.replace(/^﻿/, '');
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

/** RFC 4180 CSV parser (quoted fields, embedded delimiters/newlines, "" escapes). Delimiter auto-detected. */
export function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const first = text.slice(0, text.search(/\r?\n/) >>> 0 || text.length);
  const cands = [',', '\t', ';', '，'];
  const count = (d) => first.split(d).length - 1;
  const delim = cands.reduce((a, d) => (count(d) > count(a) ? d : a), ',');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}

const unxml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const colIndex = (ref) => { const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return -1; let n = 0; for (const c of m[1]) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };
const colName = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

/** XLSX → [{name, rows}] keeping column positions (empty cells stay empty). */
export function parseXlsx(buf) {
  const files = unzip(buf);
  const ss = files['xl/sharedStrings.xml']?.toString('utf8') || '';
  const strings = (ss.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) => unxml((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const wb = files['xl/workbook.xml']?.toString('utf8') || '';
  const rels = files['xl/_rels/workbook.xml.rels']?.toString('utf8') || '';
  const relMap = Object.fromEntries([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [(/Id="([^"]+)"/.exec(m[0]) || [])[1], (/Target="([^"]+)"/.exec(m[0]) || [])[1]]));
  let sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({ name: unxml((/name="([^"]*)"/.exec(m[0]) || [])[1] || ''), path: (() => { const t = relMap[(/r:id="([^"]+)"/.exec(m[0]) || [])[1]] || ''; return t ? `xl/${t.replace(/^\/?xl\//, '').replace(/^\//, '')}` : ''; })() }));
  if (!sheets.length || sheets.some((s) => !files[s.path])) sheets = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/))).map((p, i) => ({ name: `Sheet${i + 1}`, path: p }));
  return sheets.map(({ name, path }) => {
    const xml = files[path].toString('utf8');
    const rows = [];
    for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const out = [];
      let next = 0;
      for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1], inner = cm[2] || '';
        const ref = (/r="([A-Z]+\d+)"/.exec(attrs) || [])[1];
        const ci = ref ? colIndex(ref) : next; next = ci + 1;
        const t = (/t="(\w+)"/.exec(attrs) || [])[1];
        let v = '';
        if (t === 'inlineStr') v = unxml((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join(''));
        else { const raw = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1] ?? ''; v = t === 's' ? strings[+raw] ?? '' : t === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE') : unxml(raw); }
        out[ci] = String(v).trim();
      }
      rows.push(Array.from(out, (x) => x ?? ''));
    }
    return { name, rows: rows.filter((r) => r.some((c) => c !== '')) };
  });
}

/** Read any supported upload into sheets of string rows. */
export function readTable(filename, buf) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (buf.length > 20e6) fail(413, 'too_large', '文件超过 20MB');
  if (ext === 'xlsx') return parseXlsx(buf);
  if (['csv', 'tsv', 'txt'].includes(ext)) return [{ name: filename, rows: parseCsv(decodeText(buf)) }];
  if (ext === 'json') {
    let v; try { v = JSON.parse(decodeText(buf)); } catch { fail(400, 'bad_json', 'JSON 格式错误'); }
    const arr = Array.isArray(v) ? v : Array.isArray(v?.rows) ? v.rows : null;
    if (!arr || !arr.length || typeof arr[0] !== 'object') fail(400, 'bad_json', 'JSON 需为对象数组，或 {rows:[…]}');
    const cols = [...new Set(arr.flatMap((o) => Object.keys(o)))];
    return [{ name: filename, rows: [cols, ...arr.map((o) => cols.map((c) => (o[c] == null ? '' : typeof o[c] === 'object' ? JSON.stringify(o[c]) : String(o[c]))))] }];
  }
  if (ext === 'xls') fail(400, 'old_excel', '暂不支持旧版 .xls，请在 Excel 中“另存为 .xlsx 或 CSV (UTF-8)”');
  fail(400, 'bad_format', '支持的格式：.xlsx、.csv、.tsv、.txt（制表符/逗号分隔）、.json');
}

// ---------- writing ----------
export function toCsv(rows, columns, headerLabels) {
  const cell = (v) => {
    let t = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?$/.test(t)) t = `'${t}`; // formula-injection guard
    return `"${t.replace(/"/g, '""')}"`;
  };
  return '﻿' + [(headerLabels || columns).map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

const xesc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
/** Minimal XLSX writer. sheets: [{name, header:[...], rows:[[...]], widths?}]. Inline strings → no formulas are ever written. */
export function toXlsx(sheets) {
  const files = [];
  const sheetXml = (s) => {
    const all = [s.header, ...s.rows];
    const widths = s.header.map((h, i) => Math.min(60, Math.max(8, ...all.slice(0, 200).map((r) => String(r[i] ?? '').length * 1.6 + 2))));
    const rowsXml = all.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
      const ref = `${colName(ci)}${ri + 1}`, st = ri === 0 ? ' s="1"' : '';
      if (v == null || v === '') return `<c r="${ref}"${st}/>`;
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${st}><is><t xml:space="preserve">${xesc(typeof v === 'object' ? JSON.stringify(v) : v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.round(w)}" customWidth="1"/>`).join('')}</cols><sheetData>${rowsXml}</sheetData></worksheet>`;
  };
  const names = sheets.map((s, i) => String(s.name || `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, '_').slice(0, 31));
  files.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
  files.push({ name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
  files.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xesc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
  files.push({ name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="等线"/></font><font><b/><sz val="11"/><name val="等线"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF6E7C8"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/></cellXfs></styleSheet>' });
  sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'utf8') })));
}

// ---------- smart mapping ----------
const norm = (s) => String(s || '').toLowerCase().normalize('NFKC').replace(/[（(][^）)]*[）)]/g, '').replace(/[\s_\-·.:：/\\|*#（）()【】\[\]「」"'“”]/g, '');
const bigrams = (s) => { const out = new Map(); for (let i = 0; i < s.length - 1; i++) { const b = s.slice(i, i + 2); out.set(b, (out.get(b) || 0) + 1); } if (s.length === 1) out.set(s, 1); return out; };
function dice(a, b) {
  if (!a || !b) return 0; if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b); let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) || 0);
  return (2 * inter) / (na + nb);
}
/** Score how well a header matches a field: exact synonym 1, containment .85, else bigram Dice. */
export function matchScore(header, field) {
  const h = norm(header); if (!h) return { score: 0 };
  const names = [field.key, field.label, ...(field.synonyms || [])].map(norm).filter(Boolean);
  let best = { score: 0, how: '' };
  for (const n of names) {
    const s = h === n ? 1 : (h.length >= 2 && n.length >= 2 && (h.includes(n) || n.includes(h))) ? 0.85 : dice(h, n) * 0.9;
    if (s > best.score) best = { score: s, how: h === n ? '同义词精确匹配' : s === 0.85 ? '包含匹配' : '相似度匹配' };
  }
  return best;
}
/** Greedy one-to-one assignment of headers to fields (highest confidence first). */
export function suggestMapping(headers, fields, threshold = 0.55) {
  const cand = [];
  headers.forEach((h, i) => fields.forEach((f) => { const m = matchScore(h, f); if (m.score >= threshold) cand.push({ i, key: f.key, ...m }); }));
  cand.sort((a, b) => b.score - a.score);
  const usedH = new Set(), usedF = new Set(), out = headers.map((h, i) => ({ index: i, column: h, field: null, score: 0, how: '' }));
  for (const c of cand) { if (usedH.has(c.i) || usedF.has(c.key)) continue; usedH.add(c.i); usedF.add(c.key); Object.assign(out[c.i], { field: c.key, score: Math.round(c.score * 100) / 100, how: c.how }); }
  return out;
}

// ---------- typed coercion ----------
const TRUE = /^(1|y|yes|true|t|是|对|有|√|✓|反向|已同意|同意)$/i, FALSE = /^(0|n|no|false|f|否|错|无|×|✗|正向|)$/i;
function excelDate(n) { const d = new Date(Math.round((n - 25569) * 86400e3)); return Number.isNaN(d.getTime()) ? null : d; }
/** Coerce one raw string to a field's type. Returns {value} or {error}. */
export function coerce(raw, f) {
  const s = String(raw ?? '').trim();
  if (s === '' || /^(na|n\/a|null|缺失|--?)$/i.test(s)) return f.required ? { error: `${f.label}必填` } : { value: f.type === 'bool' ? (f.default ?? null) : null };
  switch (f.type) {
    case 'int': case 'number': {
      const n = Number(s.replace(/[,，]/g, '').replace(/[%分]$/, ''));
      if (!Number.isFinite(n)) return { error: `${f.label}应为数字（收到“${s.slice(0, 20)}”）` };
      if (f.type === 'int' && !Number.isInteger(n)) return { error: `${f.label}应为整数` };
      if (f.min != null && n < f.min) return { error: `${f.label}不能小于 ${f.min}` };
      if (f.max != null && n > f.max) return { error: `${f.label}不能大于 ${f.max}` };
      return { value: n };
    }
    case 'bool': if (TRUE.test(s)) return { value: true }; if (FALSE.test(s)) return { value: false }; return { error: `${f.label}应为 是/否` };
    case 'date': {
      if (/^\d{5}(\.\d+)?$/.test(s)) { const d = excelDate(Number(s)); if (d) return { value: d.toISOString().slice(0, 10) }; }
      const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/.exec(s);
      if (!m) return { error: `${f.label}应为日期（如 2026-09-01）` };
      return { value: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` };
    }
    case 'enum': {
      for (const [k, syn] of Object.entries(f.options)) if (norm(k) === norm(s) || (syn || []).some((x) => norm(x) === norm(s))) return { value: k };
      return { error: `${f.label}取值“${s.slice(0, 20)}”不在允许范围（${Object.entries(f.options).map(([k, v]) => v?.[0] || k).join('/')}）` };
    }
    case 'code': return /^[\w一-龥.\-]{1,40}$/.test(s) ? { value: s } : { error: `${f.label}只能含字母、数字、汉字、下划线、点或短横线（≤40字）` };
    case 'list': return { value: s.split(/[;；|、,，]+/).map((x) => x.trim()).filter(Boolean).slice(0, 50) };
    default: return { value: s.slice(0, f.max_len || 4000) };
  }
}

/** Apply a mapping to rows; returns normalized records plus row-level errors (1-based spreadsheet row numbers). */
export function applyMapping(rows, mapping, fields, { extra = null } = {}) {
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const out = [], errors = [];
  rows.forEach((r, ri) => {
    const rec = {}, errs = [];
    for (const m of mapping) {
      if (!m.field) continue;
      const f = byKey[m.field]; if (!f) continue;
      const c = coerce(r[m.index], f);
      if (c.error) errs.push(c.error); else rec[f.key] = c.value;
    }
    for (const f of fields) if (f.required && !mapping.some((m) => m.field === f.key)) errs.push(`缺少必填列：${f.label}`);
    if (extra) for (const e of extra(rec, r) || []) errs.push(e);
    if (errs.length) errors.push({ row: ri + 2, messages: [...new Set(errs)] }); else out.push(rec);
  });
  return { records: out, errors };
}

// ---------- SPSS ----------
/** SPSS-safe variable name: letter start, [A-Za-z0-9_.], ≤64 bytes, unique. */
export function spssName(s, used = new Set()) {
  let n = String(s).normalize('NFKC').replace(/[^A-Za-z0-9_.]/g, '_').replace(/^[^A-Za-z]+/, '');
  if (!n) n = 'v'; n = n.slice(0, 60);
  let k = n, i = 2; while (used.has(k.toLowerCase())) k = `${n}_${i++}`; used.add(k.toLowerCase()); return k;
}
/** Syntax that reads the companion UTF-8 CSV and applies variable/value labels. */
export function spssSyntax(csvName, fields, { title = '' } = {}) {
  const used = new Set(), names = fields.map((f) => spssName(f.key, used));
  const fmt = (f) => (['int', 'number'].includes(f.type) ? 'F8.2' : f.type === 'bool' ? 'F1.0' : `A${Math.min(f.max_len || 255, 32767)}`);
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const lines = [
    `* ${title || csvName}  (generated by 研思智境; encoding UTF-8).`,
    'SET UNICODE=ON.',
    `GET DATA /TYPE=TXT /FILE=${q(csvName)} /ENCODING='UTF8' /DELCASE=LINE /DELIMITERS="," /QUALIFIER='"' /ARRANGEMENT=DELIMITED /FIRSTCASE=2`,
    `  /VARIABLES=${names.map((n, i) => `\n    ${n} ${fmt(fields[i])}`).join('')}.`,
    'CACHE.', 'EXECUTE.',
    `VARIABLE LABELS${names.map((n, i) => `\n  ${n} ${q(fields[i].label + (fields[i].unit ? `（${fields[i].unit}）` : ''))}`).join('')}.`,
  ];
  fields.forEach((f, i) => {
    if (f.value_labels) lines.push(`VALUE LABELS ${names[i]}${Object.entries(f.value_labels).map(([v, l]) => ` ${/^-?\d+(\.\d+)?$/.test(v) ? v : q(v)} ${q(l)}`).join('')}.`);
    if (f.missing != null) lines.push(`MISSING VALUES ${names[i]} (${f.missing}).`);
    if (f.measure) lines.push(`VARIABLE LEVEL ${names[i]} (${f.measure.toUpperCase()}).`);
  });
  lines.push('EXECUTE.');
  return lines.join('\n') + '\n';
}

/** Header-only template (plus a field-description sheet) — never filled with invented example data. */
export function templateXlsx(title, fields) {
  return toXlsx([
    { name: '数据', header: fields.map((f) => f.label), rows: [] },
    { name: '字段说明', header: ['列名', '字段键', '类型', '是否必填', '允许取值 / 范围', '说明', '可识别的同义表头'], rows: fields.map((f) => [f.label, f.key, TYPE_LABEL[f.type] || '文本', f.required ? '是' : '否',
      f.type === 'enum' ? Object.entries(f.options).map(([k, v]) => `${v?.[0] || k}`).join(' / ') : [f.min, f.max].some((x) => x != null) ? `${f.min ?? ''}—${f.max ?? ''}` : '', f.help || '', (f.synonyms || []).join('、')]) },
    { name: '说明', header: ['事项', '说明'], rows: [['用途', title], ['填写', '第一行为表头，从第二行开始每行一条记录；表头可以用自己的叫法，导入时系统会自动匹配并允许手动调整'], ['隐私', '不要填写真实姓名、学号、身份证号、手机号；用研究编码（如 P001）代替'], ['缺失', '留空或填 NA 表示缺失，不要用 0 代替缺失']] },
  ]);
}
export const TYPE_LABEL = { text: '文本', int: '整数', number: '数值', bool: '是/否', date: '日期', enum: '选项', code: '编码', list: '列表（分号分隔）' };
