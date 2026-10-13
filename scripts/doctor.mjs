/**
 * 交付前/安装后自检。
 *
 *   npm run doctor
 *
 * 逐项检查运行环境、目录权限、许可文件、姿态资产与测试可用性，
 * 用中文给出「可以交付 / 需要处理」的明确结论。
 * 本脚本只读：不修改任何文件、不联网。
 */
import { existsSync, readFileSync, statSync, accessSync, constants, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const results = [];
const ok = (name, detail) => results.push({ level: 'ok', name, detail });
const warn = (name, detail) => results.push({ level: 'warn', name, detail, hint: true });
const bad = (name, detail) => results.push({ level: 'bad', name, detail, hint: true });

// ---------- 1. Node 版本 ----------
const required = [22, 13, 0];
const current = process.versions.node.split('.').map(Number);
if (current[0] > required[0] || (current[0] === required[0] && current[1] >= required[1])) {
  ok('Node 版本', `v${process.versions.node}`);
} else {
  bad('Node 版本', `当前 v${process.versions.node}，需要 ≥ v22.13.0。本项目使用内置 node:sqlite，低版本无法启动。`);
}

// ---------- 2. 关键文件 ----------
const requiredFiles = ['server/server.js', 'server/dance/service.js', 'public/index.html', 'public/dance/index.html', 'package.json'];
const missingFiles = requiredFiles.filter((f) => !existsSync(join(root, f)));
if (!missingFiles.length) ok('程序文件', `${requiredFiles.length} 个关键文件齐全`);
else bad('程序文件', `缺失：${missingFiles.join('、')}。源码包不完整，请重新解压。`);

// ---------- 3. 许可与声明 ----------
const legal = { LICENSE: '项目许可', NOTICE: '第三方声明', 'licenses/Apache-2.0.txt': 'Apache-2.0 全文' };
const missingLegal = Object.entries(legal).filter(([f]) => !existsSync(join(root, f))).map(([f, n]) => `${f}（${n}）`);
if (!missingLegal.length) ok('许可文件', 'LICENSE / NOTICE / Apache-2.0 全文齐全，可再分发');
else bad('许可文件', `缺失：${missingLegal.join('、')}。缺少声明即对外分发会造成许可不合规。`);

// ---------- 4. 数据目录可写 ----------
const dataDir = resolve(root, process.env.YANZHI_DATA_DIR || 'data');
try {
  if (existsSync(dataDir)) { accessSync(dataDir, constants.W_OK); ok('数据目录', `${dataDir} 可写`); }
  else { accessSync(resolve(root), constants.W_OK); ok('数据目录', `${dataDir} 尚未创建（首次启动时自动建立）`); }
} catch (e) {
  bad('数据目录', `${dataDir} 不可写：${e.code}。数据库与密钥无法写入，启动会失败。`);
}

// ---------- 5. 端口占用提示（仅检查配置合法性）----------
const port = Number(process.env.PORT || 8787);
if (Number.isInteger(port) && port >= 1 && port <= 65535) ok('端口配置', `PORT=${port}`);
else bad('端口配置', `PORT 必须是 1—65535 的整数，当前为 ${JSON.stringify(process.env.PORT)}。`);

// ---------- 6. 姿态资产 ----------
const poseDir = join(root, 'public', 'vendor', 'mediapipe');
const MODEL_SHA256 = '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a';
if (!existsSync(join(poseDir, 'vision_bundle.mjs')) || !existsSync(join(poseDir, 'pose_landmarker_lite.task'))) {
  warn('姿态识别资产', '未安装。舞蹈相关页面无法工作。运行 npm run setup:pose 获取（需联网）。');
} else {
  let hashOk = false;
  try {
    const { createHash } = await import('node:crypto');
    hashOk = createHash('sha256').update(readFileSync(join(poseDir, 'pose_landmarker_lite.task'))).digest('hex') === MODEL_SHA256;
  } catch { /* ignore */ }
  if (hashOk) ok('姿态识别资产', '已安装且模型校验和匹配');
  else warn('姿态识别资产', '已安装但模型校验和不匹配，可能被替换或损坏。运行 npm run verify:pose 确认。');
  if (!existsSync(join(poseDir, 'LICENSE'))) bad('姿态资产许可', 'public/vendor/mediapipe/LICENSE 缺失，再分发不合规。');
}

// ---------- 7. 测试文件 ----------
const testsDir = join(root, 'tests');
try {
  const n = readdirSync(testsDir).filter((f) => f.endsWith('.test.js')).length;
  ok('测试套件', `${n} 个测试文件，运行 npm test 执行`);
} catch { bad('测试套件', 'tests/ 目录缺失，无法自证功能可用。'); }

// ---------- 8. 环境变量提醒 ----------
if (!process.env.YANZHI_MASTER_KEY) {
  warn('主密钥', '未设置 YANZHI_MASTER_KEY，将在数据目录自动生成 master.key。备份/迁移时请连同该文件一起保留，否则已保存的模型 API Key 无法解密。');
} else ok('主密钥', '已通过环境变量提供');
if (process.env.YANZHI_SECURE_COOKIE !== '1') {
  warn('Cookie 安全标志', 'YANZHI_SECURE_COOKIE 未设为 1。若部署在 HTTPS 域名下，请设为 1。');
}

// ---------- 输出 ----------
const icon = { ok: '✓', warn: '!', bad: '✗' };
console.log('\n研思智境 / 舞安智护 —— 交付自检\n' + '─'.repeat(46));
for (const r of results) console.log(`${icon[r.level]} ${r.name}：${r.detail}`);
const bads = results.filter((r) => r.level === 'bad').length;
const warns = results.filter((r) => r.level === 'warn').length;
console.log('─'.repeat(46));
console.log(bads ? `结论：${bads} 项需要处理，${warns} 项提醒。处理后重新运行 npm run doctor。`
  : warns ? `结论：可以交付。${warns} 项提醒可在部署时确认。`
    : '结论：全部通过，可以直接交付。');
console.log('');
process.exit(bads ? 1 : 0);
