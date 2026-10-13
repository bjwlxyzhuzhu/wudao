// Course knowledge extraction from imported teaching materials (no model required).
// Produces course facts, knowledge points (term + definition + source), difficulties, a knowledge-specific
// 课程思政 linkage and a checking question per point, plus retrieval-based answers grounded in the materials.
// Everything returned carries its source (《文件名》· 章节); nothing is invented beyond templated phrasing.

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const stripNum = (s) => clean(s).replace(/^(第[一二三四五六七八九十百\d]+[章节单元讲部分篇]|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|\(\d+\)|\d+(\.\d+)*[、.．\s]|【第\d+页】|[-•·●■◆]\s*)\s*/, '').trim();
const isHeading = (l) => l.length <= 36 && !/[。！？；]$/.test(l) && /^(第[一二三四五六七八九十百\d]+[章节单元讲部分篇]|[一二三四五六七八九十]+[、.．]|（[一二三四五六七八九十\d]+）|\d+(\.\d+)*[、.．\s]|【第\d+页】|项目[一二三四五六七八九十\d]|模块[一二三四五六七八九十\d]|任务[一二三四五六七八九十\d])/.test(l);
const GENERIC = /^(这|那|它|其|我们|本课程|本章|本节|教学|课程|学生|教师|目标|内容|要求|说明|注意|备注|例如|比如|因此|所以|但是|如果|其中|以下|上述)|专业|对象|学时|学分|名称|课程目标|课程思政|考核|先修|教材|参考|周次|授课|适用|作者|日期|联系/;

const DEF_PATTERNS = [
  /^(?:所谓)?[「“"]?([^，。；：:、「」“”"]{2,16})[」”"]?(?:（[^）]{1,30}）)?(?:是指|指的是|定义为|被定义为|即|也就是)([^。！？；]{4,160})/,
  /^[「“"]?([^，。；：:、「」“”"]{2,14})[」”"]?(?:（[^）]{1,30}）)?(?:是一种|是一类|是一个|是)([^。！？；]{6,160})/,
  /^把([^，。；]{4,40})称为[「“"]?([^，。；「」“”"]{2,14})[」”"]?/,
  /^([^，。；：:\s]{2,12})[:：]\s*([^。！？]{6,160})/,
];
const IDEO_RULES = [
  ['ethics', '工程伦理与社会责任', '工程伦理', /安全|风险|事故|质量|可靠|失效|检测|检验|伦理|隐私|算法|偏见|故障/],
  ['craft', '职业规范与工匠精神', '工匠精神', /标准|规范|精度|公差|工艺|操作|规程|误差|加工|装配|测量|施工/],
  ['integrity', '诚信与学术规范', '诚信', /数据|记录|报告|实验结果|统计|引用|原始/],
  ['green', '生态文明与可持续发展', '绿色发展', /能耗|环境|排放|节能|回收|绿色|碳|污染|资源/],
  ['mission', '家国情怀与使命担当', '科技自立自强', /国产|自主|我国|中国|国家|芯片|发展历程|战略|民族/],
  ['law', '法治意识与规则意识', '规则意识', /法律|法规|合同|产权|专利|许可|合规|制度/],
  ['culture', '文化自信与人文素养', '文化自信', /古代|传统|文化|发明|历史/],
  ['science', '科学精神与创新', '科学精神', /./],
];
const IDEO_TEMPLATES = {
  ethics: (t) => `讲「${t}」时设置决策情境：在进度或成本压力下，是否可以放宽与「${t}」相关的要求？让学生说明对使用者和公众的责任，并给出专业依据`,
  craft: (t) => `结合「${t}」对应的标准或操作规程，讨论“差不多就行”可能造成的后果，体会精益求精的职业要求（标准号需核查）`,
  integrity: (t) => `在「${t}」涉及的数据记录与报告环节，讨论为什么不能修改或选择性报告数据，以及出现异常数据时的正确做法`,
  green: (t) => `比较与「${t}」相关方案的资源和环境代价，讨论工程师在可持续发展中的责任`,
  mission: (t) => `介绍「${t}」在我国相关领域的发展与差距（事实与数据需注明来源），讨论个人专业学习与科技自立自强的关系`,
  law: (t) => `分析「${t}」涉及的法律或合规要求（出处需核查），通过真实案例讨论规则意识`,
  culture: (t) => `结合「${t}」相关的技术史或人物（注明出处），讨论文化自信与创新传承`,
  science: (t) => `引导学生追问「${t}」的前提、适用条件与验证方式，区分事实、推断和未经核实的说法，培养求真务实的科学精神`,
};

