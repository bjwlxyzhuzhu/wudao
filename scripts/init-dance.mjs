import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { openDb, one, run } from '../server/db.js';
import { createUser, hashPassword } from '../server/auth.js';
import { ensureDance, addProfile } from '../server/dance/service.js';

const dataDir = resolve(process.env.DANCE_DATA_DIR || '.local/dance-data');
mkdirSync(dataDir, { recursive: true });
const credentialsPath = join(dataDir, 'local-access.json');
const resetPasswords = process.argv.includes('--reset-passwords');
const password = '12345678';
const definitions = [['dance_teacher','舞蹈教师','teacher'],['dance_student','体验学员','student'],['dance_medic','风险复核教师','medic'],['dance_admin','本机管理员','admin']];

if (existsSync(credentialsPath) && !resetPasswords) {
  console.log(`本机账号已初始化，未修改密码。账号文件：${credentialsPath}`);
} else {
  const db = openDb(join(dataDir, 'yanzhi.db'));
  ensureDance(db);
  const accounts = [];
  for (const [login, name, role] of definitions) {
    let user = one(db, 'SELECT * FROM users WHERE login=?', login);
    if (user) {
      if (!resetPasswords) throw new Error(`账号已存在：${login}；如需统一设为本机演示密码，请加 --reset-passwords`);
      run(db, 'UPDATE users SET password_hash=?, must_change_password=0 WHERE user_id=?', hashPassword(password), user.user_id);
      run(db, 'DELETE FROM sessions WHERE user_id=?', user.user_id);
    } else {
      user = createUser(db, { login, display_name: name, password, is_teacher: false, is_admin: role === 'admin', must_change_password: false, allowLocalDemoPassword: true });
    }
    if (role !== 'admin' && !one(db, 'SELECT 1 FROM dance_profiles WHERE user_id=?', user.user_id)) addProfile(db, user.user_id, role, 'local-studio');
    accounts.push({ role, login, password });
  }
  db.close();
  writeFileSync(credentialsPath, JSON.stringify({ note: '仅限本机演示使用，统一密码较弱，不得用于公网部署；不上传到 GitHub。示范标准需要教师自行发布。', accounts }, null, 2), { mode: 0o600 });
  console.log(`${resetPasswords ? '本机账号密码已重置' : '本机账号已创建'}，账号信息保存在：${credentialsPath}`);
}
