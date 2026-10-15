import { CONNECTIONS } from './metrics.js';

export function drawSkeleton(canvas, landmarks, width, height) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  context.strokeStyle = '#c5f087';
  context.fillStyle = '#f3ffc9';
  context.lineWidth = Math.max(2, width / 250);
  for (const [start, end] of CONNECTIONS) {
    const first = landmarks?.[start], last = landmarks?.[end];
    if (!first || !last || first.visibility < 0.6 || last.visibility < 0.6) continue;
    context.beginPath(); context.moveTo(first.x * width, first.y * height); context.lineTo(last.x * width, last.y * height); context.stroke();
  }
  for (const point of landmarks || []) {
    if (point.visibility < 0.6) continue;
    context.beginPath(); context.arc(point.x * width, point.y * height, Math.max(3, width / 170), 0, Math.PI * 2); context.fill();
  }
}

function eventOnce(element, name, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const complete = () => { clearTimeout(timer); element.removeEventListener(name, complete); element.removeEventListener('error', failed); resolve(); };
    const failed = () => { clearTimeout(timer); element.removeEventListener(name, complete); element.removeEventListener('error', failed); reject(new Error('视频无法解码，请转换为 H.264 MP4')); };
    const timer = setTimeout(failed, timeout);
    element.addEventListener(name, complete, { once: true });
    element.addEventListener('error', failed, { once: true });
  });
}

function privateFrame(video, landmarks, time) {
  const face = landmarks.slice(0, 11);
  if (face.length !== 11 || face.some((point) => point.visibility < 0.7)) return null;
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 768 / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const left = Math.min(...face.map((point) => point.x)) * canvas.width;
  const right = Math.max(...face.map((point) => point.x)) * canvas.width;
  const top = Math.min(...face.map((point) => point.y)) * canvas.height;
  const bottom = Math.max(...face.map((point) => point.y)) * canvas.height;
  const padding = Math.max(right - left, bottom - top, canvas.width * 0.06);
  context.fillStyle = '#182029';
  context.fillRect(left - padding, top - padding * 1.3, right - left + padding * 2, bottom - top + padding * 2.3);
  // Put the locally detected body skeleton on the consented cloud frame so the
  // vision model can cross-check visible posture against the numeric metrics.
  context.strokeStyle = '#b9f36a';
  context.fillStyle = '#f2ffd8';
  context.lineWidth = Math.max(2, canvas.width / 260);
  for (const [start, end] of CONNECTIONS) {
    const first = landmarks[start], last = landmarks[end];
    if (!first || !last || first.visibility < 0.6 || last.visibility < 0.6) continue;
    context.beginPath();
    context.moveTo(first.x * canvas.width, first.y * canvas.height);
    context.lineTo(last.x * canvas.width, last.y * canvas.height);
    context.stroke();
  }
  for (const index of [...new Set(CONNECTIONS.flat())]) {
    const point = landmarks[index];
    if (!point || point.visibility < 0.6) continue;
    context.beginPath();
    context.arc(point.x * canvas.width, point.y * canvas.height, Math.max(2, canvas.width / 220), 0, Math.PI * 2);
    context.fill();
  }
  return { time, data: canvas.toDataURL('image/jpeg', 0.75) };
}

export async function extractPose(file, { view, cloud, signal, onProgress }) {
  if (!file || file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20MB 的练习视频');
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  const source = URL.createObjectURL(file);
  let detector;
  const started = performance.now();
  try {
    const ready = eventOnce(video, 'loadeddata');
    video.src = source;
    await ready;
    if (video.duration === Infinity) {
      const durationReady = eventOnce(video, 'seeked');
      video.currentTime = 1e10;
      await durationReady;
    }
    if (!Number.isFinite(video.duration) || video.duration < 3 || video.duration > 30) throw new Error('首版支持 3–30 秒单动作片段');
    onProgress({ percent: 4, message: '加载本地姿态模型，首次约需数秒' });
    const { FilesetResolver, PoseLandmarker } = await import('/vendor/mediapipe/vision_bundle.mjs');
    const files = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
    detector = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: '/vendor/mediapipe/pose_landmarker_lite.task', delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 2, minPoseDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
    const frames = [], keyframes = [];
    const count = Math.floor(video.duration * 10);
    for (let index = 0; index < count; index++) {
      if (signal?.aborted) throw new Error('已取消处理，视频未继续上传');
      if (performance.now() - started > 90000) throw new Error('本机姿态处理超过 90 秒，请缩短片段或使用电脑');
      const time = 0.01 + index / 10;
      if (time >= video.duration) break;
      const seeked = eventOnce(video, 'seeked');
      video.currentTime = time;
      await seeked;
      const result = detector.detectForVideo(video, Math.round(time * 1000));
      const landmarks = result.landmarks?.length === 1 ? result.landmarks[0].map((point) => ({ x: point.x, y: point.y, visibility: point.visibility ?? 0 })) : [];
      frames.push({ time: Number(time.toFixed(3)), people: Math.min(2, result.landmarks?.length || 0), landmarks });
      if (cloud && landmarks.length && index % Math.max(1, Math.floor(count / 6)) === 0 && keyframes.length < 6) {
        const frame = privateFrame(video, landmarks, time);
        if (frame) keyframes.push(frame);
      }
      if (index % 3 === 0) {
        onProgress({ percent: Math.round(8 + index / count * 82), message: `正在提取骨架 · ${index + 1}/${count} 帧`, landmarks, time });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    return { pose: { width: video.videoWidth, height: video.videoHeight, view, frames }, keyframes };
  } catch (error) {
    if (/Failed to fetch|404|module/i.test(error.message)) throw new Error('姿态资源未就绪，请先运行 npm run setup:pose');
    throw error;
  } finally {
    detector?.close();
    video.removeAttribute('src'); video.load(); URL.revokeObjectURL(source);
  }
}
