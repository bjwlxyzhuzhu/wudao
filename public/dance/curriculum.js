export const PROJECT_NAME = '舞衡智护';
export const PROJECT_TITLE = '舞衡智护——高校古典芭蕾基础训练导学与训练生物力学风险预警智能体';
export const STANDARD_BASIS = '当前采用教师审核标准；教材名称、版本及章节尚未确定，不宣称已接入教材基准。';
export const BIOMECHANICS_BOUNDARY = '视频可辅助观察关节对位、运动轨迹及疑似代偿，不能直接测量肌肉发力、关节载荷或确定损伤。机制解释需教师复核，风险提示不等于医学诊断。';

// New identifiers deliberately do not reuse historical generic dance standards.
export const ACTIONS = [
  { key: 'ballet-demi-plie', title: 'Demi plié 半蹲', tag: '古典芭蕾基训 · 下肢协调', view: 'front',
    description: '观察半蹲与还原过程中的膝脚方向、足跟接触和躯干骨盆控制。',
    instructions: '教师需明确脚位、扶把方式、节拍与个体可完成幅度。在无痛范围内平稳半蹲与还原，不强求外开或深度。出现疼痛、失稳时停止并反馈教师。',
    checkpoints: ['膝盖运动方向与脚尖方向协调', '半蹲阶段足跟保持接触地面', '躯干与骨盆保持控制，下蹲还原连续'],
    safety: '观察足跟意外抬起、膝部内移或躯干明显前倾等线索，结合拍摄视角复核；不能仅凭角度推断具体肌群无力。' },
  { key: 'ballet-grand-plie', title: 'Grand plié 大蹲', tag: '古典芭蕾基训 · 深屈伸控制', view: 'front',
    description: '观察大蹲与还原的连续性、膝踝对位和骨盆控制，足跟要求按脚位区分。',
    instructions: '教师需明确脚位、扶把方式及足跟起落要求。第二位通常保持足跟接地；其他脚位依教师规范控制足跟起落，不套用半蹲全程足跟贴地的要求。不追求极限深度，疼痛时停止。',
    checkpoints: ['膝盖与脚尖方向协调，不强迫外开', '按指定脚位完成足跟起落或保持接地', '下蹲与还原连续，躯干骨盆保持控制'],
    safety: '结合脚位观察膝部偏移、骨盆失控或快速坠落，不能将必要的足跟起落判为错误，也不能由视频计算关节异常载荷。' },
  { key: 'ballet-tendu', title: 'Battement tendu 擦地', tag: '古典芭蕾基训 · 足腿衔接', view: 'front',
    description: '观察动作腿擦出与收回轨迹、足部衔接和支撑侧稳定。',
    instructions: '教师需明确准备脚位、擦地方向、扶把方式及节拍。按要求完成足部与地面的衔接，动作腿延伸与收回时保持支撑侧控制，避免以骨盆摆动追求幅度。',
    checkpoints: ['动作腿按指定方向擦出并收回', '足部接触与延伸过程连贯', '支撑侧稳定，躯干与骨盆无明显随动偏移'],
    safety: '观察骨盆抬高、转动或支撑膝失控等疑似代偿，先核对动作要求与视角，不把所有位移都判为错误。' },
  { key: 'ballet-adagio', title: 'Adagio 控制组合', tag: '古典芭蕾基训 · 慢速控制', view: 'side',
    description: '由教师定义具体控制组合，观察支撑稳定、抬腿保持及躯干骨盆协调。',
    instructions: 'Adagio是慢速控制组合而非固定单动作。教师需填写动作顺序、方向、幅度、保持时长和扶把方式，并上传相应示范；不使用统一角度要求评价不同组合，不以抬腿高度替代控制质量。',
    checkpoints: ['按教师指定顺序和方向完成组合', '抬腿与保持阶段支撑侧保持控制', '躯干骨盆协调，转换连续且无明显失稳'],
    safety: '观察过度躯干侧倾、骨盆随动及失稳线索。需先区分组合允许的动作与非预期代偿，不能据此定位肌肉发力或预测损伤概率。' },
];
