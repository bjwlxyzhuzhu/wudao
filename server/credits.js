// Credit ledger. available = total_balance - reserved_balance.
// reserve: reserved += x (total unchanged) · settle: total -= r, reserved -= r · release: reserved -= x.
// Every ledger row has a unique idempotency key; replays return the original row.
import { one, all, run, id, now, tx, fail, check, audit } from './db.js';

export function balance(db, userId) {
  const a = one(db, 'SELECT total_balance, reserved_balance FROM credit_accounts WHERE user_id=?', userId);
  if (!a) return { total: 0, reserved: 0, available: 0 };
  return { total: a.total_balance, reserved: a.reserved_balance, available: a.total_balance - a.reserved_balance };
}

function entry(db, { user_id, type, amount = 0, reserved_delta = 0, key, reservation_id, run_id, call_id, batch_id, reason, actor_id, related_entry_id }) {
  const existing = one(db, 'SELECT * FROM credit_ledger WHERE idempotency_key=?', key);
  if (existing) return { ...existing, replayed: true };
  const a = one(db, 'SELECT * FROM credit_accounts WHERE user_id=?', user_id);
  check(a, 404, 'no_account', '积分账户不存在');
  const total = a.total_balance + amount, reserved = a.reserved_balance + reserved_delta;
  if (total < 0 || reserved < 0 || reserved > total) fail(409, 'insufficient_credits', '可用积分不足', { balance: balance(db, user_id) });
  run(db, 'UPDATE credit_accounts SET total_balance=?, reserved_balance=?, updated_at=? WHERE user_id=?', total, reserved, now(), user_id);
  const entry_id = id('ledger');
  run(db, `INSERT INTO credit_ledger(entry_id,user_id,type,amount,reserved_delta,total_after,reserved_after,idempotency_key,reservation_id,run_id,call_id,batch_id,reason,actor_id,related_entry_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, entry_id, user_id, type, amount, reserved_delta, total, reserved, key,
    reservation_id || null, run_id || null, call_id || null, batch_id || null, reason || null, actor_id || null, related_entry_id || null, now());
  return one(db, 'SELECT * FROM credit_ledger WHERE entry_id=?', entry_id);
}

/** One-time grant for a teacher identity. Key is per user, so refresh/re-login/retry never re-grants. */
export function grantInitial(db, userId, amount, actorId, reason = '新教师账号初始赠送') {
  return tx(db, () => entry(db, { user_id: userId, type: 'initial_grant', amount: Math.max(0, amount | 0), key: `initial:${userId}`, reason, actor_id: actorId }));
}

/** Migration: teachers lacking any initial grant record receive exactly one; accounts already granted are skipped. */
export function migrateInitialGrants(db, amount) {
  const rows = all(db, `SELECT u.user_id FROM users u WHERE u.is_teacher=1 AND NOT EXISTS
    (SELECT 1 FROM credit_ledger l WHERE l.idempotency_key = 'initial:' || u.user_id)`);
  for (const r of rows) {
    if (!one(db, 'SELECT 1 FROM credit_accounts WHERE user_id=?', r.user_id)) run(db, 'INSERT INTO credit_accounts(user_id,total_balance,reserved_balance,updated_at) VALUES(?,0,0,?)', r.user_id, now());
    grantInitial(db, r.user_id, amount, null, '迁移一次性赠送');
  }
  return rows.length;
}

/** Validate an admin adjustment batch without writing. items: [{user_id, amount}] (amount may be negative). */
export function previewAdjust(db, items, reason) {
  check(Array.isArray(items) && items.length > 0 && items.length <= 500, 400, 'bad_items', '请选择 1—500 名教师');
  check(typeof reason === 'string' && reason.trim().length >= 2, 400, 'reason_required', '请填写调整原因');
  const seen = new Set();
  return items.map((it) => {
    const amount = Number(it.amount);
    check(Number.isInteger(amount) && amount !== 0 && Math.abs(amount) <= 100000, 400, 'bad_amount', '调整数量须为非零整数');
    check(!seen.has(it.user_id), 400, 'duplicate_user', '同一批次中教师重复'); seen.add(it.user_id);
    const u = one(db, 'SELECT user_id, login, display_name, is_teacher FROM users WHERE user_id=?', it.user_id);
    check(u, 404, 'not_found', '用户不存在');
    const b = balance(db, u.user_id);
    const ok = amount > 0 || -amount <= b.available;
    return { user_id: u.user_id, login: u.login, display_name: u.display_name, amount, before: b,
      after: ok ? { total: b.total + amount, reserved: b.reserved, available: b.available + amount } : null,
      ok, problem: ok ? null : '扣减超过可用积分（冻结部分不可扣减）' };
  });
}

export function commitAdjust(db, admin, { batch_id, items, reason }) {
  check(typeof batch_id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(batch_id), 400, 'bad_batch', '缺少批次号');
  return tx(db, () => {
    const preview = previewAdjust(db, items, reason);
    // A replayed batch returns the original rows even if balances changed since.
    const replay = preview.every((p) => one(db, 'SELECT 1 FROM credit_ledger WHERE idempotency_key=?', `admin:${batch_id}:${p.user_id}`));
    if (!replay) check(preview.every((p) => p.ok), 409, 'insufficient_credits', '部分教师可用积分不足，整批未提交');
    const rows = preview.map((p) => entry(db, { user_id: p.user_id, type: p.amount > 0 ? 'admin_grant' : 'admin_deduct', amount: p.amount,
      key: `admin:${batch_id}:${p.user_id}`, batch_id, reason: reason.trim(), actor_id: admin.user_id }));
    if (!replay) audit(db, { actor: admin, action: 'credits_adjusted', target_type: 'batch', target_id: batch_id, detail: { n: rows.length, sum: preview.reduce((s, p) => s + p.amount, 0) } });
    return { replayed: replay, entries: rows };
  });
}

/** Reverse (冲正) a settled/admin entry. */
export function reverseEntry(db, admin, entryId, reason) {
  check(typeof reason === 'string' && reason.trim().length >= 2, 400, 'reason_required', '请填写冲正原因');
  return tx(db, () => {
    const e = one(db, 'SELECT * FROM credit_ledger WHERE entry_id=?', entryId);
    check(e, 404, 'not_found', '流水不存在');
    check(['settle', 'admin_grant', 'admin_deduct'].includes(e.type), 400, 'not_reversible', '该类型流水不能冲正');
    const r = entry(db, { user_id: e.user_id, type: 'reversal', amount: -e.amount, key: `reversal:${e.entry_id}`, reason: reason.trim(), actor_id: admin.user_id, related_entry_id: e.entry_id, run_id: e.run_id });
    audit(db, { actor: admin, action: 'credit_reversed', target_type: 'ledger', target_id: e.entry_id });
    return r;
  });
}

// ---- task reservations ----
export function reserve(db, { user_id, run_id, amount, rate, pricing_version, key }) {
  check(Number.isInteger(amount) && amount > 0, 400, 'bad_budget', '预算须为正整数');
  return tx(db, () => {
    const existing = one(db, 'SELECT * FROM reservations WHERE idempotency_key=?', key);
    if (existing) return existing;
    const reservation_id = id('resv');
    entry(db, { user_id, type: 'reserve', reserved_delta: amount, key: `reserve:${reservation_id}`, reservation_id, run_id, reason: '任务预占' });
    run(db, `INSERT INTO reservations(reservation_id,user_id,run_id,amount,rate,pricing_version,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      reservation_id, user_id, run_id || null, amount, rate, pricing_version, key, now());
    return one(db, 'SELECT * FROM reservations WHERE reservation_id=?', reservation_id);
  });
}

