// Built-in teaching design frameworks, 课程思政 artifact templates, seminar roles/modes and rubric v1.
// Three separate axes: 研讨模式 (who/how) · 教学设计框架 (how the design is organised) · 产物类型 (what is produced).
import { one, all, run, id, now, tx, check, audit, json } from './db.js';

const FRAMEWORK_NOTE = '框架步骤为教学设计的组织方式说明；宣传材料中的教学效果不作为已验证结论。';

export const FRAMEWORKS = {
  boppps: { name: 'BOPPPS', scope: 'lesson', note: '单课/单元教学设计；前测与后测必须关联教学目标。',
    steps: [['bridge_in', '导入'], ['objective', '目标'], ['pre_assessment', '前测'], ['participatory', '参与式学习'], ['post_assessment', '后测'], ['summary', '总结']],
    fields: [['pretest_method', '前测方式', '如：3 道诊断题/课前问卷']], linked_steps: ['pre_assessment', 'post_assessment'] },
  pdca: { name: 'PDCA', scope: 'cycle', note: '教学持续改进闭环（计划—实施—检查—改进），不是课堂六步法。',
    steps: [['plan', '计划'], ['do', '实施'], ['check', '检查'], ['act', '改进']],
    fields: [['improvement_target', '改进对象', '如：案例讨论环节的参与质量'], ['baseline_evidence', '基线证据', '上一轮课堂或反馈中的具体事件/数据']] },
  addie: { name: 'ADDIE', scope: 'course', note: '课程/资源建设流程。',
    steps: [['analysis', '分析'], ['design', '设计'], ['development', '开发'], ['implementation', '实施'], ['evaluation', '评价']],
    fields: [['needs_analysis', '需求分析', '学习者与岗位/课程需求']] },
  five_e: { name: '5E', scope: 'lesson', note: '探究活动设计。',
    steps: [['engage', '引入'], ['explore', '探究'], ['explain', '解释'], ['elaborate', '迁移拓展'], ['evaluate', '评价']],
    fields: [['inquiry_phenomenon', '探究现象/问题', '引发探究的真实现象']] },
  pjbl: { name: '项目式学习（PjBL，Project-Based Learning）', scope: 'lesson', note: '综合实践项目；不与问题导向学习（Problem-Based Learning）混用缩写。',
    steps: [['driving_question', '驱动问题'], ['task_planning', '任务规划'], ['inquiry', '探究实施'], ['showcase', '成果展示'], ['reflection', '评价反思']],
    fields: [['driving_question', '驱动问题', '一个开放、真实、需要项目产出的问题'], ['deliverable', '项目成果形式', '如：检测方案报告+答辩']] },
  problem_based: { name: '问题导向学习（Problem-Based Learning）', scope: 'lesson', note: '案例与决策分析。',
    steps: [['real_problem', '真实问题'], ['prior_knowledge', '已有知识'], ['information', '信息搜集'], ['compare', '方案比较'], ['reflect', '反思']],
    fields: [['real_problem', '真实问题/案例', '含决策情境与约束']] },
  flipped: { name: '翻转课堂', scope: 'lesson', note: '配置课前材料和课堂任务。',
    steps: [['pre_class', '课前学习'], ['in_class', '课中探究'], ['post_class', '课后巩固与评价']],
    fields: [['pre_class_materials', '课前材料', '视频/阅读材料及来源'], ['in_class_task', '课堂任务', '课中要完成的探究任务']] },
};

export const COURSE_FIELDS = [
  ['name', '课程名称', true], ['major', '专业', true], ['audience', '对象/年级', true], ['hours', '总学时', false, 'number'],
  ['weeks', '周次', false, 'number'], ['lesson_minutes', '课时长度（分钟）', false, 'number'], ['prereq', '先修知识', false],
  ['unit', '课程/单元主题', true], ['goal_knowledge', '知识目标', true], ['goal_ability', '能力目标', true], ['goal_value', '价值目标', true],
  ['ideology_elements', '思政元素', true], ['cases', '真实案例（注明来源）', false], ['links', '专业知识关联', false],
  ['activities', '课堂活动', false], ['evidence', '证据材料', false], ['criteria', '评价标准', false], ['constraints', '教学约束', false],
  ['exam_total', '试卷总分', false, 'number'],
];

