// Psychometric / agreement statistics computed ONLY from data the researcher actually collected or imported.
// Descriptive and reliability indices; inferential tests are intentionally left to SPSS/R (syntax is exported).
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : null);
function variance(a) { if (a.length < 2) return null; const m = mean(a); return sum(a.map((x) => (x - m) ** 2)) / (a.length - 1); }
function pearson(x, y) {
  const n = x.length; if (n < 3) return null;
  const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

export function describe(values) {
  const a = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return { n: 0, mean: null, sd: null, min: null, max: null, median: null };
  const v = variance(a), mid = a.length >> 1;
  return { n: a.length, mean: r3(mean(a)), sd: r3(v == null ? null : Math.sqrt(v)), min: r3(a[0]), max: r3(a[a.length - 1]), median: r3(a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2) };
}

/** Cronbach's α on complete cases. matrix: rows = respondents, cols = items (already reverse-coded). */
export function cronbach(matrix) {
  const rows = matrix.filter((r) => r.every((v) => typeof v === 'number' && Number.isFinite(v)));
  const k = rows[0]?.length || 0;
  if (k < 2 || rows.length < 3) return { alpha: null, n: rows.length, k, excluded: matrix.length - rows.length, note: k < 2 ? '题项少于 2 个，无法计算 α' : '完整作答少于 3 人，无法计算 α' };
  const cols = Array.from({ length: k }, (_, j) => rows.map((r) => r[j]));
  const totals = rows.map(sum);
  const alphaOf = (idx) => { const kk = idx.length; if (kk < 2) return null; const tv = variance(rows.map((r) => sum(idx.map((j) => r[j])))); return tv ? (kk / (kk - 1)) * (1 - sum(idx.map((j) => variance(cols[j]))) / tv) : null; };
  const all = cols.map((_, j) => j);
  return { alpha: r3(alphaOf(all)), n: rows.length, k, excluded: matrix.length - rows.length,
    items: cols.map((c, j) => ({ index: j, mean: r3(mean(c)), sd: r3(Math.sqrt(variance(c) || 0)), citc: r3(pearson(c, totals.map((t, i) => t - c[i]))), alpha_if_deleted: r3(alphaOf(all.filter((x) => x !== j))) })) };
}

/** Classical test theory item analysis. scores: rows = examinees, cols = items (points earned), max: max points per item. */
export function itemAnalysis(scores, max) {
  const rows = scores.filter((r) => r.every((v) => typeof v === 'number' && Number.isFinite(v)));
  const k = max.length, n = rows.length;
  if (n < 5) return { n, k, note: '完整作答少于 5 人，不做题目分析', items: [] };
  const totals = rows.map(sum);
  const order = rows.map((_, i) => i).sort((a, b) => totals[b] - totals[a]);
  const g = Math.max(1, Math.round(n * 0.27)), hi = order.slice(0, g), lo = order.slice(-g);
  const items = max.map((m, j) => {
    const c = rows.map((r) => r[j]);
    const p = m ? mean(c) / m : null;
    const d = m ? (mean(hi.map((i) => rows[i][j])) - mean(lo.map((i) => rows[i][j]))) / m : null;
    return { index: j, max: m, difficulty_p: r3(p), discrimination_d: r3(d), corrected_r: r3(pearson(c, totals.map((t, i) => t - c[i]))) };
  });
  const dich = max.every((m) => m === 1) && rows.every((r) => r.every((v) => v === 0 || v === 1));
  let reliability;
  if (dich) { const tv = variance(totals); const pq = sum(rows[0].map((_, j) => { const p = mean(rows.map((r) => r[j])); return p * (1 - p); })); reliability = { kr20: r3(tv ? (k / (k - 1)) * (1 - pq / tv) : null) }; }
  else reliability = { alpha: cronbach(rows).alpha };
  return { n, k, group_size_27: g, total: describe(totals), reliability, items };
}

// ---------- inter-rater agreement ----------
/** Cohen's κ for two raters (nominal) and quadratic-weighted κ when categories are ordered numbers. pairs: [[a,b],...] */
export function cohenKappa(pairs, { weighted = false } = {}) {
  const P = pairs.filter(([a, b]) => a != null && b != null);
  const n = P.length; if (n < 2) return { n, kappa: null, note: '成对评分少于 2 条' };
  const cats = [...new Set(P.flat())].sort((x, y) => (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))));
  const idx = new Map(cats.map((c, i) => [c, i])), K = cats.length;
  const O = Array.from({ length: K }, () => Array(K).fill(0));
  for (const [a, b] of P) O[idx.get(a)][idx.get(b)]++;
  const rs = O.map(sum), cs = cats.map((_, j) => sum(O.map((r) => r[j])));
  const po = sum(cats.map((_, i) => O[i][i])) / n;
  const w = (i, j) => { if (!weighted) return i === j ? 1 : 0; const num = cats.every((c) => typeof c === 'number'); const d = num ? (cats[i] - cats[j]) / ((cats[K - 1] - cats[0]) || 1) : (i - j) / ((K - 1) || 1); return 1 - d * d; };
  let pow = 0, pew = 0;
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) { pow += w(i, j) * O[i][j] / n; pew += w(i, j) * rs[i] * cs[j] / (n * n); }
  const kappa = pew === 1 ? (pow === 1 ? 1 : null) : (pow - pew) / (1 - pew);
  return { n, categories: cats, percent_agreement: r3(po), kappa: r3(kappa), weighted, note: weighted ? '二次加权 κ（有序等级）' : '未加权 κ（类别）' };
}

