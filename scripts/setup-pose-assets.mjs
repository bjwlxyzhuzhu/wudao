/**
 * 获取姿态识别所需的 MediaPipe 前端资产。
 *
 * 特性：
 *  - 幂等：已存在且校验和匹配时直接跳过，不重复下载。
 *  - 可离线：若 public/vendor/mediapipe/ 已由他人提供，加 --verify-only 只校验。
 *  - 可换源：通过环境变量覆盖下载地址，便于内网/镜像部署。
 *
 *   npm run setup:pose                     正常获取（缺失时才下载）
 *   npm run setup:pose -- --verify-only    只校验现有资产，不联网
 *   MEDIAPIPE_REGISTRY=... npm run setup:pose
 *   MEDIAPIPE_MODEL_URL=... npm run setup:pose
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const VERSION = '1.0.1';
const MODEL_SHA256 = '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a';
const REGISTRY = process.env.MEDIAPIPE_REGISTRY || 'https://registry.npmjs.org';
const MODEL_URL = process.env.MEDIAPIPE_MODEL_URL || 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const verifyOnly = process.argv.includes('--verify-only');
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = join(root, '.local', 'mediapipe');
const destination = join(root, 'public', 'vendor', 'mediapipe');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const bundlePath = join(destination, 'vision_bundle.mjs');
const modelPath = join(destination, 'pose_landmarker_lite.task');

async function fetchWithHint(url, label) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (e) {
    throw new Error(`无法访问 ${label}：${url}\n原因：${e.message}\n` +
      '若所在网络无法直连，请设置镜像地址后重试：\n' +
      '  MEDIAPIPE_REGISTRY / MEDIAPIPE_MODEL_URL\n' +
      '或从其他机器拷贝 public/vendor/mediapipe/ 后使用 --verify-only。');
  }
  if (!res.ok) throw new Error(`${label} 下载失败：HTTP ${res.status}（${url}）`);
  return Buffer.from(await res.arrayBuffer());
}

/** 已存在的资产是否完整可用。 */
async function existingOk() {
  if (!existsSync(bundlePath) || !existsSync(modelPath)) return false;
  try {
    const model = await readFile(modelPath);
    if (sha256(model) !== MODEL_SHA256) return { bad: '模型文件校验和不匹配' };
    const manifest = JSON.parse(await readFile(join(destination, 'asset-manifest.json'), 'utf8'));
    if (manifest.model_sha256 !== MODEL_SHA256) return { bad: 'asset-manifest.json 与预期模型不一致' };
    return true;
  } catch { return false; }
}

const state = await existingOk();

if (verifyOnly) {
  if (state === true) { console.log('姿态资产完整（离线校验通过）。'); process.exit(0); }
  console.error(`姿态资产校验失败：${typeof state === 'object' ? state.bad : '文件缺失'}。请运行 npm run setup:pose 获取。`);
  process.exit(1);
}

if (state === true) {
  console.log('姿态资产已存在且校验通过，跳过下载。');
  process.exit(0);
}

await mkdir(staging, { recursive: true });
await mkdir(destination, { recursive: true });

const metaUrl = `${REGISTRY}/@mediapipe/tasks-vision/${VERSION}`;
const metadata = JSON.parse((await fetchWithHint(metaUrl, 'npm 元数据')).toString('utf8'));
const tarballUrl = (metadata.dist?.tarball || '').replace('https://registry.npmjs.org', REGISTRY);
const archive = await fetchWithHint(tarballUrl, `@mediapipe/tasks-vision@${VERSION} 包`);
const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
if (integrity !== metadata.dist.integrity) throw new Error('包完整性校验失败（integrity mismatch）');

const archivePath = resolve(staging, 'tasks-vision.tgz');
await writeFile(archivePath, archive);
execFileSync('tar', ['-xzf', archivePath, '-C', destination, '--strip-components=1']);

// 若上游包未附带许可文件，从仓库根补齐，便于随包再分发。
if (!existsSync(join(destination, 'LICENSE'))) {
  const repoLicense = resolve(root, 'licenses', 'Apache-2.0.txt');
  if (existsSync(repoLicense)) {
    await writeFile(join(destination, 'LICENSE'), await readFile(repoLicense));
  }
}

const model = await fetchWithHint(MODEL_URL, 'Pose Landmarker 模型');
const modelHash = sha256(model);
if (modelHash !== MODEL_SHA256) throw new Error(`模型完整性校验失败：期望 ${MODEL_SHA256}，实际 ${modelHash}`);
await writeFile(modelPath, model);
await writeFile(join(destination, 'asset-manifest.json'), JSON.stringify({
  version: metadata.version, package_integrity: integrity, model_url: MODEL_URL, model_sha256: modelHash,
}, null, 2));

console.log(`MediaPipe ${metadata.version} 就绪；模型 ${model.length} 字节。资产由本机提供，运行时不访问外网。`);
