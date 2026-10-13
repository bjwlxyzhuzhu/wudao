// 品牌版本：同一套程序以不同名称运行（启动时设置环境变量 YANZHI_BRAND）。
// 默认品牌为“研思智境”；YANZHI_BRAND=szsx 时为参赛版“演知思政——基于Agents协同与对抗的虚拟教研实训工场”。
// 替换只作用于界面文字、页面标题、Logo 与数字客服的回答，不改变任何功能与数据。
export const BRANDS = {
  szsx: {
    key: 'szsx', name: '演知思政', slogan: '基于Agents协同与对抗的虚拟教研实训工场',
    en: 'Agents Collaboration & Confrontation · Virtual Teaching-Research Studio',
  },
};
export const BRAND = BRANDS[process.env.YANZHI_BRAND] || null;

const PAIRS = BRAND ? [
  ['研思智境（原“研思智境”）', BRAND.name],
  ['“研—演—评—改”多智能体数字教研实验工坊', BRAND.slogan],
  ['Research · Simulation · Evaluation · Improvement', BRAND.en],
  ['Research · Reflection · Simulation · Improvement · Multi-Agent Teaching Research Intelligence', BRAND.en],
  ['研思智境', BRAND.name],
] : [];
/** 把默认品牌名称替换为当前品牌名称（默认品牌下原样返回）。 */
export const brandText = (s) => (BRAND && typeof s === 'string' ? PAIRS.reduce((t, [a, b]) => t.split(a).join(b), s) : s);
/** 品牌专属图片（Logo 等）：public/img/brand/<key>/<文件名>，不存在时回退到默认图片。 */
export const brandImage = (name) => (BRAND ? `img/brand/${BRAND.key}/${name}` : null);