const GOAL_COLS = [['id', '编号'], ['category', '类别', 'select', ['知识', '能力', '价值']], ['description', '目标描述', 'longtext']];
const col = ([key, label, type = 'text', options, teacher_only]) => ({ key, label, type, options, teacher_only: !!teacher_only });
const cols = (list) => list.map(col);
const QTYPES = ['选择', '判断', '简答', '案例分析', '实践任务'];
export const LESSON_MINUTES = [15, 25, 45, 50, 90];

/** 思政元素参考库：类别、元素与“与专业知识结合”的引导问题。只给思考框架，不收录政策原文，避免编造条文。 */
export const IDEOLOGY_LIBRARY = [
  { key: 'mission', name: '家国情怀与使命担当', elements: ['家国情怀', '民族复兴', '科技自立自强', '服务国家战略'], questions: ['本知识点在我国相关产业/工程中的发展与突破是什么？（注明来源）', '学生未来岗位如何服务地方和国家需求？'] },
  { key: 'science', name: '科学精神与创新', elements: ['科学精神', '求真务实', '创新精神', '批判性思维'], questions: ['这一结论是如何被验证的？有哪些前提和边界？', '如果数据与预期不符，应如何处理？'] },
  { key: 'ethics', name: '工程伦理与社会责任', elements: ['工程伦理', '社会责任', '公共安全', '公共利益'], questions: ['技术决策会影响哪些利益相关者？', '当成本、进度与安全冲突时，依据什么做出取舍？'] },
  { key: 'craft', name: '职业规范与工匠精神', elements: ['工匠精神', '职业道德', '质量意识', '精益求精'], questions: ['本任务对应的行业标准或操作规程是什么？（注明标准号，未核实标“待核查”）', '一个“差不多”的决定可能造成什么后果？'] },
  { key: 'law', name: '法治意识与规则意识', elements: ['法治意识', '规范意识', '知识产权', '数据安全'], questions: ['本专业活动受哪些法规或制度约束？（需核查来源）', '违反规则的真实案例说明了什么？'] },
  { key: 'green', name: '生态文明与可持续发展', elements: ['生态文明', '绿色发展', '节能减排', '可持续发展'], questions: ['本技术方案的资源与环境代价是什么？', '有无更可持续的替代方案？'] },
  { key: 'culture', name: '文化自信与人文素养', elements: ['文化自信', '中华优秀传统文化', '人文关怀'], questions: ['本领域有哪些值得了解的中国技术史或人物？（注明出处）', '技术如何体现对人的关怀？'] },
  { key: 'integrity', name: '诚信与学术规范', elements: ['诚信', '学术规范', '数据真实性', '团队协作'], questions: ['实验/检测数据如何保证真实可追溯？', '合作任务中如何清楚说明个人贡献？'] },
];

