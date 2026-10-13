export const METRIC_VERSION = 'pose-metrics-1';
export const METRIC_LABELS = {
  knee_left: '左膝夹角', knee_right: '右膝夹角', trunk_tilt: '躯干倾斜',
  shoulder_line: '肩线倾斜', pelvic_line: '骨盆侧倾代理', sway: '髋中点摆动',
};
export const CONNECTIONS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[28,30],[30,32]];

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const distance = (first, second) => Math.hypot(first.x - second.x, first.y - second.y);
const midpoint = (first, second) => ({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });
const pointOk = (point) => point && finite(point.x) && finite(point.y) && finite(point.visibility) && point.visibility >= 0.6;

export function angleDegrees(first, center, last) {
  const firstLength = distance(first, center), lastLength = distance(last, center);
  if (firstLength < 1e-6 || lastLength < 1e-6) return null;
  const cosine = ((first.x - center.x) * (last.x - center.x) + (first.y - center.y) * (last.y - center.y)) / (firstLength * lastLength);
  return Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI;
}

export function validatePose(payload) {
  if (!payload || !['front', 'side'].includes(payload.view)) throw new Error('请选择拍摄视角');
  if (!finite(payload.width) || !finite(payload.height) || payload.width < 16 || payload.height < 16 || payload.width > 8192 || payload.height > 8192) throw new Error('视频尺寸无效');
  if (!Array.isArray(payload.frames) || payload.frames.length < 3 || payload.frames.length > 900) throw new Error('需提供 3–900 帧姿态数据');
  let previous = -1;
  for (const frame of payload.frames) {
    if (!finite(frame.time) || frame.time < 0 || frame.time <= previous || frame.time > 60) throw new Error('帧时间须递增且在 60 秒内');
    previous = frame.time;
    if (!Number.isInteger(frame.people) || frame.people < 0 || frame.people > 2) throw new Error('人体数量无效');
    if (!Array.isArray(frame.landmarks) || ![0,33].includes(frame.landmarks.length)) throw new Error('每帧需有 33 个关键点或明确标记未检测到');
    for (const point of frame.landmarks) {
      if (!finite(point.x) || !finite(point.y) || Math.abs(point.x) > 5 || Math.abs(point.y) > 5 || !finite(point.visibility) || point.visibility < 0 || point.visibility > 1) throw new Error('关键点数值超出范围');
    }
  }
  return payload;
}

export function computeMetrics(raw) {
  const payload = validatePose(raw);
  const values = Object.fromEntries(Object.keys(METRIC_LABELS).map((name) => [name, []]));
  const hips = [];
  let validFrames = 0, multipleFrames = 0;
  const aspect = payload.width / payload.height;
  for (const frame of payload.frames) {
    if (frame.people > 1) multipleFrames++;
    if (frame.people !== 1 || frame.landmarks.length !== 33) continue;
    const points = frame.landmarks.map((point) => ({ ...point, x: point.x * aspect }));
    const allVisible = [11,12,23,24,25,26,27,28].every((index) => pointOk(points[index]));
    if (!allVisible) continue;
    const shoulder = midpoint(points[11], points[12]), hip = midpoint(points[23], points[24]);
    const torso = distance(shoulder, hip);
    if (torso < 0.025) continue;
    validFrames++;
    const append = (name, value) => { if (value !== null && finite(value)) values[name].push({ value, time: frame.time }); };
    append('knee_left', angleDegrees(points[23], points[25], points[27]));
    append('knee_right', angleDegrees(points[24], points[26], points[28]));
    append('trunk_tilt', Math.atan2(Math.abs(shoulder.x - hip.x), hip.y - shoulder.y) * 180 / Math.PI);
    if (payload.view === 'front') {
      append('shoulder_line', Math.atan2(Math.abs(points[11].y - points[12].y), Math.abs(points[11].x - points[12].x)) * 180 / Math.PI);
      append('pelvic_line', Math.atan2(Math.abs(points[23].y - points[24].y), Math.abs(points[23].x - points[24].x)) * 180 / Math.PI);
      hips.push({ x: hip.x, torso, time: frame.time });
    }
  }
  const coverage = validFrames / payload.frames.length;
  const flags = [];
  if (coverage < 0.8) flags.push('有效帧不足 80%，请调整机位或重拍');
  if (multipleFrames) flags.push('检测到多人或镜像，已排除相应帧');
  if (payload.frames.at(-1).time - payload.frames[0].time < 2) flags.push('有效视频不足 2 秒');
  if (hips.length >= 3) {
    const center = average(hips.map((hip) => hip.x));
    const deviation = Math.sqrt(average(hips.map((hip) => (hip.x - center) ** 2))) / average(hips.map((hip) => hip.torso));
    values.sway.push({ value: deviation, time: hips[0].time });
  }
  const reliable = coverage >= 0.8 && validFrames >= 10 && multipleFrames === 0 && flags.length === 0;
  const metrics = Object.fromEntries(Object.entries(values).map(([name, samples]) => {
    const readings = samples.map((sample) => sample.value);
    const available = readings.length > 0;
    return [name, {
      label: METRIC_LABELS[name], unit: name === 'sway' ? '躯干长度' : '°',
      value: available ? Number(average(readings).toFixed(3)) : null,
      min: available ? Number(Math.min(...readings).toFixed(3)) : null,
      max: available ? Number(Math.max(...readings).toFixed(3)) : null,
      frames_used: name === 'sway' ? hips.length : readings.length,
      uncertain: !reliable || !available,
      evidence: available ? { start: samples[0].time, end: name === 'sway' ? hips.at(-1).time : samples.at(-1).time } : null,
    }];
  }));
  return { version: METRIC_VERSION, view: payload.view, coverage, valid_frames: validFrames, total_frames: payload.frames.length, flags, reliable, metrics };
}
