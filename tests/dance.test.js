import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createUser } from '../server/auth.js';
import { ACTIONS, addProfile } from '../server/dance/service.js';
import { analyzeTraining, validateCompliance, validateFindings } from '../server/dance/analysis.js';
import { angleDegrees, computeMetrics, validatePose } from '../public/dance/metrics.js';
import { startApp, client, configureModel, seedUsers } from './helpers.js';

function pose(overrides = {}) {
  const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.1, visibility: 0.99 }));
  for (const [index,horizontal,vertical] of [[11,.4,.25],[12,.6,.25],[23,.4,.5],[24,.6,.5],[25,.4,.7],[26,.6,.7],[27,.4,.9],[28,.6,.9]]) landmarks[index] = { x: horizontal, y: vertical, visibility: .99 };
  return { width: 1280, height: 720, view: 'front', frames: Array.from({ length: 30 }, (_, index) => ({ time: index / 10, people: 1, landmarks: structuredClone(landmarks) })), ...overrides };
}

let app, teacher, student, peer, outsider, medic, standard, admin;
before(async () => {
  app = await startApp();
  seedUsers(app.db);
  admin = client(app.base); await admin.login('root_admin','Admin12345',true);
  const create = async (login, role, cohort = 'dance-class') => {
    const user = createUser(app.db, { login, password: 'DanceTest123', is_teacher: false, must_change_password: false });
    addProfile(app.db, user.user_id, role, cohort);
    const connection = client(app.base);
    assert.equal((await connection.post('/api/dance/auth/login', { login, password: 'DanceTest123' })).status, 200);
    return connection;
  };
  teacher = await create('dance_test_teacher','teacher');
  student = await create('dance_test_student','student');
  peer = await create('dance_test_peer','student');
  outsider = await create('dance_test_outside','teacher','other-class');
  medic = await create('dance_test_medic','medic');
  const result = await teacher.post('/api/dance/standards', { action_key: 'ballet-demi-plie', title: '测试动作标准', view: 'front', instructions: '仅测试用，不作为真实教学标准', checkpoints: ['按要求完成短片段'], confirm: true });
  assert.equal(result.status, 200);
  standard = result.data.standard_id;
});
after(async () => { await app.stop(); });

const createTraining = async (connection = student, extra = {}) => {
  const response = await connection.post('/api/dance/sessions', { standard_id: standard, consent_teaching: true, idempotency_key: crypto.randomUUID(), ...extra });
  assert.equal(response.status, 200);
  return response.data;
};
const analyze = async (training) => {
  assert.equal((await student.post(`/api/dance/sessions/${training.training_id}/pose`, pose())).status,200);
  assert.equal((await student.post(`/api/dance/sessions/${training.training_id}/analyze`,{})).status,200);
  for (let attempt=0;attempt<30;attempt++) {
    const response=await student.get(`/api/dance/sessions/${training.training_id}`);
    if(response.data.status!=='AI_PROCESSING')return response.data;
    await new Promise((resolve)=>setTimeout(resolve,10));
  }
  throw new Error('Analysis did not finish');
};

test('古典芭蕾动作库为四项，采用独立标识，不复用历史标准', () => {
  assert.deepEqual(ACTIONS.map(action => action.key), ['ballet-demi-plie', 'ballet-grand-plie', 'ballet-tendu', 'ballet-adagio']);
  assert.deepEqual(ACTIONS.map(action => action.title), ['Demi plié 半蹲', 'Grand plié 大蹲', 'Battement tendu 擦地', 'Adagio 控制组合']);
  assert.match(ACTIONS[1].instructions, /第二位/);
  assert.match(ACTIONS[3].instructions, /组合而非固定单动作/);
});