/**
 * Krippendorff's α. units: array of arrays of values assigned by any number of coders (missing omitted).
 * level: 'nominal' | 'ordinal' | 'interval'. Uses the coincidence-matrix formulation.
 */
export function krippendorff(units, level = 'nominal') {
  const U = units.map((u) => u.filter((v) => v != null && v !== '')).filter((u) => u.length >= 2);
  const vals = [...new Set(U.flat())].sort((a, b) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))));
  if (U.length < 2 || vals.length < 1) return { alpha: null, units: U.length, note: '可配对的评分单元少于 2 个' };
  const idx = new Map(vals.map((v, i) => [v, i])), V = vals.length;
  const o = Array.from({ length: V }, () => Array(V).fill(0));
  for (const u of U) { const m = u.length; for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) if (a !== b) o[idx.get(u[a])][idx.get(u[b])] += 1 / (m - 1); }
  const nc = o.map(sum), n = sum(nc);
  if (V === 1) return { alpha: 1, units: U.length, pairable_values: n, note: '所有评分完全相同' };
  const delta = (c, k) => {
    if (level === 'nominal') return c === k ? 0 : 1;
    if (level === 'interval') return (vals[c] - vals[k]) ** 2;
    const [lo, hi] = c < k ? [c, k] : [k, c]; let s = 0; for (let g = lo; g <= hi; g++) s += nc[g]; s -= (nc[c] + nc[k]) / 2; return s * s; // ordinal
  };
  let Do = 0, De = 0;
  for (let c = 0; c < V; c++) for (let k = 0; k < V; k++) { Do += o[c][k] * delta(c, k); De += nc[c] * nc[k] * delta(c, k); }
  Do /= n; De /= n * (n - 1);
  return { alpha: r3(De ? 1 - Do / De : null), units: U.length, pairable_values: r3(n), level };
}

