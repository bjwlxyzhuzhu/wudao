import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb, one } from '../server/db.js';
import { createUser } from '../server/auth.js';
import { ensureDance, addProfile } from '../server/dance/service.js';

const dataDir = resolve(process.env.DANCE_DATA_DIR || '.local/dance-data');
mkdirSync(dataDir, { recursive: true });
const credentialsPath = join(dataDir, 'local-access.json');
if (existsSync(credentialsPath)) {
  console.log(`本机账号已初始化，未修改密码。账号文件：${credentialsPath}`);
} else {
  const db = openDb(join(dataDir, 'yanzhi.db'));
  ensureDance(db);
  const accounts = [];
  for (const [login, name, role] of [['dance_teacher','舞蹈教师','teacher'],['dance_student','体验学员','student'],['dance_medic','风险复核教师','medic'],['dance_admin','本机管理员','admin']]) {
    if (one(db, 'SELECT 1 FROM users WHERE login=?', login)) throw new Error(`账号已存在：${login}；不会覆盖，请使用现有密码或另设数据目录`);
    const password = `D${randomBytes(12).toString('base64url')}9`;
    const user = createUser(db, { login, display_name: name, password, is_teacher: false, is_admin: role === 'admin', must_change_password: false });
    if (role !== 'admin') addProfile(db, user.user_id, role, 'local-studio');
    accounts.push({ role, login, password });
  }
  db.close();
  writeFileSync(credentialsPath, JSON.stringify({ note: '仅本机开发账号，随机密码；不上传到 GitHub。示范标准需要教师自行发布。', accounts }, null, 2), { mode: 0o600 });
  console.log(`本机账号已创建，随机密码保存在：${credentialsPath}`);
}
