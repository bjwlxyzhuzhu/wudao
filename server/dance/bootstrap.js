import { createUser } from '../auth.js';
import { one } from '../db.js';
import { saveConfig } from '../models.js';
import { addProfile } from './service.js';

// Public demo logins are intentionally predictable. They are created only when
// DANCE_DEMO_MODE=1 and must not be used for an Internet-facing production site.
export const DEMO_ACCOUNTS = [
  { login: 'admin01', display_name: '系统管理员一', kind: 'admin', password_env: 'DANCE_ADMIN_PASSWORD', demo_password: 'Admin123' },
  { login: 'admin02', display_name: '系统管理员二', kind: 'admin', password_env: 'DANCE_ADMIN_PASSWORD', demo_password: 'Admin123' },
  { login: 'teacher01', display_name: '舞蹈教师一', kind: 'teacher', cohort: 'dance-a', password_env: 'DANCE_TEACHER_PASSWORD', demo_password: 'Teach123' },
  { login: 'teacher02', display_name: '舞蹈教师二', kind: 'teacher', cohort: 'dance-a', password_env: 'DANCE_TEACHER_PASSWORD', demo_password: 'Teach123' },
  { login: 'teacher03', display_name: '舞蹈教师三', kind: 'teacher', cohort: 'dance-b', password_env: 'DANCE_TEACHER_PASSWORD', demo_password: 'Teach123' },
  { login: 'student01', display_name: '学生一', kind: 'student', cohort: 'dance-a', password_env: 'DANCE_STUDENT_PASSWORD', demo_password: 'Student123' },
  { login: 'student02', display_name: '学生二', kind: 'student', cohort: 'dance-a', password_env: 'DANCE_STUDENT_PASSWORD', demo_password: 'Student123' },
  { login: 'student03', display_name: '学生三', kind: 'student', cohort: 'dance-a', password_env: 'DANCE_STUDENT_PASSWORD', demo_password: 'Student123' },
  { login: 'student04', display_name: '学生四', kind: 'student', cohort: 'dance-b', password_env: 'DANCE_STUDENT_PASSWORD', demo_password: 'Student123' },
  { login: 'student05', display_name: '学生五', kind: 'student', cohort: 'dance-b', password_env: 'DANCE_STUDENT_PASSWORD', demo_password: 'Student123' },
  { login: 'student06', display_name: '学生六', kind: 'student', cohort: 'dance-b', password_env: 'DANCE_STUDENT_PASSWORD', demo_password: 'Student123' },
  { login: 'medic01', display_name: '风险复核教师', kind: 'medic', cohort: 'dance-a', password_env: 'DANCE_MEDIC_PASSWORD', demo_password: 'Medic123' },
];

function accountPassword(account, env, demo) {
  const password = env[account.password_env] || (demo ? account.demo_password : '');
  if (!password) throw new Error(`${account.password_env} 未设置，无法初始化 ${account.kind} 账号`);
  return password;
}

export function bootstrapDanceAccounts(db, env = process.env) {
  const demo = env.DANCE_DEMO_MODE === '1';
  if (!demo && env.DANCE_BOOTSTRAP_ACCOUNTS !== '1') return { enabled: false, created: [] };
  const created = [];
  for (const account of DEMO_ACCOUNTS) {
    let user = one(db, 'SELECT * FROM users WHERE login=?', account.login);
    if (!user) {
      user = createUser(db, {
        login: account.login,
        display_name: account.display_name,
        password: accountPassword(account, env, demo),
        is_teacher: false,
        is_admin: account.kind === 'admin',
        must_change_password: false,
      }, null);
      created.push(account.login);
    }
    if (account.kind !== 'admin' && !one(db, 'SELECT 1 FROM dance_profiles WHERE user_id=?', user.user_id)) {
      addProfile(db, user.user_id, account.kind, account.cohort);
    }
  }
  return { enabled: true, demo, created };
}

export function bootstrapQwen(db, env = process.env) {
  const apiKey = String(env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || '').trim();
  if (!apiKey) return { enabled: false };
  const name = '千问视觉（环境变量）';
  const existing = one(db, 'SELECT * FROM model_configs WHERE name=?', name);
  const actor = one(db, 'SELECT * FROM users WHERE is_admin=1 ORDER BY created_at LIMIT 1') || { user_id: null, is_admin: 1, scope: 'admin' };
  const sameKey = existing?.key_last4 && existing.key_last4 === apiKey.slice(-4);
  const config = saveConfig(db, actor, {
    provider_id: existing?.provider_id,
    name,
    kind: 'openai_compatible',
    base_url: env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model_id: env.QWEN_VISION_MODEL || 'qwen3-vl-plus',
    api_key: sameKey ? undefined : apiKey,
    concurrency: Number(env.QWEN_CONCURRENCY || 2),
    timeout_ms: Number(env.QWEN_TIMEOUT_MS || 90000),
    max_tokens: Number(env.QWEN_MAX_TOKENS || 2000),
    credit_rate: 1,
    cost_info: '由 DASHSCOPE_API_KEY/QWEN_API_KEY 在服务启动时配置',
    is_default: true,
  });
  env.DANCE_VISION_PROVIDER_ID ||= config.provider_id;
  env.DANCE_TEXT_PROVIDER_ID ||= config.provider_id;
  return { enabled: true, provider_id: config.provider_id, model_id: config.model_id, key_updated: !sameKey };
}

export function bootstrapDanceDeployment(db, env = process.env) {
  return { accounts: bootstrapDanceAccounts(db, env), qwen: bootstrapQwen(db, env) };
}