/** ICC from a complete targets × raters matrix: ICC(2,1) absolute agreement, ICC(3,1) consistency, and average-measure forms. */
export function icc(matrix) {
  const M = matrix.filter((r) => r.every((v) => typeof v === 'number' && Number.isFinite(v)));
  const n = M.length, k = M[0]?.length || 0;
  if (n < 3 || k < 2) return { n, k, note: '需要至少 3 个对象、每个对象至少 2 位评分者的完整评分' };
  const g = mean(M.flat()), rm = M.map(mean), cm = Array.from({ length: k }, (_, j) => mean(M.map((r) => r[j])));
  const SSR = k * sum(rm.map((x) => (x - g) ** 2)), SSC = n * sum(cm.map((x) => (x - g) ** 2)), SST = sum(M.flat().map((x) => (x - g) ** 2));
  const SSE = SST - SSR - SSC, MSR = SSR / (n - 1), MSC = SSC / (k - 1), MSE = SSE / ((n - 1) * (k - 1));
  return { n, k,
    icc2_1: r3((MSR - MSE) / (MSR + (k - 1) * MSE + (k * (MSC - MSE)) / n)), icc2_k: r3((MSR - MSE) / (MSR + (MSC - MSE) / n)),
    icc3_1: r3((MSR - MSE) / (MSR + (k - 1) * MSE)), icc3_k: r3(MSR ? (MSR - MSE) / MSR : null),
    note: 'ICC(2,1)=双向随机·绝对一致·单一评分者；ICC(3,1)=双向混合·一致性·单一评分者（Shrout & Fleiss, 1979 记法）' };
}

// ---------- sequential analysis ----------
/** Lag-1 transitions between codes within sequences. Adjusted residuals z = (o−e)/√(e(1−r/N)(1−c/N)). */
export function lagSequential(sequences) {
  const codes = [...new Set(sequences.flat())].sort();
  const i = new Map(codes.map((c, k) => [c, k])), K = codes.length;
  const O = Array.from({ length: K }, () => Array(K).fill(0));
  for (const s of sequences) for (let t = 0; t + 1 < s.length; t++) O[i.get(s[t])][i.get(s[t + 1])]++;
  const N = sum(O.map(sum)), rs = O.map(sum), cs = codes.map((_, j) => sum(O.map((r) => r[j])));
  const cells = [];
  for (let a = 0; a < K; a++) for (let b = 0; b < K; b++) {
    const e = N ? (rs[a] * cs[b]) / N : 0, den = Math.sqrt(e * (1 - rs[a] / N) * (1 - cs[b] / N));
    cells.push({ from: codes[a], to: codes[b], observed: O[a][b], expected: r3(e), z: den ? r3((O[a][b] - e) / den) : null });
  }
  return { codes, n_transitions: N, cells, note: '|z|>1.96 常被报告为 p<.05 水平的显著序列（Bakeman & Quera, 2011）；期望频次过小（<5）时解释需谨慎' };
}

export const INTERPRET = {
  alpha: (a) => (a == null ? '无法计算' : a >= 0.9 ? '很高（≥.90，注意题项冗余）' : a >= 0.8 ? '良好（≥.80）' : a >= 0.7 ? '可接受（≥.70）' : a >= 0.6 ? '偏低（.60—.70，探索性研究慎用）' : '不足（<.60）'),
  kappa: (k) => (k == null ? '无法计算' : k > 0.8 ? '几乎完全一致（>.80）' : k > 0.6 ? '高度一致（.61—.80）' : k > 0.4 ? '中等一致（.41—.60）' : k > 0.2 ? '一般（.21—.40）' : '较差（≤.20）'),
  kalpha: (a) => (a == null ? '无法计算' : a >= 0.8 ? '可靠（≥.800）' : a >= 0.667 ? '可作暂定结论（.667—.800）' : '不足（<.667）'),
  icc: (x) => (x == null ? '无法计算' : x > 0.9 ? '优秀（>.90）' : x >= 0.75 ? '良好（.75—.90）' : x >= 0.5 ? '中等（.50—.75）' : '较差（<.50）'),
};
export const THRESHOLD_SOURCES = 'κ 分级：Landis & Koch (1977)；Krippendorff α：Krippendorff (2004)《Content Analysis》；ICC 分级：Koo & Li (2016)；α 常用 .70 门槛：Nunnally (1978)。阈值仅为惯例参考，请按目标期刊要求报告。';