test('教师示范视频只保存可靠参考指标，新版本沿用同视角数据', async () => {
  const teacherFrame={time:1,data:'data:image/jpeg;base64,/9j/AA=='};
  const first = await teacher.post('/api/dance/standards', { action_key: 'ballet-tendu', title: 'Tendu 参考标准', view: 'front', instructions: '仅用于测试', checkpoints: ['检查腿部控制'], confirm: true, reference_pose: pose(), reference_keyframes:[teacherFrame] });
  assert.equal(first.status, 200);
  assert.equal(first.data.reference_metrics.reliable, true);
  const catalog = await student.get('/api/dance/catalog');
  const standard = catalog.data.actions.find((item) => item.key === 'ballet-tendu').standard;
  assert.equal(standard.reference_metrics.metrics.knee_left.value, 180);
  assert.equal(standard.reference_frame_count,1);
  assert.equal(standard.reference_metrics_json, undefined);
  assert.equal(standard.reference_keyframes_json, undefined);
  assert.deepEqual(JSON.parse(app.db.prepare('SELECT reference_keyframes_json FROM dance_standards WHERE standard_id=?').get(first.data.standard_id).reference_keyframes_json),[teacherFrame]);
  const next = await teacher.post('/api/dance/standards', { action_key: 'ballet-tendu', title: 'Tendu 新版标准', view: 'front', instructions: '更新要求', checkpoints: ['检查腿部控制'], confirm: true });
  assert.equal(next.data.version, 2);
  assert.equal(next.data.reference_metrics.metrics.knee_left.value, 180);
  assert.deepEqual(JSON.parse(app.db.prepare('SELECT reference_keyframes_json FROM dance_standards WHERE standard_id=?').get(next.data.standard_id).reference_keyframes_json),[teacherFrame]);
  assert.equal((await teacher.post('/api/dance/standards', { action_key: 'ballet-grand-plie', title: '视角不匹配', view: 'side', instructions: '测试', checkpoints: ['测试'], confirm: true, reference_pose: pose() })).status, 400);
  const poor = pose(); poor.frames.forEach((frame) => { frame.people = 0; frame.landmarks = []; });
  assert.equal((await teacher.post('/api/dance/standards', { action_key: 'ballet-adagio', title: '质量不足', view: 'front', instructions: '测试', checkpoints: ['测试'], confirm: true, reference_pose: poor })).status, 400);
  assert.equal((await student.post('/api/dance/standards', { action_key: 'ballet-adagio', title: '越权', view: 'front', instructions: '测试', checkpoints: ['测试'], confirm: true })).status, 403);
});

test('舞蹈指标：已知角度、宽高比、缺失值、零分母与多人质量门槛', () => {
  assert.equal(angleDegrees({x:0,y:0},{x:0,y:1},{x:1,y:1}),90);
  assert.equal(angleDegrees({x:0,y:0},{x:0,y:0},{x:1,y:1}),null);
  const result=computeMetrics(pose());
  assert.equal(result.reliable,true);
  assert.equal(result.metrics.knee_left.value,180);
  assert.equal(result.metrics.trunk_tilt.value,0);
  const angled=pose();
  angled.frames.forEach((frame)=>{frame.landmarks[25].x=.5;});
  const normalizedAngle=angleDegrees(angled.frames[0].landmarks[23],angled.frames[0].landmarks[25],angled.frames[0].landmarks[27]);
  assert.notEqual(computeMetrics(angled).metrics.knee_left.value,Number(normalizedAngle.toFixed(3)));
  const occluded=pose();occluded.frames.forEach((frame)=>{frame.landmarks[25].visibility=.1;});
  assert.equal(computeMetrics(occluded).metrics.knee_left.value,null);
  const multiple=pose();multiple.frames[0].people=2;
  assert.equal(computeMetrics(multiple).reliable,true);
  const occasionalFalseDetection=pose({frames:Array.from({length:203},(_,index)=>({time:index/10,people:index<3?2:1,landmarks:structuredClone(pose().frames[0].landmarks)}))});
  const tolerant=computeMetrics(occasionalFalseDetection);
  assert.equal(tolerant.reliable,true);
  assert.equal(tolerant.valid_frames,200);
  assert.equal(tolerant.excluded_candidate_frames,3);
  assert.doesNotMatch(tolerant.flags.join(' '),/多人|镜像/);
  const persistentMultiple=pose();persistentMultiple.frames.slice(0,6).forEach((frame)=>{frame.people=2;});
  const persistent=computeMetrics(persistentMultiple);
  assert.equal(persistent.reliable,false);
  assert.match(persistent.flags.join(' '),/多个候选/);
  const coverageAt76=pose();coverageAt76.frames.slice(0,7).forEach((frame)=>{frame.people=0;frame.landmarks=[];});
  const acceptedCoverage=computeMetrics(coverageAt76);
  assert.equal(acceptedCoverage.reliable,true);
  assert.equal(acceptedCoverage.coverage,23/30);
  const coverageBelow70=pose();coverageBelow70.frames.slice(0,10).forEach((frame)=>{frame.people=0;frame.landmarks=[];});
  const rejectedCoverage=computeMetrics(coverageBelow70);
  assert.equal(rejectedCoverage.reliable,false);
  assert.match(rejectedCoverage.flags.join(' '),/不足 70%/);
  const withinTolerance=pose();withinTolerance.frames.slice(0,3).forEach((frame)=>{frame.people=2;});
  assert.equal(computeMetrics(withinTolerance).reliable,true);
  const beyondTolerance=pose();beyondTolerance.frames.slice(0,4).forEach((frame)=>{frame.people=2;});
  assert.equal(computeMetrics(beyondTolerance).reliable,false);
  const longClip=pose();longClip.frames.at(-1).time=89.9;
  assert.equal(validatePose(longClip).frames.at(-1).time,89.9);
  const side=computeMetrics(pose({view:'side'}));assert.equal(side.metrics.shoulder_line.value,null);
});