export const ARTIFACT_TYPES = {
  syllabus: { name: '思政版教学大纲', unit_source: 'content', sections: [
    { key: 'positioning', title: '课程定位', kind: 'text', owner: 'leader' },
    { key: 'learners', title: '学情分析', kind: 'text', owner: 'designer' },
    { key: 'goals', title: '三类目标', kind: 'table', owner: 'designer', columns: cols(GOAL_COLS) },
    { key: 'content', title: '内容与学时', kind: 'table', owner: 'subject', columns: cols([['unit', '单元'], ['content', '内容', 'longtext'], ['hours', '学时', 'number'], ['goal_refs', '对应目标'], ['ideology_point', '思政融入点', 'longtext']]) },
    { key: 'mapping', title: '思政映射', kind: 'table', owner: 'ideology', columns: cols([['element', '思政元素'], ['case', '案例/情境', 'longtext'], ['professional_link', '专业知识关联', 'longtext'], ['source', '来源（无则“待核查”）']]) },
    { key: 'methods', title: '教学方法', kind: 'text', owner: 'designer' },
    { key: 'assessment', title: '考核', kind: 'table', owner: 'assessor', columns: cols([['item', '考核项'], ['weight', '权重%', 'number'], ['goal_refs', '对应目标'], ['criteria', '评价标准', 'longtext']]) },
    { key: 'references', title: '参考材料', kind: 'table', owner: 'evidence', columns: cols([['title', '材料'], ['source', '来源（无则“待核查”）']]) },
  ] },
  talent_plan: { name: '人才培养方案（课程思政融入）', not_runnable: true, sections: [
    { key: 'positioning', title: '专业定位与培养目标', kind: 'text', owner: 'leader' },
    { key: 'goals_map', title: '培养目标—思政元素映射', kind: 'table', owner: 'ideology', columns: cols([['goal', '培养目标', 'longtext'], ['element', '思政元素'], ['approach', '融入路径', 'longtext'], ['evidence', '达成证据', 'longtext']]) },
    { key: 'requirements', title: '毕业要求—课程思政支撑矩阵', kind: 'table', owner: 'designer', columns: cols([['requirement', '毕业要求', 'longtext'], ['courses', '支撑课程'], ['element', '思政元素'], ['level', '支撑强度', 'select', ['H', 'M', 'L']]]) },
    { key: 'courses', title: '课程体系思政分工', kind: 'table', owner: 'subject', columns: cols([['course', '课程'], ['semester', '学期'], ['focus', '思政重点', 'longtext'], ['responsible', '负责教研室/教师']]) },
    { key: 'practice', title: '实践教学与第二课堂', kind: 'table', owner: 'industry', columns: cols([['activity', '活动'], ['element', '思政元素'], ['assessment', '评价方式', 'longtext']]) },
    { key: 'evaluation', title: '评价与持续改进', kind: 'text', owner: 'assessor' },
    { key: 'references', title: '依据与参考', kind: 'table', owner: 'evidence', columns: cols([['title', '材料'], ['source', '来源（无则“待核查”）']]) },
  ] },
  course_design: { name: '课程教学设计', unit_source: 'units', sections: [
    { key: 'overview', title: '课程概述与学情', kind: 'text', owner: 'leader' },
    { key: 'goals', title: '课程目标', kind: 'table', owner: 'designer', columns: cols(GOAL_COLS) },
    { key: 'units', title: '教学内容与思政融入', kind: 'table', owner: 'subject', columns: cols([['unit', '单元'], ['content', '内容', 'longtext'], ['hours', '学时', 'number'], ['goal_refs', '对应目标'], ['ideology_point', '思政融入点', 'longtext'], ['method', '教学方法']]) },
    { key: 'strategy', title: '教学策略与课堂组织', kind: 'text', owner: 'designer' },
    { key: 'assessment', title: '考核评价', kind: 'table', owner: 'assessor', columns: cols([['item', '考核项'], ['weight', '权重%', 'number'], ['goal_refs', '对应目标'], ['criteria', '评价标准', 'longtext']]) },
    { key: 'improvement', title: '持续改进', kind: 'text', owner: 'evidence' },
  ] },
  teaching_schedule: { name: '教学计划进度表', unit_source: 'rows', sections: [
    { key: 'info', title: '进度说明', kind: 'text', owner: 'leader' },
    { key: 'rows', title: '教学进度', kind: 'table', owner: 'subject', columns: cols([['week', '周次', 'number'], ['lesson_no', '课次'], ['content', '教学内容', 'longtext'], ['hours', '学时', 'number'], ['form', '形式', 'select', ['讲授', '实验', '讨论', '实践', '测验']], ['ideology', '思政融入点', 'longtext'], ['homework', '作业']]) },
  ] },
  semester_plan: { name: '学期教学设计', unit_source: 'weeks', sections: [
    { key: 'goals', title: '课程目标', kind: 'table', owner: 'designer', columns: cols(GOAL_COLS) },
    { key: 'weeks', title: '周次安排', kind: 'table', owner: 'subject', columns: cols([['week', '周次', 'number'], ['chapter', '章节'], ['goal_refs', '目标'], ['activity', '活动', 'longtext'], ['homework', '作业'], ['assessment', '评价'], ['ideology', '思政融入点', 'longtext'], ['hours', '学时', 'number']]) },
    { key: 'notes', title: '说明', kind: 'text', owner: 'leader' },
  ] },
  lesson_plan: { name: '单课教案', sections: [
    { key: 'key_points', title: '教学重难点', kind: 'text', owner: 'subject' },
    { key: 'goals', title: '教学目标', kind: 'table', owner: 'designer', columns: cols(GOAL_COLS) },
    { key: 'stages', title: '教学过程（按所选框架阶段）', kind: 'table', owner: 'designer', framework_stages: true,
      columns: cols([['stage', '阶段', 'stage'], ['minutes', '时间(分)', 'number'], ['teacher_activity', '教师活动', 'longtext'], ['student_activity', '学生活动', 'longtext'], ['question', '互动问题', 'longtext'], ['materials', '材料/案例（含来源）', 'longtext'], ['assessment', '评价', 'longtext'], ['goal_refs', '对应目标']]) },
    { key: 'ideology', title: '思政融入与价值冲突情境', kind: 'text', owner: 'ideology' },
    { key: 'reflection', title: '教学反思（课后填写）', kind: 'text', owner: 'leader' },
  ] },
  courseware: { name: '课程思政课件', sections: [
    { key: 'slides', title: '页面结构', kind: 'table', owner: 'subject', columns: cols([['title', '页标题'], ['points', '要点', 'longtext'], ['notes', '教师备注', 'longtext', null, true], ['question', '互动问题'], ['case', '案例'], ['source', '来源（无则“待核查”）'], ['author', '页面作者']]) },
  ] },
  exercises: { name: '模拟练习', sections: [
    { key: 'goals', title: '练习目标', kind: 'table', owner: 'designer', columns: cols(GOAL_COLS) },
    { key: 'items', title: '题目', kind: 'table', owner: 'assessor', columns: cols([['knowledge', '知识点'], ['goal_refs', '目标'], ['qtype', '题型', 'select', QTYPES], ['difficulty', '难度', 'select', ['易', '中', '难']], ['stem', '题干', 'longtext'], ['options', '选项', 'longtext'], ['answer', '参考答案', 'longtext', null, true], ['analysis', '解析', 'longtext', null, true], ['suggestion', '评价建议', 'longtext', null, true]]) },
  ] },
  exam: { name: '模拟试卷', sections: [
    { key: 'instructions', title: '考试说明', kind: 'text', owner: 'assessor' },
    { key: 'goals', title: '考核目标', kind: 'table', owner: 'designer', columns: cols(GOAL_COLS) },
    { key: 'questions', title: '题目', kind: 'table', owner: 'assessor', columns: cols([['no', '题号'], ['qtype', '题型', 'select', QTYPES], ['goal_refs', '目标'], ['score', '分值', 'number'], ['stem', '题干', 'longtext'], ['options', '选项', 'longtext'], ['answer', '参考答案', 'longtext', null, true], ['analysis', '解析', 'longtext', null, true], ['rubric', '评分标准', 'longtext', null, true]]) },
  ] },
  reflection_report: { name: '教学反思报告', sections: [
    { key: 'expected', title: '设计预期', kind: 'text', owner: 'designer' },
    { key: 'observed', title: '观察事件（引用真实事件ID）', kind: 'table', owner: 'evidence', columns: cols([['event_id', '事件ID'], ['observation', '观察记录', 'longtext']]) },
    { key: 'deviations', title: '偏差', kind: 'text', owner: 'assessor' },
    { key: 'hypotheses', title: '原因假设（与事实分开）', kind: 'table', owner: 'subject', columns: cols([['hypothesis', '假设'], ['basis', '依据/待验证方式', 'longtext']]) },
    { key: 'improvements', title: '改进措施', kind: 'text', owner: 'leader' },
    { key: 'reverify', title: '再验证计划', kind: 'text', owner: 'evidence' },
  ] },
  classroom_feedback: { name: '课堂反馈', system_only: true, sections: [
    { key: 'summary', title: '课堂摘要', kind: 'text' },
    { key: 'open_issues', title: '未解决问题', kind: 'table', columns: cols([['issue', '问题', 'longtext'], ['event_id', '关联事件']]) },
    { key: 'suggestions', title: '建议修订', kind: 'table', columns: cols([['suggestion', '建议', 'longtext'], ['basis_event_id', '依据事件']]) },
    { key: 'timing', title: '环节用时（计划 vs 模拟）', kind: 'table', columns: cols([['stage', '环节'], ['planned', '计划(分)', 'number'], ['simulated', '模拟用时(分)', 'number'], ['lecture', '讲解段落完成'], ['ideology', '思政相关发言', 'number']]) },
    { key: 'boundary', title: '数据边界', kind: 'text' },
  ] },
  knowledge_map: { name: '课程知识点与思政融入图谱', not_runnable: true, sections: [
    { key: 'overview', title: '课程与材料概况', kind: 'text', owner: 'leader' },
    { key: 'points', title: '知识点研讨结果', kind: 'table', owner: 'subject', columns: cols([['id', '编号'], ['term', '知识点'], ['explanation', '讲解要点', 'longtext'], ['difficulty', '难点与误区', 'longtext'], ['ideology', '思政融入点', 'longtext'], ['question', '检测题', 'longtext'], ['answer', '参考答案', 'longtext', null, true], ['source', '出处']]) },
    { key: 'open', title: '待核查与待补充', kind: 'text', owner: 'evidence' },
  ] },
  legacy_plan: { name: '旧版方案（迁移）', system_only: true, sections: [
    { key: 'content', title: '方案正文', kind: 'text' },
  ] },
};

