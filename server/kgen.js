// Build artifact sections from discussed knowledge points (no model): every row comes from the imported
// materials — definitions, sources, difficulties, knowledge-specific 课程思政 linkages and checking questions.
// Returns null for sections it cannot fill, so callers fall back to other builders.

const distribute = (total, n) => { if (!n) return []; const b = Math.floor(total / n), a = Array(n).fill(b); for (let i = 0; i < total - b * n; i++) a[i]++; return a; };
const short = (s, n = 40) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

/** Knowledge point merged with the discussion notes (model outputs replace rule-based text when present). */
function view(kp, notes = {}) {
  const n = notes[kp.id] || {};
  const fromModel = n.source === 'model';
  return { ...kp,
    explanation: fromModel && n.kp_explain ? n.kp_explain : `${kp.definition}${kp.key_sentences?.[0] ? `；${kp.key_sentences[0]}` : ''}`,
    difficultyText: fromModel && n.kp_difficulty ? n.kp_difficulty : kp.difficulty,
    ideologyText: fromModel && n.kp_ideology ? n.kp_ideology : kp.ideology.suggestion,
    itemText: fromModel && n.kp_item ? n.kp_item : null };
}

export function knowledgeSection(sec, body) {
  const all = body.knowledge || [];
  if (!all.length) return null;
  const notes = body.kp_notes || {};
  const kps = all.slice(0, 12).map((k) => view(k, notes));
  const defs = kps.filter((k) => k.kind === 'definition');
  const c = body.course || {}, fw = body.framework;
  const terms = kps.map((k) => k.term);
  const cats = [...new Set(kps.map((k) => k.ideology.category_name))];
  const sources = [...new Set(kps.map((k) => k.source.replace(/·.*$/, '')))];
  const bySection = []; for (const k of kps) { let g = bySection.find((x) => x.section === k.section); if (!g) bySection.push(g = { section: k.section, kps: [] }); g.kps.push(k); }
  const goalFor = (k) => (k.ideology ? 'K1,A1,V1' : 'K1,A1');
  switch (sec.key) {
    case 'positioning': case 'overview':
      return { content: `${c.name || '本课程'}${c.major ? `（${c.major}${c.audience ? `，${c.audience}` : ''}）` : ''}。依据导入材料，本部分核心知识包括${terms.slice(0, 6).map((t) => `「${t}」`).join('、')}等${kps.length}个知识点；课程思政以${cats.slice(0, 3).join('、')}为主线，逐个结合具体知识点设置决策情境，而不是在课末附加口号。（材料：${sources.join('、')}）` };
    case 'learners':
      return { content: `先修要求：${c.prereq || '见材料'}。依据知识点研讨，学生的主要学习难点：${kps.slice(0, 3).map((k) => `「${k.term}」——${short(k.difficultyText, 50)}`).join('；')}。` };
    case 'goals':
      return { rows: [
        { id: 'K1', category: '知识', description: c.goal_knowledge || `掌握${terms.slice(0, 4).map((t) => `「${t}」`).join('、')}的含义与适用条件` },
        { id: 'A1', category: '能力', description: c.goal_ability || `能运用${terms.slice(0, 2).map((t) => `「${t}」`).join('、')}等知识分析和解决专业问题，并说明依据` },
        { id: 'V1', category: '价值', description: c.goal_value || `在涉及${cats.slice(0, 2).join('、')}的专业情境中作出有依据的价值判断` }] };
    case 'key_points':
      return { content: `重点：${defs.slice(0, 3).map((k) => `「${k.term}」（${short(k.definition, 30)}）`).join('；') || terms.slice(0, 3).join('、')}\n难点：${kps.slice(0, 2).map((k) => short(k.difficultyText, 60)).join('；')}` };
    case 'content': case 'units': {
      const hours = distribute(Number(c.hours) || bySection.length * 2, bySection.length);
      return { rows: bySection.map((g, i) => ({ unit: g.section || `单元${i + 1}`, content: g.kps.map((k) => `${k.term}：${short(k.definition, 36)}`).join('；'), hours: String(hours[i]), goal_refs: 'K1,A1,V1',
        ideology_point: g.kps[0].ideologyText, method: g.kps.some((k) => k.example) ? '案例引入+讲授+辨析' : '讲授+讨论' })) };
    }
    case 'mapping':
      return { rows: kps.slice(0, 8).map((k) => ({ element: k.ideology.element, case: k.ideologyText, professional_link: `「${k.term}」`, source: k.ideology_quote ? k.source : `融入设计依据${k.source}（情境为原创，涉及事实需核查）` })) };
    case 'goals_map':
      return { rows: cats.slice(0, 4).map((cat) => { const ks = kps.filter((k) => k.ideology.category_name === cat); return { goal: `在专业学习中体现${cat}`, element: ks[0].ideology.element, approach: `在${ks.map((k) => `「${k.term}」`).slice(0, 3).join('、')}等知识点中设置决策情境：${short(ks[0].ideologyText, 50)}`, evidence: `案例分析题得分与讨论记录中的理由质量（对应「${ks[0].term}」）` }; }) };
    case 'courses':
      return { rows: [{ course: c.name || '本课程', semester: '', focus: kps.slice(0, 4).map((k) => `「${k.term}」→${k.ideology.category_name}`).join('；'), responsible: '' }] };
    case 'methods': case 'strategy':
      return { content: `以${fw ? fw.name : '问题驱动'}组织教学：每个知识点按“实例引入—定义辨析—专业应用—价值判断”展开。难点处理：${kps.slice(0, 2).map((k) => short(k.difficultyText, 40)).join('；')}。思政融入不单独成段，而是嵌入${terms.slice(0, 3).map((t) => `「${t}」`).join('、')}的应用决策中。` };
    case 'ideology':
      return { content: kps.slice(0, 4).map((k) => `「${k.term}」（${k.ideology.category_name}）：${k.ideologyText}`).join('\n') };
    case 'references':
      return { rows: sources.map((s) => ({ title: s, source: '教师导入材料' })) };
    case 'stages': {
      const steps = fw?.steps || [['intro', '导入'], ['teach', '讲授'], ['practice', '练习'], ['summary', '总结']];
      const mins = distribute(Number(c.lesson_minutes) || 45, steps.length);
      const main = steps.map(([k], i) => i).filter((i) => !/bridge|intro|engage|objective|summary|pre_assess|post_assess|evaluate|reflect|real_problem|driving|pre_class|post_class|plan|analysis|showcase/.test(steps[i][0]));
      const teachIdx = main.length ? main : [Math.floor(steps.length / 2)];
      const assign = teachIdx.map(() => []); kps.slice(0, Math.max(teachIdx.length, 6)).forEach((k, j) => assign[j % teachIdx.length].push(k));
      const withQ = defs.length ? defs : kps;
      return { rows: steps.map(([key, label], i) => {
        const mine = assign[teachIdx.indexOf(i)] || [];
        let teacher = '', question = '', assessment = '', goal = 'K1';
        if (/bridge|intro|engage|real_problem|driving|pre_class/.test(key)) { teacher = `${label}：${kps[0].example || kps[0].ideology_quote || `从一个与「${kps[0].term}」相关的专业问题引入`}。`; question = `你能举一个生活或工程中与「${kps[0].term}」有关的例子吗？`; goal = 'K1,V1'; }
        else if (/objective|plan|analysis/.test(key)) { teacher = `${label}：本节要掌握${terms.slice(0, 3).map((t) => `「${t}」`).join('、')}，能用它们作出有依据的专业判断，并理解相关的${cats[0]}。`; }
        else if (/pre_assess/.test(key)) { const k = withQ[0]; teacher = `${label}：先测一测对「${k.term}」的已有理解。`; question = `${k.question.stem}${k.question.options ? `\n${k.question.options}` : ''}`; assessment = `前测：${k.term}（答案 ${k.question.answer}）`; goal = 'K1'; }
        else if (/post_assess|evaluate|check|showcase/.test(key)) { const ks = withQ.slice(1, 3).length ? withQ.slice(1, 3) : withQ.slice(0, 1); teacher = `${label}：检测本节知识点的掌握情况。`; question = ks.map((k) => k.question.stem).join('\n'); assessment = `后测：${ks.map((k) => `${k.term}（${k.question.answer}）`).join('；')}`; goal = 'K1,A1'; }
        else if (/summary|reflect|post_class/.test(key)) { teacher = `${label}：回顾${terms.slice(0, 4).map((t) => `「${t}」`).join('、')}的要点；讨论中未解决的问题留作课后查证。`; goal = 'K1,V1'; }
        else { const ks = mine.length ? mine : [kps[i % kps.length]]; teacher = `${label}：${ks.map((k) => `「${k.term}」${k.definition}`).join('。')}。`; question = ks[0].ideology ? `结合「${ks[0].term}」：${short(ks[0].case_question.stem, 90)}` : ''; assessment = ks.length ? `课堂提问：能否说出${ks.map((k) => `「${k.term}」`).join('、')}的关键条件` : ''; goal = 'K1,A1,V1'; }
        return { stage: key, minutes: String(mins[i]), teacher_activity: teacher, student_activity: question ? '思考、回答并说明理由' : '听讲、记录要点', question, materials: [...new Set((mine.length ? mine : kps.slice(0, 1)).map((k) => k.source))].join('；'), assessment, goal_refs: /pre_assessment|post_assessment/.test(key) ? 'K1,V1' : goal };
      }) };
    }
    case 'slides':
      return { rows: kps.slice(0, 10).map((k) => ({ title: k.term, points: k.explanation, notes: `难点：${k.difficultyText}`, question: k.question.stem, case: k.ideologyText, source: k.source, author: '' })) };
    case 'items': {
      const rows = kps.slice(0, 8).map((k, i) => ({ knowledge: k.term, goal_refs: 'K1', qtype: k.question.qtype, difficulty: ['易', '中', '中', '难'][i % 4], stem: k.question.stem, options: k.question.options || '', answer: k.question.answer, analysis: k.question.analysis, suggestion: k.question.qtype === '选择' ? '选对得分；可追问排除其他选项的理由' : '要点完整、能举例' }));
      for (const k of kps.slice(0, 2)) rows.push({ knowledge: k.term, goal_refs: 'A1,V1', qtype: '案例分析', difficulty: '难', stem: k.case_question.stem, options: '', answer: `判断需以「${k.term}」的专业要求为依据：${short(k.definition, 50)}；并说明对相关方的影响与责任。`, analysis: '重在依据与理由，不以立场本身评分', suggestion: k.case_question.rubric });
      return { rows };
    }
    case 'instructions':
      return { content: `本卷依据导入材料中的${kps.length}个知识点命题，满分 ${Number(c.exam_total) || 100} 分。选择题考查概念辨析，案例分析题考查专业判断与价值判断的理由。本卷由系统依据材料生成，须经教师审核后使用。` };
    case 'questions': {
      const total = Number(c.exam_total) || 100;
      const choice = kps.filter((k) => k.question.qtype === '选择').slice(0, 8);
      const cases = kps.slice(0, 2);
      const choiceScore = choice.length ? Math.max(2, Math.floor((total * 0.4) / choice.length)) : 0;
      const rest = total - choiceScore * choice.length;
      const caseScores = distribute(rest, cases.length);
      const rows = [
        ...choice.map((k) => ({ qtype: '选择', goal_refs: 'K1', score: String(choiceScore), stem: k.question.stem, options: k.question.options, answer: k.question.answer, analysis: k.question.analysis, rubric: '' })),
        ...cases.map((k, i) => ({ qtype: '案例分析', goal_refs: 'A1,V1', score: String(caseScores[i]), stem: k.case_question.stem, options: '', answer: `以「${k.term}」的要求为依据作出判断：${short(k.definition, 50)}；分析对使用者/公众的影响及应承担的责任。`, analysis: `出处：${k.source}`, rubric: k.case_question.rubric })),
      ];
      return { rows: rows.map((r, i) => ({ no: String(i + 1), ...r })) };
    }
    case 'weeks': case 'rows': {
      const n = Math.min(Number(c.weeks) || 16, 30); const hours = distribute(Number(c.hours) || n * 2, n);
      return { rows: Array.from({ length: n }, (_, i) => {
        const g = bySection[Math.floor((i * bySection.length) / n)] || bySection[0];
        const first = i === 0 || Math.floor(((i - 1) * bySection.length) / n) !== Math.floor((i * bySection.length) / n);
        const content = `${g.section}：${g.kps.map((k) => k.term).join('、')}`;
        const ideo = first ? g.kps[0].ideologyText : '';
        return sec.key === 'weeks'
          ? { week: String(i + 1), chapter: g.section, goal_refs: first ? 'K1,V1' : 'K1,A1', activity: first ? '实例引入与概念辨析' : '练习与讨论', homework: `${g.kps[0].term}相关练习`, assessment: i === n - 1 ? '期末考核' : '课堂提问', ideology: ideo, hours: String(hours[i]) }
          : { week: String(i + 1), lesson_no: `第${i + 1}次`, content, hours: String(hours[i]), form: first ? '讲授' : ['讨论', '实验', '讲授'][i % 3], ideology: ideo, homework: `${g.kps[0].term}相关练习` };
      }) };
    }
    case 'points':
      return { rows: kps.map((k) => ({ id: k.id, term: k.term, explanation: k.explanation, difficulty: k.difficultyText, ideology: k.ideologyText, question: `${k.question.stem}${k.question.options ? `\n${k.question.options}` : ''}`, answer: k.question.answer, source: k.source })) };
    case 'open': {
      const pend = kps.filter((k) => k.kind === 'heading').map((k) => `「${k.term}」材料中没有明确定义，需教师补充`);
      const facts = kps.filter((k) => ['mission', 'law', 'culture'].includes(k.ideology.category)).map((k) => `「${k.term}」的思政融入涉及事实或法规，出处需核查`);
      return { content: [...pend, ...facts].join('\n') || '无' };
    }
    default: return null;
  }
}