test('舞蹈输入：不接受乱序时间、非法点与未授权数据',async()=>{
  const invalid=pose();invalid.frames[1].time=0;assert.throws(()=>validatePose(invalid),/递增/);
  const unknown=pose();unknown.frames[0].landmarks[1].x=Infinity;assert.throws(()=>validatePose(unknown),/范围/);
  assert.equal((await student.post('/api/dance/sessions',{standard_id:standard,idempotency_key:'no-consent'})).status,400);
  assert.equal((await student.post('/api/dance/standards',{})).status,403);
  assert.equal((await teacher.post('/api/dance/sessions',{})).status,403);
});

test('舞蹈权限：学生互不可见、跨班教师不可见、原教研权限不被扩展',async()=>{
  const training=await createTraining();
  assert.equal((await peer.get(`/api/dance/sessions/${training.training_id}`)).status,404);
  assert.equal((await outsider.get(`/api/dance/sessions/${training.training_id}`)).status,404);
  assert.equal((await teacher.get(`/api/dance/sessions/${training.training_id}`)).status,200);
  assert.equal((await medic.get(`/api/dance/sessions/${training.training_id}`)).status,404);
  assert.equal((await student.get('/api/me')).status,401);
  const unknown=client(app.base);
  assert.equal((await unknown.get('/api/dance/catalog')).status,401);
});

test('练习创建幂等，标准更新不改历史快照',async()=>{
  const requestKey=crypto.randomUUID();
  const first=await createTraining(student,{idempotency_key:requestKey});
  const repeat=await createTraining(student,{idempotency_key:requestKey});
  assert.equal(first.training_id,repeat.training_id);
  assert.equal((await student.post('/api/dance/sessions',{standard_id:standard,idempotency_key:requestKey,consent_teaching:true,consent_cloud:true})).status,409);
  const next=await teacher.post('/api/dance/standards',{action_key:'ballet-demi-plie',title:'新标准',view:'front',instructions:'第二版测试',checkpoints:['新检查点'],confirm:true});
  assert.equal(next.data.version,2);
  assert.equal((await student.get(`/api/dance/sessions/${first.training_id}`)).data.standard.version,1);
});

test('完整闭环：有效姿态→仅指标降级→教师复核→版本冲突→学生查看',async()=>{
  const training=await analyze(await createTraining());
  assert.equal(training.status,'WAITING_REVIEW');
  assert.equal(training.analysis.mode,'metrics_only');
  assert.equal(training.analysis.observations,undefined);
  assert.equal((await student.post(`/api/dance/sessions/${training.training_id}/reviews`,{})).status,403);
  const feedback={decision:'modify',strengths:['测试优点'],priorities:['测试改进'],next_drill:'测试用下一轮提示',expected_version:0};
  assert.equal((await teacher.post(`/api/dance/sessions/${training.training_id}/reviews`,feedback)).data.status,'PUBLISHED');
  assert.equal((await teacher.post(`/api/dance/sessions/${training.training_id}/reviews`,feedback)).status,409);
  const report=(await student.get(`/api/dance/sessions/${training.training_id}`)).data;
  assert.deepEqual(report.feedback[0].priorities,['测试改进']);
  assert.equal((await student.post(`/api/dance/sessions/${training.training_id}/pose`,pose())).status,409);
});

