// Model configuration, API key encryption (AES-256-GCM) and provider adapters.
// Keys live only on the server; the API never returns ciphertext or plaintext, only "configured / last4".
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { one, all, run, id, now, tx, fail, check, audit, getSetting, setSetting } from './db.js';

let MASTER = null;
export function loadMasterKey(dataDir) {
  const env = process.env.YANZHI_MASTER_KEY;
  if (env) {
    const buf = /^[0-9a-fA-F]{64}$/.test(env) ? Buffer.from(env, 'hex') : Buffer.from(env, 'base64');
    if (buf.length !== 32) throw new Error('YANZHI_MASTER_KEY 必须是 32 字节（64 位十六进制或 base64）');
    MASTER = buf; return 'env';
  }
  const file = `${dataDir}/master.key`;
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 }); }
  MASTER = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  return 'file';
}
function encrypt(plain) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', MASTER, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { ct: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function decrypt(row) {
  const d = createDecipheriv('aes-256-gcm', MASTER, Buffer.from(row.key_iv, 'base64'));
  d.setAuthTag(Buffer.from(row.key_tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(row.key_ciphertext, 'base64')), d.final()]).toString('utf8');
}

export const KINDS = { openai_compatible: 'OpenAI 兼容（/chat/completions）', anthropic: 'Anthropic Messages（/v1/messages）' };