function sentencesOf(text) {
  return text.split(/(?<=[。！？；\n])/).map(clean).filter((s) => s.length >= 6 && s.length <= 220);
}
function sectionsOf(m) {
  const out = []; let cur = { title: m.filename.replace(/\.[a-z]+$/i, ''), lines: [] };
  for (const raw of m.text.split('\n')) {
    const l = clean(raw); if (!l) continue;
    if (isHeading(l)) { if (cur.lines.length || cur.heading || out.length === 0) out.push(cur); cur = { title: stripNum(l) || l, lines: [], heading: true }; }
    else cur.lines.push(l);
  }
  out.push(cur);
  return out.filter((s) => s.lines.length || s.heading);
}

function guessCourse(materials) {
  const all = materials.map((m) => m.text).join('\n');
  const first = materials[0];
  const lines = first ? first.text.split('\n').map(clean).filter(Boolean) : [];
  const nameLine = lines.find((l) => /课程名称[:：]/.test(l));
  const name = nameLine ? clean(nameLine.split(/[:：]/)[1]).slice(0, 30) : (lines[0] && lines[0].length <= 24 && !/[。，]/.test(lines[0]) ? stripNum(lines[0]) : first?.filename.replace(/\.[a-z]+$/i, '').replace(/(教学大纲|讲义|课件|教案|大纲)$/, '') || '');
  const hours = (all.match(/(?:总学时|学时)[:：\s]*(\d{1,3})|(\d{1,3})\s*学时/) || []).slice(1).find(Boolean);
  const weeks = (all.match(/(\d{1,2})\s*周/) || [])[1];
  const major = (all.match(/(?:适用专业|专业)[:：\s]*([^\s，。；]{2,20})/) || [])[1];
  const audience = (all.match(/(?:授课对象|适用对象|对象)[:：\s]*([^\s，。；]{2,20})/) || [])[1];
  const sents = sentencesOf(all);
  const pick = (re) => [...new Set(sents.filter((s) => re.test(s)).map((s) => s.replace(/^[^：:]{0,10}[:：]/, '')))].slice(0, 2).join(''); // 同一材料重复导入时不重复取句
  return {
    name: name || '', major: major || '', audience: audience || '', hours: hours ? Number(hours) : null, weeks: weeks ? Number(weeks) : null,
    goal_knowledge: pick(/^(?!.*(课程思政|思政|价值)).*(掌握|理解|了解|熟悉)/).slice(0, 160), goal_ability: pick(/能够|能运用|学会|会用|具备.{0,6}能力/).slice(0, 160), goal_value: pick(/培养|树立|增强|养成|意识|精神|责任/).slice(0, 160),
  };
}

