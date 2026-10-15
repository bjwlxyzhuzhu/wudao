// 品牌版本：YANZHI_BRAND=szsx 时界面名称、标题、Logo 与数字客服回答改为“演知思政”，功能与数据不变。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.YANZHI_BRAND = 'szsx';
const { startApp } = await import('./helpers.js');
let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

test('演知思政版：页面、脚本、手册、Logo 与思思的回答使用新名称', async () => {
  const get = (p) => fetch(app.base + p);
  for (const p of ['/', '/manual', '/js/home.js']) { const t = await (await get(p)).text(); assert.ok(!t.includes('研思智境') && t.includes('演知思政'), p); }
  const admin = await (await get('/admin')).text();
  assert.ok(!admin.includes('研思智境') && admin.includes('舞镜智练'), '舞蹈管理中心保持独立产品品牌');
  assert.match(await (await get('/')).text(), /<title>演知思政 · 基于Agents协同与对抗的虚拟教研实训工场<\/title>/);
  const logo = Buffer.from(await (await get('/img/logo-full.png')).arrayBuffer());
  const { readFileSync } = await import('node:fs');
  assert.ok(logo.equals(readFileSync(new URL('../public/img/brand/szsx/logo-full.png', import.meta.url))), '使用品牌 Logo');
  const a = await (await fetch(app.base + '/api/assistant/public-ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-yz-csrf': '1' }, body: JSON.stringify({ question: '平台是什么？' }) })).json();
  assert.ok(a.answer.includes('演知思政') && !a.answer.includes('研思智境'), a.answer.slice(0, 60));
});
