import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

test('舞蹈部署只展示舞蹈首页，旧教研入口跳转', async () => {
  const previous = process.env.DANCE_HOME;
  process.env.DANCE_HOME = '1';
  const app = await startApp();
  try {
    for (const path of ['/', '/wujing', '/wuan']) {
      const res = await fetch(app.base + path);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /舞镜智练/);
    }
    const legacy = await fetch(app.base + '/index.html', { redirect: 'manual' });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get('location'), '/wujing');
    assert.match(await (await fetch(app.base + '/admin')).text(), /舞镜智练/);
  } finally {
    await app.stop();
    if (previous === undefined) delete process.env.DANCE_HOME;
    else process.env.DANCE_HOME = previous;
  }
});