test('质量不足不能分析；姿态视角必须匹配标准',async()=>{
  const training=await createTraining();
  assert.equal((await student.post(`/api/dance/sessions/${training.training_id}/pose`,pose({view:'side'}))).status,400);
  const missing=pose();missing.frames.forEach((frame)=>{frame.people=0;frame.landmarks=[];});
  const result=await student.post(`/api/dance/sessions/${training.training_id}/pose`,missing);
  assert.equal(result.data.status,'NEEDS_RECAPTURE');
  assert.equal((await student.post(`/api/dance/sessions/${training.training_id}/analyze`,{})).status,409);
  const recovered=pose();recovered.frames.slice(0,3).forEach((frame)=>{frame.people=2;});
  const recalculated=await student.post(`/api/dance/sessions/${training.training_id}/pose`,recovered);
  assert.equal(recalculated.data.status,'METRICS_READY');
  assert.equal(recalculated.data.metrics.version,'pose-metrics-4');
  assert.equal(recalculated.data.metrics.excluded_candidate_frames,3);
});

test('媒体与关键帧：分别授权、校验格式、支持范围读取、撤回后拒绝访问',async()=>{
  const noVideo=await createTraining();
  assert.equal((await student.post(`/api/dance/sessions/${noVideo.training_id}/video`,{})).status,403);
  await student.post(`/api/dance/sessions/${noVideo.training_id}/pose`,pose());
  assert.equal((await student.post(`/api/dance/sessions/${noVideo.training_id}/analyze`,{keyframes:[{time:0,data:'data:image/jpeg;base64,/9j/AA=='}]})).status,403);
  const training=await createTraining(student,{consent_video:true});
  const bytes=Buffer.alloc(21*1024*1024);
  Buffer.from('00000018667479706d703432000000006d70343269736f6d','hex').copy(bytes);
  const upload=await student.req('POST',`/api/dance/sessions/${training.training_id}/video`,bytes,{'content-type':'video/mp4'});
  assert.equal(upload.status,200);
  const media=await teacher.req('GET',upload.data.video_url,undefined,{range:'bytes=4-7'});
  assert.equal(media.status,206);assert.equal(media.data.toString(),'ftyp');
  assert.equal((await peer.get(upload.data.video_url)).status,404);
  await student.post(`/api/dance/sessions/${training.training_id}/withdraw`);
  assert.equal((await teacher.get(upload.data.video_url)).status,404);
  const withdrawn=(await student.get(`/api/dance/sessions/${training.training_id}`)).data;
  assert.equal(withdrawn.metrics,null);assert.equal(withdrawn.status,'WITHDRAWN');
});

test('健康记录：明确同意、按职责隔离、负荷幂等、未配置不显示绿色',async()=>{
  const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  assert.equal((await student.post('/api/dance/checkins',{date:today})).status,400);
  const response=await student.post('/api/dance/checkins',{date:today,fatigue:3,sleep_hours:7.5,pain:1,areas:['测试部位'],consent_health:true});
  assert.equal(response.status,200);assert.equal(response.data.risk.level,'unassessed');
  assert.equal((await teacher.get('/api/dance/health')).status,403);
  assert.equal((await peer.get('/api/dance/health')).data.checkins.length,0);
  assert.equal((await medic.get('/api/dance/health')).data.checkins.length,1);
  const load={date:today,minutes:20,rpe:3,idempotency_key:'test-load-001',consent_health:true};
  await student.post('/api/dance/loads',load);
  const result=await student.post('/api/dance/loads',load);
  assert.equal(result.data.loads.length,1);assert.equal(result.data.loads[0].load,60);
  assert.equal((await student.post('/api/dance/loads',{...load,minutes:30})).status,409);
  await student.post('/api/dance/health/withdraw');
  assert.equal((await medic.get('/api/dance/health')).data.checkins.length,0);
});