/** Analyse materials → { course, sections, knowledge_points, ideology_sentences, stats }. Deterministic. */
export function analyzeMaterials(materials, { max = 30 } = {}) {
  const kps = []; const seen = new Set(); const sectionsAll = [];
  const ideologySentences = [];
  const IDEO_WORDS = /课程思政|思政|立德树人|价值观|家国|工匠精神|职业道德|职业素养|社会责任|工程伦理|诚信|法治|爱国|使命|担当/;
  for (const m of materials) {
    const secs = sectionsOf(m);
    for (const sec of secs) {
      const src = `《${m.filename}》${sec.heading ? `·${sec.title}` : ''}`;
      sectionsAll.push({ title: sec.title, source: src, n: sec.lines.length, heading: !!sec.heading });
      const sents = sec.lines.flatMap((l) => sentencesOf(l));
      for (const s of sents) if (IDEO_WORDS.test(s)) ideologySentences.push({ text: s, source: src });
      const secKps = [];
      for (const s of sents) {
        for (const re of DEF_PATTERNS) {
          const mm = s.match(re); if (!mm) continue;
          let term = re === DEF_PATTERNS[2] ? mm[2] : mm[1], def = re === DEF_PATTERNS[2] ? mm[1] : mm[2];
          term = stripNum(term).replace(/^(所谓|其中|而)/, '');
          if (term.length < 2 || term.length > 16 || GENERIC.test(term) || /[的了在和与或]$/.test(term) || seen.has(term)) continue;
          def = clean(def).replace(/^[，,:：\s]+/, '');
          if (def.length < 4) continue;
          seen.add(term); secKps.push({ term, definition: def.slice(0, 160), sentence: s, section: sec.title, source: src, kind: 'definition' });
          break;
        }
      }
      // headings without an explicit definition still name a knowledge point
      if (sec.heading && !secKps.length && !seen.has(sec.title) && sec.title.length >= 2 && sec.title.length <= 20 && !GENERIC.test(sec.title)) {
        seen.add(sec.title);
        // outline items without body text are kept as topics; their definition must be supplied by the teacher
        secKps.push({ term: sec.title, definition: sents.length ? sents.slice(0, 2).join('').slice(0, 160) : '（材料只列出了这一主题，未给出具体内容，需教师补充）', sentence: sents[0] || '', section: sec.title, source: src, kind: sents.length ? 'heading' : 'topic' });
      }
      for (const kp of secKps) {
        kp.key_sentences = sents.filter((s) => s !== kp.sentence && (s.includes(kp.term) || /重点|关键|注意|必须|原则|方法|步骤|条件/.test(s))).slice(0, 3);
        kp.example = sents.find((s) => /例如|比如|案例|举例|例：|如图/.test(s)) || '';
        kp.caution = sents.find((s) => /注意|易错|误区|区别|不同于|混淆|切勿|不能与/.test(s)) || '';
        kp.ideology_quote = sents.find((s) => IDEO_WORDS.test(s)) || '';
        kps.push(kp);
      }
    }
  }
  // rank: explicit definitions first, then by richness
  const RANK = { definition: 0, heading: 1, topic: 2 };
  kps.sort((a, b) => (a.kind === b.kind ? b.key_sentences.length - a.key_sentences.length : RANK[a.kind] - RANK[b.kind]));
  const top = kps.slice(0, max);
  const usage = {};
  top.forEach((kp, i) => { kp.id = `K${String(i + 1).padStart(2, '0')}`; enrich(kp, top, usage); });
  const course = guessCourse(materials);
  if (!course.unit) course.unit = (sectionsAll.find((s) => s.heading && s.n) || sectionsAll.find((s) => s.n) || {}).title || course.name;
  return { course, sections: sectionsAll.slice(0, 60), knowledge_points: top, ideology_sentences: ideologySentences.slice(0, 20),
    stats: { materials: materials.length, sections: sectionsAll.length, knowledge_points: top.length, definitions: top.filter((k) => k.kind === 'definition').length, ideology_sentences: ideologySentences.length } };
}

/** Difficulty, ideology linkage and a checking question for one knowledge point. */
function enrich(kp, all, usage = {}) {
  const text = `${kp.term}${kp.term}${kp.definition}${kp.key_sentences.join('')}`;
  // evidence score per category, lightly discounted by how often a category was already used (keeps linkages varied)
  const scored = IDEO_RULES.map((r) => { const n = r[0] === 'science' ? 0.8 : (text.match(new RegExp(r[3].source, 'g')) || []).length; return [r, n, n ? n - 2.5 * (usage[r[0]] || 0) : -99]; }).sort((a, b) => b[2] - a[2]);
  const [cat, catName, element] = scored[0][0];
  usage[cat] = (usage[cat] || 0) + 1;
  const sibling = all.find((o) => o !== kp && [...o.term].filter((ch) => kp.term.includes(ch)).length >= 2);
  kp.difficulty = kp.caution
    ? `材料提示：${kp.caution}`
    : sibling ? `学生容易把「${kp.term}」与「${sibling.term}」混淆，需要对比两者的定义与适用条件` : `「${kp.term}」的适用条件和边界是难点，建议配合实例讲解`;
  kp.ideology = { category: cat, category_name: catName, element,
    suggestion: kp.ideology_quote ? `材料原文：“${kp.ideology_quote}”——围绕「${kp.term}」把这句要求落实为具体的决策任务` : IDEO_TEMPLATES[cat](kp.term) };
  // choice question: the correct statement vs. definitions of other points (plausible distractors)
  const others = all.filter((o) => o !== kp && o.kind === 'definition').slice(0, 3);
  if (kp.kind === 'definition' && others.length >= 2) {
    const opts = [kp.definition, ...others.slice(0, 3).map((o) => o.definition)].map((d) => d.slice(0, 60));
    const pos = (kp.term.length + kp.definition.length) % opts.length; // deterministic shuffle
    [opts[0], opts[pos]] = [opts[pos], opts[0]];
    const letters = ['A', 'B', 'C', 'D'];
    kp.question = { qtype: '选择', stem: `关于「${kp.term}」，下列说法正确的是（  ）`, options: opts.map((o, i) => `${letters[i]}. ${o}`).join('\n'), answer: letters[pos],
      analysis: `依据${kp.source}：「${kp.term}」${kp.definition.slice(0, 80)}。其他选项分别描述的是${others.slice(0, opts.length - 1).map((o) => `「${o.term}」`).join('、')}。` };
  } else {
    kp.question = { qtype: '简答', stem: `请用自己的话说明「${kp.term}」，并举一个专业中的应用实例。`, options: '', answer: `要点：${kp.definition.slice(0, 100)}`, analysis: `依据${kp.source}` };
  }
  kp.case_question = { qtype: '案例分析', stem: `情境：在一项涉及「${kp.term}」的专业任务中，团队面临进度或成本压力，有人提出变通做法。请结合「${kp.term}」的专业要求判断是否可行，并分析其中的${element}问题。`,
    rubric: '专业依据正确完整（40%）；价值判断有理由、能权衡相关方利益（40%）；表达清楚（20%）。不以立场本身给分。' };
}

