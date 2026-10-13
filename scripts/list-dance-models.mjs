import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const path = join(resolve(process.env.DANCE_DATA_DIR || '.local/dance-data'), 'yanzhi.db');
if (!existsSync(path)) throw new Error('请先运行 npm run init:dance');
const db = new DatabaseSync(path, { readOnly: true });
try {
  const configurations = db.prepare('SELECT provider_id, name, kind, model_id, enabled FROM model_configs ORDER BY created_at').all();
  console.table(configurations);
  if (!configurations.length) console.log('尚无模型配置。请在 /admin/login 登录后添加支持图片输入的模型。');
} finally {
  db.close();
}
