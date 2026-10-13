from pathlib import Path
p=Path('app.js');s=p.read_text(encoding='utf-8')
s=s.replace("(r?.interaction_mode||modeChoice)===id", "(r?.status==='running'?r.interaction_mode:modeChoice)===id")
s=s.replace("const r=ensureRun(scene);if(r.demo_step", "const r=ensureRun(scene);if(r.demo_step")
s=s.replace("group='G'+(Math.floor(k/4)%r.group_count+1)", "group='G'+((r.interaction_mode==='group_debate'?k:Math.floor(k/4))%r.group_count+1)")
# Keep scene heading and participant identity truthful; old internals remain for compatibility.
s=s.replace("return scenePrevious(scene,scene==='seminar'?'教学研讨':title).replace", "return scenePrevious(scene,scene==='seminar'?'教学研讨':title).replace")
# Preserve historical viewport while not following live subtitles.
s=s.replace("render=function(){initialRender();bindDashboard();};", "render=function(){const oldScroll=document.getElementById('live-feed')?.scrollTop;initialRender();bindDashboard();if(!followLive&&oldScroll!==undefined){const f=document.getElementById('live-feed');if(f)f.scrollTop=oldScroll}};")
p.write_text(s,encoding='utf-8')
p=Path('core.js');s=p.read_text(encoding='utf-8')
s=s.replace("for(const r of x.ratings)r.rater_code=alias(r.rater_code);", "for(const r of x.ratings)r.rater_code=alias(r.rater_code);for(const e of x.events)if(e.target_actor&&map.has(e.target_actor))e.target_actor=map.get(e.target_actor);")
needle="files['rubric-guide.md']="
pos=s.index(needle)
dictionary="""files['process-dictionary.md']='# 过程数据字段说明\\n\\n| 字段 | 含义与边界 |\\n|---|---|\\n| started_at / ended_at | 本地设备时间，UTC ISO 格式 |\\n| duration_ms | 完成运行的墙钟时间，包含暂停；运行中为空 |\\n| elapsed_ms | 事件距开始经过的毫秒数 |\\n| interval_from_prev_ms | 同运行相邻事件间隔，不是思考时间 |\\n| response_latency_ms | 回复与 reply_to 事件的时间差 |\\n| input_duration_ms | 打开发言框至提交的停留时间，不是主动学习时间 |\\n| reply_to / target_actor | 被回复事件与目标身份；未指定时为空 |\\n| interaction_mode / group_id / task_role | 冻结运行模式、发言组别、当前任务分工 |\\n| data_provenance | 脚本、真人模拟输入或未经验证观察 |\\n| rubric_scores | 七维人工0—4等级，未评分为空 |\\n| source_artifact_id / target_artifact_id | 模块流转前后的方案版本ID |\\n\\n真实学生学习时长、离屏停留、认知投入、语音时长、前测/后测与延迟保持均未测量。模型调用数为0。历史记录未采集的新增字段保持缺失，不能倒填。\\n';\n"""
s=s[:pos]+dictionary+s[pos:];p.write_text(s,encoding='utf-8')