export const PDCA_SECTION = { key: 'pdca', title: 'PDCA 改进循环', kind: 'table', owner: 'evidence',
  columns: cols([['phase', '阶段', 'select', ['计划', '实施', '检查', '改进']], ['content', '内容', 'longtext'], ['evidence', '证据/指标', 'longtext'], ['next_action', '下一步', 'longtext']]) };

export const SEMINAR_ROLES = {
  leader: { name: '教研组长', duty: '主持、分派、轮询进度、处理冲突、整合成果' },
  designer: { name: '教学设计教师', duty: '目标、框架阶段与活动设计' },
  subject: { name: '专业教师', duty: '专业内容准确性与案例的专业依据' },
  ideology: { name: '思政教师', duty: '思政元素与专业任务的有机融入' },
  assessor: { name: '评价专家', duty: '评价方式、题目与评分标准' },
  evidence: { name: '证据审查教师', duty: '来源可追溯、事实与推断区分' },
  lab: { name: '实验教师', duty: '实践环节可行性' },
  industry: { name: '行业导师', duty: '岗位真实情境与职业规范' },
  junior: { name: '青年教师', duty: '学情视角与课堂可操作性' },
};
export const DEFAULT_SEATS = ['leader', 'designer', 'subject', 'ideology', 'assessor', 'evidence', 'industry', 'junior'];
// 研课八步：任务分配 → 讨论交流 → 写作初稿 → 对抗质询 → 打磨修改 → 整合汇总 → 集体评审 → 形成终稿
export const FULL_PHASES = ['assign', 'discuss', 'draft', 'debate', 'revise', 'integrate', 'review', 'finalize'];

