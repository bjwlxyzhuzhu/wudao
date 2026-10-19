import { get, post } from './api.js';
import { esc, $, $$, toast, fail, modal, confirmBox } from './ui.js';
const roles = { student: '学生', teacher: '舞蹈教师', medic: '风险复核教师', admin: '管理员', unassigned: '未开通舞蹈权限' };
const fields = (u = {}) => `<label>舞蹈身份<select id="dance-role">${Object.entries(roles).filter(([k])=>k!=='unassigned').map(([k,v])=>`<option value="${k}" ${u.role===k?'selected':''}>${v}</option>`).join('')}</select></label><label>班级编号<input id="dance-cohort" maxlength="80" value="${esc(u.cohort || '')}" placeholder="例如 dance-a"></label><p>同班教师与学生须填写相同班级编号。管理员无需填写班级。风险复核教师使用舞安智护。</p>`;
export async function danceAccounts(app) {
  const { users } = await get('/api/admin/dance-users');
  app.innerHTML = `<div class="toolbar"><h1>师生账号管理</h1><button class="primary" id="dance-add">添加账号</button></div><p>创建账号时同时开通舞蹈身份与班级权限。新账号和重置密码后的账号，首次登录须修改临时密码。</p><div class="panel scroll-x"><table class="data"><thead><tr><th>账号</th><th>姓名</th><th>舞蹈身份</th><th>班级编号</th><th>状态</th><th>操作</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.login)}</td><td>${esc(u.display_name)}</td><td>${roles[u.role]}${u.is_admin&&u.role!=='admin'?' / 管理员':''}</td><td>${esc(u.cohort)||'—'}</td><td>${u.status==='active'?'启用':'停用'}${u.must_change_password?' / 待改密':''}</td><td><button data-profile="${u.user_id}">身份和班级</button><button data-toggle="${u.user_id}">${u.status==='active'?'停用':'启用'}</button><button data-pw="${u.user_id}">重置密码</button></td></tr>`).join('')}</tbody></table></div>`;
  const refresh=()=>danceAccounts(app);
  const showPassword=async(login,password)=>modal({title:'账号密码',body:`<p>账号：${esc(login)}</p><p>临时密码：<b>${esc(password)}</b></p><p>请保存并私下交给使用者。学生、教师从 /wujing 登录，风险复核教师从 /wuan 登录，管理员从 /admin 登录。首次登录按页面提示改密。</p>`});
  $('#dance-add').onclick=async()=>{
    try {
      const result=await modal({title:'添加舞蹈平台账号',body:`<div style="display:grid;gap:12px"><label>登录名<input id="dance-login" placeholder="3—40 位字母、数字或 _.@-"></label><label>姓名<input id="dance-name" maxlength="40"></label>${fields()}<label>初始密码<input id="dance-password" type="password" placeholder="留空自动生成，或填至少8位字母和数字"></label></div>`,buttons:[{label:'取消',value:null},{label:'创建',cls:'primary',handler:()=>post('/api/admin/dance-users',{login:$('#dance-login').value,display_name:$('#dance-name').value,role:$('#dance-role').value,cohort:$('#dance-cohort').value,password:$('#dance-password').value})}]});
      if(result){await showPassword(result.user.login,result.temporary_password);await refresh();}
    }catch(e){fail(e);}
  };
  $$('[data-profile]').forEach(b=>b.onclick=async()=>{try{
    const u=users.find(x=>x.user_id===b.dataset.profile);
    const r=await modal({title:'调整舞蹈身份和班级',body:`${fields(u)}<p>保存后该账号需重新登录。历史训练保留原班级归属；转班不会把旧班级记录迁移给新班级。</p>`,buttons:[{label:'取消',value:null},{label:'保存',cls:'primary',handler:()=>post(`/api/admin/dance-users/${u.user_id}/profile`,{role:$('#dance-role').value,cohort:$('#dance-cohort').value})}]});if(r)await refresh();
  }catch(e){fail(e);}});
  $$('[data-toggle]').forEach(b=>b.onclick=async()=>{try{const u=users.find(x=>x.user_id===b.dataset.toggle);if(!await confirmBox('调整账号状态',`<p>${u.status==='active'?'停用后将退出该账号的所有会话，保留历史记录。':'恢复该账号登录。'}</p>`))return;await post(`/api/admin/users/${u.user_id}/status`,{status:u.status==='active'?'disabled':'active'});await refresh();}catch(e){fail(e);}});
  $$('[data-pw]').forEach(b=>b.onclick=async()=>{try{const u=users.find(x=>x.user_id===b.dataset.pw);if(!await confirmBox('重置密码','<p>将注销全部会话，生成新的临时密码。下次登录需改密。</p>'))return;const r=await post(`/api/admin/users/${u.user_id}/reset-password`);await showPassword(u.login,r.temporary_password);await refresh();}catch(e){fail(e);}});
}
