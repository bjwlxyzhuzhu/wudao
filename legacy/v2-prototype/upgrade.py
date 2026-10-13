from pathlib import Path
p=Path('core.js');s=p.read_text(encoding='utf-8')
start=s.index('function transferArtifact(');end=s.index('function validate(',start)
s=s[:start]+'''function transferArtifact(s,artifactId,target,confirmed){const a=s.artifacts.find(x=>x.artifact_id===artifactId);check(a,'请选择来源方案');check(['seminar','classroom'].includes(target)&&target!==a.scene,'请选择另一模块');check(confirmed===true,'请确认流转');const b=artifact(s,{scene:target,title:a.title+' · 导入版',content:a.content,parent_id:a.artifact_id});const t={transfer_id:id('transfer'),time:now(),from_run_id:null,from_scene:a.scene,to_scene:target,source_artifact_id:a.artifact_id,target_artifact_id:b.artifact_id,selected_event_ids:[],context_policy:'user_selected_artifact_copy',human_reviewed:true};s.transfers.push(t);audit(s,'module_import_export',t.transfer_id);return b;}
'''+s[end:]
s=s.replace("s.runs.some(r=>r.run_id===t.from_run_id)&&s.artifacts.some(a=>a.artifact_id===t.target_artifact_id)","(!t.from_run_id||s.runs.some(r=>r.run_id===t.from_run_id))&&s.artifacts.some(a=>a.artifact_id===t.target_artifact_id)")
start=s.index('const rubric=');end=s.index("files['rubric.csv']",start)
s=s[:start]+'''const rubric=[['values_alignment','思政融入','0无关联；1口号；2提及价值；3融入专业任务；4论证价值冲突与责任'],['disciplinary_accuracy','专业准确性','0错误；1关键错误；2基本正确；3准确完整；4明确边界'],['evidence_use','证据使用','0无依据；1断言；2引用材料；3证据对应结论；4区分事实与推断并追溯'],['question_quality','质疑质量','0无质疑；1泛泛提问；2指出问题；3指出缺口及理由；4提出可检验质疑'],['response_quality','回应质量','0未回应；1回避；2部分回应；3针对性举证；4回应并修正主张'],['collaboration','协作贡献','0无贡献；1重复；2完成分工；3整合观点；4跨专业整合并明确归属'],['reflection_revision','反思修订','0无反思；1表态；2提出修改；3依据证据修订；4保留修订依据与待查项']];
'''+s[end:]
start=s.index("files['rubric-guide.md']=");end=s.index("files['README.md']",start)
s=s[:start]+'''files['rubric-guide.md']='# 七维教学过程量规（草案）\\n\\n分级锚点见 rubric.csv。评分0—4，未评价保持空值。量规未经效度验证，不自动生成评分或评审一致性。需进行专家审查、预测试、评价者培训与独立复评。\\n\\n运行时长为设备墙钟经过时间，包含暂停；发言框停留时间不是学习时间，事件间隔不是思考时长。真实学习时间、音频发言时长、前后测、延迟测验、认知负荷均尚未采集，不能由模拟日志推断。\\n';
'''+s[end:]
s=s.replace("csv(x.ratings,['rating_id'","csv(x.ratings.map(r=>({...r,...r.rubric_scores})),['rating_id'")
p.write_text(s,encoding='utf-8')
p=Path('app.js');s=p.read_text(encoding='utf-8');pos=s.rfind('render();');s=s[:pos]+Path('revision-v3.js').read_text(encoding='utf-8')+'\n'+s[pos:];p.write_text(s,encoding='utf-8')
p=Path('index.html');s=p.read_text(encoding='utf-8').replace('<button data-page="lineage">↗ 流转记录</button>','');p.write_text(s,encoding='utf-8')