/** Claim capacity for one model call inside the reservation. Returns false when budget is exhausted. */
export function beginCall(db, reservationId) {
  return tx(db, () => {
    const r = one(db, 'SELECT * FROM reservations WHERE reservation_id=?', reservationId);
    if (!r || r.status !== 'open') return false;
    if (r.used + r.inflight + r.rate > r.amount) return false;
    run(db, 'UPDATE reservations SET inflight=inflight+? WHERE reservation_id=?', r.rate, reservationId);
    return true;
  });
}

function maybeClose(db, reservationId) {
  const r = one(db, 'SELECT * FROM reservations WHERE reservation_id=?', reservationId);
  if (r.status === 'closing' && r.inflight === 0) run(db, "UPDATE reservations SET status='closed', closed_at=? WHERE reservation_id=?", now(), reservationId);
}

/** Successful, validated and persisted output → charge exactly once per call. */
export function settleCall(db, reservationId, callId, runId) {
  return tx(db, () => {
    const r = one(db, 'SELECT * FROM reservations WHERE reservation_id=?', reservationId);
    check(r, 404, 'no_reservation', '预占不存在');
    const e = entry(db, { user_id: r.user_id, type: 'settle', amount: -r.rate, reserved_delta: -r.rate, key: `settle:${callId}`, reservation_id: reservationId, run_id: runId, call_id: callId, reason: '模型调用成功结算' });
    if (!e.replayed) run(db, 'UPDATE reservations SET used=used+?, inflight=inflight-? WHERE reservation_id=?', r.rate, r.rate, reservationId);
    maybeClose(db, reservationId);
    return e;
  });
}