/** Revise a section of an existing artifact using classroom feedback (rule-based, visible and traceable edits). */
export function reviseWithFeedback(sec, body, feedback) {
  if (!feedback) return null;
  const fsec = (k) => feedback.body.sections.find((s) => s.key === k);
  const timing = fsec('timing')?.rows || [], issues = fsec('open_issues')?.rows || [], sugg = fsec('suggestions')?.rows || [];
  const stepLabel = (v) => (body.framework?.steps || []).find(([k]) => k === v)?.[1] || v;
  if (sec.key === 'stages' && sec.kind === 'table') {
    const rows = sec.rows.map((r) => {
      const t = timing.find((x) => x.stage === stepLabel(r.stage));
      const out = { ...r };
      if (t && Number(t.planned) && Number(t.simulated) > Number(t.planned) * 1.3) out.teacher_activity = `${r.teacher_activity}（修订：演课场中该环节用时 ${t.simulated} 分钟，超过计划 ${t.planned} 分钟；保留核心定义讲解，其余转为课前阅读）`;
      if (t && /^0\//.test(String(t.lecture || '')) && Number(t.simulated) === 0) out.assessment = `${r.assessment || ''}（修订：上次课未进行到本环节，需前移或压缩前序环节）`.trim();
      return out;
    });
    // unanswered student questions become planned questions in the teaching stages
    const teach = rows.findIndex((r) => r.question !== undefined && !/summary|总结/.test(r.stage));
    issues.slice(0, 3).forEach((iss) => { const r = rows[teach >= 0 ? teach : 0]; r.question = `${r.question ? `${r.question}\n` : ''}上次课学生提出：${String(iss.issue).replace(/^[^：]*：/, '')}（本环节预留回应）`; });
    return { rows };
  }
  if (sec.key === 'reflection' && sec.kind === 'text') {
    return { content: `${sec.content ? `${sec.content}\n` : ''}依据课堂反馈修订：${sugg.slice(0, 4).map((s) => s.suggestion).join('；') || '无明显问题'}。未解决问题 ${issues.length} 个，已写入相应教学环节。` };
  }
  return null;
}