export const SEMINAR_MODES = {
  full: { name: '研课八步（分配·交流·初稿·质询·打磨·整合·评审·终稿）', phases: FULL_PHASES },
  knowledge: { name: '知识点研讨（讲解·难点·思政·检测题）', phases: ['knowledge', 'assign', 'draft', 'poll', 'integrate'] },
  cooperate: { name: '专业分工协作', phases: ['assign', 'draft', 'poll', 'integrate'] },
  challenge: { name: '交叉质询', phases: ['assign', 'draft', 'challenge', 'integrate'] },
  mixed: { name: '先协作后对抗', phases: ['assign', 'draft', 'poll', 'challenge', 'integrate'] },
  group_cooperate: { name: '分组协作', phases: ['assign', 'draft', 'group_report', 'integrate'], groups: true },
  group_debate: { name: '分组对抗', phases: ['assign', 'draft', 'group_challenge', 'integrate'], groups: true },
  reflection: { name: '反思修订', phases: ['assign', 'draft', 'reflect', 'integrate'] },
  socratic: { name: '苏格拉底追问', phases: ['assign', 'draft', 'socratic', 'integrate'] },
};
export const PHASES = { materials: '材料研读', knowledge: '知识点研讨', assign: '任务分配', draft: '写作初稿', poll: '组长轮询', challenge: '交叉质询', group_report: '小组汇报', group_challenge: '组间质询', reflect: '依据反馈反思修订', socratic: '苏格拉底追问', integrate: '整合汇总', discuss: '讨论交流', debate: '对抗质询', revise: '打磨修改', review: '集体评审', finalize: '形成终稿' };