/** Failed call (no valid output) → no charge; capacity returns to the reservation (or is released if closing). */
export function failCall(db, reservationId, callId) {
  return tx(db, () => {
    const r = one(db, 'SELECT * FROM reservations WHERE reservation_id=?', reservationId);
    if (!r || r.inflight < r.rate) return;
    run(db, 'UPDATE reservations SET inflight=inflight-? WHERE reservation_id=?', r.rate, reservationId);
    if (r.status === 'closing') {
      entry(db, { user_id: r.user_id, type: 'release', reserved_delta: -r.rate, key: `release-fail:${callId}`, reservation_id: reservationId, run_id: r.run_id, reason: '失败调用释放' });
      run(db, 'UPDATE reservations SET amount=amount-? WHERE reservation_id=?', r.rate, reservationId);
    }
    maybeClose(db, reservationId);
  });
}

/** Release everything not used and not in flight. In-flight calls settle or release on completion. */
export function releaseReservation(db, reservationId, reason) {
  return tx(db, () => {
    const r = one(db, 'SELECT * FROM reservations WHERE reservation_id=?', reservationId);
    if (!r || r.status !== 'open') return r;
    const free = r.amount - r.used - r.inflight;
    if (free > 0) entry(db, { user_id: r.user_id, type: 'release', reserved_delta: -free, key: `release:${reservationId}`, reservation_id: reservationId, run_id: r.run_id, reason: reason || '任务结束释放' });
    run(db, "UPDATE reservations SET amount=?, status=?, closed_at=?, close_reason=? WHERE reservation_id=?",
      r.used + r.inflight, r.inflight ? 'closing' : 'closed', r.inflight ? null : now(), reason || null, reservationId);
    return one(db, 'SELECT * FROM reservations WHERE reservation_id=?', reservationId);
  });
}

export function ledger(db, userId, limit = 200) {
  return all(db, 'SELECT * FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?', userId, limit);
}

/** Consistency check: account totals equal the sum of ledger rows. */
export function reconcileAccount(db, userId) {
  const s = one(db, 'SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(reserved_delta),0) reserved FROM credit_ledger WHERE user_id=?', userId);
  const b = balance(db, userId);
  const open = one(db, "SELECT COALESCE(SUM(amount-used),0) r FROM reservations WHERE user_id=? AND status IN ('open','closing')", userId).r;
  return { ok: s.total === b.total && s.reserved === b.reserved && open === b.reserved, ledger_total: s.total, ledger_reserved: s.reserved, account: b, open_reservations: open };
}