test('多模态契约：图片内容块、五次实际调用、证据校验与失败降级',async()=>{
  const requests=[];
  const provider=createServer((request,response)=>{
    let raw='';request.on('data',(chunk)=>{raw+=chunk;});request.on('end',()=>{
      const body=JSON.parse(raw);requests.push(body);
      const system=body.messages[0].content;
      const answer=system.includes('证据仲裁')?{selected_ids:['a_basic:1'],compliance:{status:'needs_correction',summary:'躯干角度需要教师复核',evidence:['metric:trunk_tilt']}}:{findings:[{text:'测试观察',evidence:['metric:trunk_tilt'],uncertain:false}]};
      response.writeHead(200,{'content-type':'text/event-stream'});
      response.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(answer)}}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve)=>provider.listen(0,'127.0.0.1',resolve));
  const previous=process.env.DANCE_VISION_PROVIDER_ID;
  try{
    delete process.env.DANCE_VISION_PROVIDER_ID;
    await configureModel(admin,`http://127.0.0.1:${provider.address().port}/v1`,{name:'千问视觉（舞镜智练）'});
    const referenceMetrics=computeMetrics(pose());
    const teacherFrame={time:1,data:'data:image/jpeg;base64,/9j/AA=='};
    app.db.prepare('UPDATE dance_standards SET reference_metrics_json=?,reference_keyframes_json=? WHERE standard_id=?').run(JSON.stringify(referenceMetrics),JSON.stringify([teacherFrame]),standard);
    const standardRow=app.db.prepare('SELECT * FROM dance_standards WHERE standard_id=?').get(standard);
    const result=await analyzeTraining(app.db,{standard:standardRow,metrics:computeMetrics(pose()),keyframes:[{time:0,data:'data:image/jpeg;base64,/9j/AA=='}],consentCloud:true});
    assert.equal(result.mode,'multimodal');assert.equal(requests.length,5);
    assert.equal(requests[0].messages[1].content[2].type,'image_url');
    assert.equal(requests[0].messages[1].content[4].type,'image_url');
    const context=JSON.parse(requests[0].messages[1].content[0].text);
    assert.equal(context.curriculum_context.action, 'Demi plié 半蹲');
    assert.match(context.standard_basis, /教材名称、版本及章节尚未确定/);
    assert.match(context.biomechanics_boundary, /不能直接测量肌肉发力、关节载荷/);
    assert.match(requests[2].messages[0].content, /uncertain必须为true/);
    assert.deepEqual(context.teacher_reference_metrics,referenceMetrics);
    assert.equal(context.teacher_demonstration_frames,1);
    assert.ok(context.available_evidence.includes('reference:knee_left'));
    assert.ok(context.available_evidence.includes('standard_frame:1'));
    assert.equal(requests[0].messages[1].content[1].text,'standard_frame:1 教师示范关键帧，时间 1 秒');
    assert.equal((await student.get('/api/dance/catalog')).data.vision_configured,true);
    const noConsent=await analyzeTraining(app.db,{standard:standardRow,metrics:computeMetrics(pose()),keyframes:[{time:0,data:'data:image/jpeg;base64,/9j/AA=='}],consentCloud:false});
    assert.equal(noConsent.mode,'metrics_only');
    assert.match(noConsent.message,/未授权/);
    assert.equal(requests.length,5);
    assert.equal(result.selected[0].id,'a_basic:1');
    assert.equal(result.compliance.status,'needs_correction');
    assert.throws(()=>validateFindings({findings:[{text:'不存在的证据',evidence:['metric:imaginary'],uncertain:false}]},new Set(['metric:trunk_tilt'])),/evidence/);
    assert.throws(()=>validateCompliance({status:'appears_compliant',summary:'看起来符合',evidence:[]},new Set(['metric:trunk_tilt'])),/compliance/);
  }finally{if(previous===undefined)delete process.env.DANCE_VISION_PROVIDER_ID;else process.env.DANCE_VISION_PROVIDER_ID=previous;await new Promise((resolve)=>provider.close(resolve));}
});