export const RUBRIC_V1 = {
  key: 'teaching_interaction_v1', version: 1, name: '教学互动与反思过程量规草案 v1', scale: [0, 4],
  status: 'draft_not_validated', note: '量规未经效度验证；正式研究需研究设计、专家审查、预测试与独立评价。未评/不适用/证据不足不是 0。',
  dimensions: [
    { key: 'values_alignment', label: '思政融入', anchors: ['无关联', '口号', '提及目标', '融入专业任务', '分析价值冲突与责任'] },
    { key: 'disciplinary_accuracy', label: '专业准确性', anchors: ['错误', '关键错误', '基本正确', '准确完整', '明确边界与不确定性'] },
    { key: 'evidence_use', label: '证据使用', anchors: ['无依据', '断言', '引用材料', '支持具体结论', '来源可追溯且区分推断'] },
    { key: 'question_quality', label: '质疑质量', anchors: ['无质疑', '泛问', '指出问题', '缺口与理由', '可检验关键质疑'] },
    { key: 'response_quality', label: '回应质量', anchors: ['未回应', '回避', '部分回应', '针对性举证', '修正主张并保留未知'] },
    { key: 'collaboration', label: '协作贡献', anchors: ['无贡献', '重复', '完成分工', '整合观点', '跨专业整合且归属清楚'] },
    { key: 'reflection_revision', label: '反思修订', anchors: ['无反思', '表态', '建议', '有依据修改', '版本、依据和再验证完整'] },
  ],
};
export const SPECIAL_SCORES = ['not_rated', 'not_applicable', 'insufficient_evidence'];

/** Validate a rubric definition (used for import). */
export function validateRubric(r) {
  check(r && typeof r === 'object', 400, 'bad_rubric', '量规必须是 JSON 对象');
  check(typeof r.key === 'string' && /^[a-z0-9_]{3,40}$/.test(r.key), 400, 'bad_rubric', 'key 需为 3—40 位小写字母/数字/下划线');
  check(typeof r.name === 'string' && r.name.trim(), 400, 'bad_rubric', '缺少 name');
  check(Array.isArray(r.scale) && r.scale.length === 2 && Number.isInteger(r.scale[0]) && Number.isInteger(r.scale[1]) && r.scale[0] < r.scale[1] && r.scale[1] - r.scale[0] <= 10, 400, 'bad_rubric', 'scale 需为 [最小, 最大] 整数');
  check(Array.isArray(r.dimensions) && r.dimensions.length >= 1 && r.dimensions.length <= 20, 400, 'bad_rubric', 'dimensions 需 1—20 项');
  const keys = new Set();
  for (const d of r.dimensions) {
    check(typeof d.key === 'string' && /^[a-z0-9_]{2,40}$/.test(d.key) && !keys.has(d.key), 400, 'bad_rubric', `维度 key 无效或重复：${d.key}`); keys.add(d.key);
    check(typeof d.label === 'string' && d.label.trim(), 400, 'bad_rubric', `维度 ${d.key} 缺少 label`);
    check(Array.isArray(d.anchors) && d.anchors.length === r.scale[1] - r.scale[0] + 1 && d.anchors.every((a) => typeof a === 'string'), 400, 'bad_rubric', `维度 ${d.key} 的锚点数量需与等级数一致`);
  }
  return { key: r.key, version: 0, name: r.name.trim().slice(0, 80), scale: r.scale, status: 'custom_not_validated', note: String(r.note || '自定义量规，未经效度验证').slice(0, 300),
    dimensions: r.dimensions.map((d) => ({ key: d.key, label: d.label.trim().slice(0, 30), anchors: d.anchors.map((a) => a.slice(0, 80)) })) };
}