export function validateBaseUrl(raw) {
  let u; try { u = new URL(String(raw || '').trim()); } catch { fail(400, 'bad_base_url', '服务地址格式无效'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  check(u.protocol === 'https:' || (u.protocol === 'http:' && local && process.env.YANZHI_ALLOW_HTTP_LOCAL === '1'), 400, 'bad_base_url', '服务地址必须使用 https');
  check(!u.username && !u.password && !u.search && !u.hash, 400, 'bad_base_url', '服务地址不能包含凭据、查询参数或锚点');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export function publicConfig(r) {
  if (!r) return null;
  return { provider_id: r.provider_id, name: r.name, kind: r.kind, base_url: r.base_url, model_id: r.model_id, capability: r.capability,
    enabled: !!r.enabled, is_default: !!r.is_default, concurrency: r.concurrency, timeout_ms: r.timeout_ms, max_tokens: r.max_tokens,
    credit_rate: r.credit_rate, cost_info: r.cost_info, key_configured: !!r.key_ciphertext, key_last4: r.key_last4 || null,
    key_version: r.key_version, updated_at: r.updated_at };
}
export const listConfigs = (db) => all(db, 'SELECT * FROM model_configs ORDER BY created_at').map(publicConfig);

export function saveConfig(db, admin, input) {
  const kind = input.kind;
  check(Object.hasOwn(KINDS, kind), 400, 'bad_kind', '不支持的接口类型');
  const name = String(input.name || '').trim(); check(name.length >= 1 && name.length <= 60, 400, 'bad_name', '请填写名称');
  const model_id = String(input.model_id || '').trim(); check(/^[\w.:/@-]{1,120}$/.test(model_id), 400, 'bad_model', '模型ID格式无效');
  const base_url = validateBaseUrl(input.base_url);
  const int = (v, d, lo, hi) => { const n = v == null || v === '' ? d : Number(v); check(Number.isInteger(n) && n >= lo && n <= hi, 400, 'bad_number', `数值需在 ${lo}—${hi}`); return n; };
  const fields = { name, kind, base_url, model_id, capability: 'chat', enabled: input.enabled === false ? 0 : 1,
    concurrency: int(input.concurrency, 2, 1, 20), timeout_ms: int(input.timeout_ms, 60000, 5000, 300000), max_tokens: int(input.max_tokens, 1200, 64, 16000),
    credit_rate: int(input.credit_rate, 1, 1, 100), cost_info: input.cost_info ? String(input.cost_info).slice(0, 200) : null };
  return tx(db, () => {
    let pid = input.provider_id;
    const prev = pid ? one(db, 'SELECT * FROM model_configs WHERE provider_id=?', pid) : null;
    if (pid) check(prev, 404, 'not_found', '配置不存在');
    if (!prev) {
      pid = id('model');
      run(db, `INSERT INTO model_configs(provider_id,name,kind,base_url,model_id,capability,enabled,concurrency,timeout_ms,max_tokens,credit_rate,cost_info,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, pid, ...Object.values(fields), now(), now());
    } else {
      run(db, `UPDATE model_configs SET name=?,kind=?,base_url=?,model_id=?,capability=?,enabled=?,concurrency=?,timeout_ms=?,max_tokens=?,credit_rate=?,cost_info=?,updated_at=? WHERE provider_id=?`,
        ...Object.values(fields), now(), pid);
      // Rate changes only apply to new tasks: bump pricing version; running tasks keep their snapshot.
      if (prev.credit_rate !== fields.credit_rate) setSetting(db, 'pricing_version', Number(getSetting(db, 'pricing_version')) + 1, admin.user_id);
    }
    if (input.api_key) setKey(db, admin, pid, input.api_key);
    if (input.is_default || !one(db, 'SELECT 1 FROM model_configs WHERE is_default=1')) {
      run(db, 'UPDATE model_configs SET is_default=0'); run(db, 'UPDATE model_configs SET is_default=1 WHERE provider_id=?', pid);
    }
    audit(db, { actor: admin, action: prev ? 'model_config_updated' : 'model_config_created', target_type: 'model_config', target_id: pid,
      detail: { base_url, model_id, kind, credit_rate: fields.credit_rate, enabled: !!fields.enabled } });
    return publicConfig(one(db, 'SELECT * FROM model_configs WHERE provider_id=?', pid));
  });
}

export function setKey(db, admin, pid, key) {
  key = String(key || '').trim();
  check(key.length >= 8 && key.length <= 512 && !/\s/.test(key), 400, 'bad_key', 'API Key 格式无效');
  const e = encrypt(key);
  tx(db, () => {
    run(db, 'UPDATE model_configs SET key_ciphertext=?, key_iv=?, key_tag=?, key_last4=?, key_version=key_version+1, updated_at=? WHERE provider_id=?', e.ct, e.iv, e.tag, key.slice(-4), now(), pid);
    const v = one(db, 'SELECT key_version FROM model_configs WHERE provider_id=?', pid).key_version;
    audit(db, { actor: admin, action: v > 1 ? 'api_key_rotated' : 'api_key_saved', target_type: 'model_config', target_id: pid, detail: { key_version: v } });
  });
}
export function removeKey(db, admin, pid) {
  tx(db, () => {
    run(db, 'UPDATE model_configs SET key_ciphertext=NULL, key_iv=NULL, key_tag=NULL, key_last4=NULL, updated_at=? WHERE provider_id=?', now(), pid);
    audit(db, { actor: admin, action: 'api_key_removed', target_type: 'model_config', target_id: pid });
  });
}

/** The provider a new task would use, or a precise reason why none is usable. */
export function resolveProvider(db, providerId) {
  const r = providerId ? one(db, 'SELECT * FROM model_configs WHERE provider_id=?', providerId) : one(db, 'SELECT * FROM model_configs WHERE is_default=1');
  if (!r) return { error: { code: 'no_model_config', message: '管理员尚未配置模型，真实模型模式不可用' } };
  if (!r.enabled) return { error: { code: 'model_disabled', message: '该模型配置已停用' } };
  if (!r.key_ciphertext) return { error: { code: 'missing_key', message: '管理员尚未配置该模型的 API Key' } };
  return { config: r };
}

// ---- adapters ----
export class ModelError extends Error { constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); } }
const inflight = new Map();

// Provider error text is shown to admins/teachers to make misconfiguration diagnosable; anything key-like is masked.
function providerReason(body) {
  let msg = '';
  try { const j = JSON.parse(body); msg = j.error?.message || j.message || ''; } catch { msg = ''; }
  return String(msg).replace(/(sk|key|bearer)[-_ ]?[A-Za-z0-9._-]{8,}/gi, '***').replace(/\s*\(request_id:[^)]*\)/i, '').slice(0, 240);
}
function mapStatus(status, body) {
  const why = providerReason(body), tail = why ? `：${why}` : '';
  if (status === 401 || status === 403) return new ModelError('auth_failed', '模型服务拒绝了凭据（请管理员检查 API Key）');
  if (status === 404) return new ModelError('model_unsupported', `模型或接口不存在（请检查模型ID/服务地址）${tail}`, { provider_message: why });
  if (status === 402) return new ModelError('provider_quota', '模型服务账户额度不足');
  if (status === 429) return new ModelError(/quota|insufficient|balance/i.test(body) ? 'provider_quota' : 'rate_limited', /quota|insufficient|balance/i.test(body) ? '模型服务账户额度不足' : '模型服务限流，请稍后重试');
  if (status === 400) return new ModelError('bad_request', /model/i.test(why) ? `模型ID不被支持，请管理员在后台修改模型配置${tail}` : `模型服务拒绝请求（参数或模型不支持）${tail}`, { provider_message: why });
  return new ModelError('provider_error', `模型服务错误（HTTP ${status}）`);
}

async function* sseLines(body) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); yield line; }
  }
  if (buf) yield buf;
}

/**
 * Stream one chat completion. Returns { text, input_tokens, output_tokens, request_id, first_token_at, model_reported }.
 * Throws ModelError with a specific code. Never falls back to scripted text.
 */
export async function chat(cfg, { system, messages, max_tokens, onDelta, signal }) {
  const key = decrypt(cfg);
  const n = inflight.get(cfg.provider_id) || 0;
  if (n >= cfg.concurrency) throw new ModelError('concurrency_limit', '模型并发已达上限，请稍后');
  inflight.set(cfg.provider_id, n + 1);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new ModelError('timeout', '模型响应超时')), cfg.timeout_ms);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(new ModelError('cancelled', '已取消')), { once: true });
  const out = { text: '', input_tokens: null, output_tokens: null, request_id: null, first_token_at: null, model_reported: null };
  const delta = (t) => { if (!t) return; if (!out.first_token_at) out.first_token_at = now(); out.text += t; onDelta && onDelta(t); };
  try {
    let url, headers, body;
    const maxTok = Math.min(max_tokens || cfg.max_tokens, cfg.max_tokens);
    if (cfg.kind === 'anthropic') {
      url = `${cfg.base_url}/v1/messages`;
      headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' };
      body = { model: cfg.model_id, max_tokens: maxTok, system, messages, stream: true };
    } else {
      url = `${cfg.base_url}/chat/completions`;
      headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
      body = { model: cfg.model_id, max_tokens: maxTok, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: system }, ...messages] };
      // DeepSeek V4 models think before answering by default; short classroom/seminar turns would spend the whole
      // max_tokens on reasoning and return no text. Ask for a direct answer (verified against api.deepseek.com).
      if (/(^|\.)deepseek\.com$/i.test(new URL(cfg.base_url).hostname)) body.thinking = { type: 'disabled' };
    }
    let res;
    try { res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal, redirect: 'error' }); }
    catch (e) { throw ctrl.signal.reason instanceof ModelError ? ctrl.signal.reason : new ModelError('network', '无法连接模型服务'); }
    out.request_id = res.headers.get('request-id') || res.headers.get('x-request-id') || null;
    if (!res.ok) { const t = await res.text().catch(() => ''); throw mapStatus(res.status, t.slice(0, 500)); }
    try {
      for await (const line of sseLines(res.body)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (cfg.kind === 'anthropic') {
          if (j.type === 'message_start') { out.request_id = out.request_id || j.message?.id; out.model_reported = j.message?.model || null; out.input_tokens = j.message?.usage?.input_tokens ?? null; }
          else if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') delta(j.delta.text);
          else if (j.type === 'message_delta' && j.usage) out.output_tokens = j.usage.output_tokens ?? out.output_tokens;
          else if (j.type === 'error') throw new ModelError('provider_error', '模型服务流式错误');
        } else {
          out.request_id = out.request_id || j.id || null; out.model_reported = j.model || out.model_reported;
          delta(j.choices?.[0]?.delta?.content);
          if (j.choices?.[0]?.delta?.reasoning_content) out.reasoning = true;
          if (j.usage) { out.input_tokens = j.usage.prompt_tokens ?? null; out.output_tokens = j.usage.completion_tokens ?? null; }
        }
      }
    } catch (e) {
      if (e instanceof ModelError) throw e;
      throw ctrl.signal.reason instanceof ModelError ? ctrl.signal.reason : new ModelError('stream_interrupted', '模型输出流中断');
    }
    if (!out.text.trim()) throw new ModelError('bad_format', out.reasoning ? '模型只输出了思考过程、没有给出正文（请调大最大 token 或关闭深度思考）' : '模型返回为空');
    return out;
  } finally {
    clearTimeout(timer);
    inflight.set(cfg.provider_id, (inflight.get(cfg.provider_id) || 1) - 1);
  }
}

/** Admin: list the provider's model IDs (GET {base_url}/models, OpenAI-compatible). Free on DeepSeek/OpenAI; no teacher credits. */
export async function listRemoteModels(db, admin, pid) {
  const cfg = one(db, 'SELECT * FROM model_configs WHERE provider_id=?', pid);
  check(cfg, 404, 'not_found', '配置不存在');
  check(cfg.key_ciphertext, 400, 'missing_key', '尚未配置 API Key');
  const key = decrypt(cfg);
  const headers = cfg.kind === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` };
  const url = cfg.kind === 'anthropic' ? `${cfg.base_url}/v1/models` : `${cfg.base_url}/models`;
  let res;
  try { res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) }); } catch { return { ok: false, code: 'network', message: '无法连接模型服务' }; }
  const text = await res.text().catch(() => '');
  if (!res.ok) { const e = mapStatus(res.status, text.slice(0, 500)); return { ok: false, code: e.code, message: e.message }; }
  let data = []; try { data = JSON.parse(text).data || []; } catch { /* not a list */ }
  audit(db, { actor: admin, action: 'model_list_remote', target_type: 'model_config', target_id: pid, detail: { n: data.length } });
  return { ok: true, current: cfg.model_id, models: data.map((m) => ({ id: String(m.id), name: m.name || m.display_name || null })).slice(0, 50) };
}

/** Admin connectivity test (may incur real provider cost; not charged to teachers). */
export async function testConnection(db, admin, pid) {
  const cfg = one(db, 'SELECT * FROM model_configs WHERE provider_id=?', pid);
  check(cfg, 404, 'not_found', '配置不存在');
  check(cfg.key_ciphertext, 400, 'missing_key', '尚未配置 API Key');
  const t0 = Date.now();
  let result;
  try {
    const r = await chat({ ...cfg, max_tokens: 16 }, { system: 'Connectivity check. Reply with OK.', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 });
    result = { ok: true, latency_ms: Date.now() - t0, request_id: r.request_id, model_reported: r.model_reported, output_tokens: r.output_tokens };
  } catch (e) {
    result = { ok: false, code: e.code || 'error', message: e.message, latency_ms: Date.now() - t0 };
  }
  audit(db, { actor: admin, action: 'model_connection_test', target_type: 'model_config', target_id: pid, detail: { ok: result.ok, code: result.code || null, request_id: result.request_id || null, key_version: cfg.key_version } });
  return result;
}
