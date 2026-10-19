import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import * as curriculum from '../public/dance/curriculum.js';

// Render the actual frontend templates with a minimal DOM. This is a template
// regression test, not a substitute for browser layout or video playback QA.
test('舞衡智护页面模板显示四项动作、教师示例与风险边界', () => {
  const root = { innerHTML: '', addEventListener() {} };
  const document = { body: { classList: { toggle() {} } }, title: '',
    querySelector(selector) { return selector === '#app' ? root : selector === '.topbar' ? { append() {} } : null; },
    createElement() { return { dataset: {} }; },
  };
  let source = readFileSync(new URL('../public/dance/app.js', import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
  source = source.slice(0, source.lastIndexOf('await refresh().catch'));
  const context = createContext({ ...curriculum, document, location: { pathname:'/wujing' }, METRIC_VERSION: 'test', setTimeout, clearTimeout, setInterval, clearInterval, URL, console });
  runInContext(source,context);
  runInContext('login()',context);
  assert.ok(root.innerHTML.includes(curriculum.PROJECT_TITLE));
  runInContext("state.user={role:'teacher',name:'测试教师'}; state.catalog={actions:ACTIONS,roles:[]};home()",context);
  for (const action of curriculum.ACTIONS) assert.ok(root.innerHTML.includes(action.title));
  assert.ok(root.innerHTML.includes(curriculum.STANDARD_BASIS));
  for (const action of curriculum.ACTIONS) {
    runInContext(`state.action=${JSON.stringify(action.key)};standards()`,context);
    assert.ok(root.innerHTML.includes(action.instructions));
    assert.ok(root.innerHTML.includes(action.checkpoints[0]));
    assert.ok(root.innerHTML.includes(action.safety));
  }
  runInContext("state.user={role:'student',name:'学生'};home();",context);
  assert.ok(root.innerHTML.includes('等待老师发布'));
  runInContext("state.user={role:'medic',name:'复核教师'};healthPage();",context);
  assert.ok(root.innerHTML.includes('训练生物力学风险提示'));
  assert.ok(root.innerHTML.includes(curriculum.BIOMECHANICS_BOUNDARY));
  assert.ok(root.innerHTML.includes('不做安全评级'));
});