const bigrams = (s) => { const t = String(s).replace(/[^一-龥a-zA-Z0-9]/g, ''); const out = new Set(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
/**
 * Retrieval answer grounded in the imported materials (and knowledge points). Never fabricates:
 * when nothing relevant is found it says so.
 */
export function answerFromMaterials(question, materials = [], kps = []) {
  const q = String(question || '');
  const hits = kps.filter((k) => q.includes(k.term)).sort((a, b) => b.term.length - a.term.length).filter((k, i, arr) => !arr.slice(0, i).some((o) => o.term.includes(k.term)));
  if (hits.length >= 2) return { text: `可以对照两者的定义来区分：${hits.slice(0, 3).map((k) => `「${k.term}」${k.definition}（${k.source}）`).join('；')}。${hits.map((k) => k.caution).find(Boolean) ? `材料还提醒：${hits.map((k) => k.caution).find(Boolean)}` : ''}`, sources: hits.map((k) => k.source), grounded: true };
  const hit = hits[0];
  if (hit) return { text: `根据${hit.source}：「${hit.term}」${hit.definition}${hit.key_sentences[0] ? `。另外，${hit.key_sentences[0]}` : '。'}${hit.caution ? ` 需要注意：${hit.caution}` : ''}`, sources: [hit.source], grounded: true };
  const qb = bigrams(q); if (qb.size < 2) return { text: '这个问题在导入的材料中没有找到直接依据，需要查阅教材或核实后再回答。', sources: [], grounded: false };
  let best = null;
  for (const m of materials) for (const sec of sectionsOf(m)) for (const s of sec.lines.flatMap(sentencesOf)) {
    const sb = bigrams(s); let n = 0; for (const b of qb) if (sb.has(b)) n++;
    const score = n / Math.sqrt(qb.size);
    if (!best || score > best.score) best = { score, s, source: `《${m.filename}》${sec.heading ? `·${sec.title}` : ''}` };
  }
  if (best && best.score >= 0.9) return { text: `材料中相关的表述是（${best.source}）：“${best.s}”。据此，${best.s.length > 60 ? '可以先从这一点理解' : '可以这样理解'}；如需更完整的解释，建议结合教材进一步核实。`, sources: [best.source], grounded: true };
  return { text: '这个问题在导入的材料中没有找到直接依据，需要查阅教材或核实后再回答。', sources: [], grounded: false };
}

/** Student-safe view of knowledge points: no questions, answers or analyses (these stay teacher-only). */
export const safeKnowledge = (kps = []) => kps.map((k) => ({ id: k.id, term: k.term, definition: k.definition, source: k.source, caution: k.caution || '', key_sentences: (k.key_sentences || []).slice(0, 2) }));
/** Knowledge points whose term appears in the given text (for attaching to classroom stages). */
export const kpsIn = (text, kps) => kps.filter((k) => String(text || '').includes(k.term));