// ---- template_versions: seeded built-ins; admin may publish new versions or retire ----
export function seedTemplates(db) {
  const put = (kind, key, name, body) => {
    const cur = one(db, 'SELECT * FROM template_versions WHERE kind=? AND key=? AND owner_id IS NULL AND version=1', kind, key);
    if (!cur) run(db, 'INSERT INTO template_versions(template_version_id,kind,key,version,name,body,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
      id('tpl'), kind, key, 1, name, JSON.stringify(body), 'published', now());
    // built-in v1 follows the code definition; admin-published versions (v2+) are never touched
    else if (!cur.created_by && (cur.name !== name || cur.body !== JSON.stringify(body))) run(db, 'UPDATE template_versions SET name=?, body=? WHERE template_version_id=?', name, JSON.stringify(body), cur.template_version_id);
  };
  tx(db, () => {
    for (const [k, f] of Object.entries(FRAMEWORKS)) put('framework', k, f.name, { ...f, reference_note: FRAMEWORK_NOTE });
    for (const [k, t] of Object.entries(ARTIFACT_TYPES)) put('artifact', k, t.name, t);
    put('rubric', RUBRIC_V1.key, RUBRIC_V1.name, RUBRIC_V1);
    if (!one(db, 'SELECT 1 FROM rubrics WHERE owner_id IS NULL AND key=?', RUBRIC_V1.key))
      run(db, 'INSERT INTO rubrics(rubric_id,owner_id,key,version,name,body,created_at) VALUES(?,?,?,?,?,?,?)', 'rubric_builtin_v1', null, RUBRIC_V1.key, 1, RUBRIC_V1.name, JSON.stringify(RUBRIC_V1), now());
  });
}

/** Latest published version of a template (framework/artifact). */
export function getTemplate(db, kind, key) {
  const r = one(db, "SELECT * FROM template_versions WHERE kind=? AND key=? AND status='published' AND owner_id IS NULL ORDER BY version DESC LIMIT 1", kind, key);
  return r ? { key, version: r.version, name: r.name, body: json(r.body), template_version_id: r.template_version_id } : null;
}
export function listTemplates(db, { includeRetired = false } = {}) {
  return all(db, `SELECT template_version_id, kind, key, version, name, status, created_at, body FROM template_versions WHERE owner_id IS NULL ${includeRetired ? '' : "AND status='published'"} ORDER BY kind, key, version`)
    .map((r) => ({ ...r, body: json(r.body) }));
}
export function publishTemplateVersion(db, admin, { kind, key, name, body }) {
  check(['framework', 'artifact', 'rubric'].includes(kind), 400, 'bad_kind', '无效模板类型');
  const prev = one(db, 'SELECT * FROM template_versions WHERE kind=? AND key=? AND owner_id IS NULL ORDER BY version DESC LIMIT 1', kind, key);
  check(prev, 404, 'not_found', '只能为已有模板发布新版本');
  check(body && typeof body === 'object', 400, 'bad_body', '模板内容必须是 JSON 对象');
  if (kind === 'framework') check(Array.isArray(body.steps) && body.steps.length >= 2 && body.steps.every((s) => Array.isArray(s) && s.length === 2), 400, 'bad_body', 'steps 需为 [[key,名称],…]');
  if (kind === 'artifact') check(Array.isArray(body.sections) && body.sections.every((s) => s.key && s.title && ['text', 'table'].includes(s.kind)), 400, 'bad_body', 'sections 结构无效');
  if (kind === 'rubric') validateRubric(body);
  return tx(db, () => {
    const tid = id('tpl'), version = prev.version + 1;
    run(db, 'INSERT INTO template_versions(template_version_id,kind,key,version,name,body,status,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)', tid, kind, key, version, String(name || prev.name).slice(0, 80), JSON.stringify(body), 'published', now(), admin.user_id);
    audit(db, { actor: admin, action: 'template_published', target_type: 'template', target_id: tid, detail: { kind, key, version } });
    return { template_version_id: tid, version };
  });
}
export function setTemplateStatus(db, admin, tid, status) {
  check(['published', 'retired'].includes(status), 400, 'bad_status', '无效状态');
  const r = one(db, 'SELECT * FROM template_versions WHERE template_version_id=?', tid);
  check(r, 404, 'not_found', '模板不存在');
  if (status === 'retired') check(one(db, "SELECT COUNT(*) n FROM template_versions WHERE kind=? AND key=? AND status='published' AND template_version_id<>?", r.kind, r.key, tid).n > 0, 400, 'last_version', '至少保留一个已发布版本');
  run(db, 'UPDATE template_versions SET status=? WHERE template_version_id=?', status, tid);
  audit(db, { actor: admin, action: `template_${status}`, target_type: 'template', target_id: tid });
}
