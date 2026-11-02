'use strict'

const { DatabaseSync } = require('node:sqlite')
const { randomUUID } = require('node:crypto')
const { mkdirSync } = require('node:fs')
const path = require('node:path')

class Store {
  constructor(file = ':memory:') {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS monitors(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, target TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}', interval_seconds INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'unknown', failures INTEGER NOT NULL DEFAULT 0,
        last_checked INTEGER, next_due INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, summary TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS monitor_identity ON monitors(kind, target, config);
      CREATE TABLE IF NOT EXISTS checks(
        id INTEGER PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
        checked_at INTEGER NOT NULL, healthy INTEGER NOT NULL, latency_ms INTEGER, summary TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS checks_by_monitor ON checks(monitor_id, id DESC);
      CREATE TABLE IF NOT EXISTS incidents(
        id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id), opened_at INTEGER NOT NULL,
        resolved_at INTEGER, acknowledged_at INTEGER, acknowledged_by TEXT, summary TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident ON incidents(monitor_id) WHERE resolved_at IS NULL;
      CREATE TABLE IF NOT EXISTS subscribers(chat_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
        locked_at INTEGER, sent_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delivery_queue ON outbox(state, next_attempt);
      CREATE TABLE IF NOT EXISTS telegram_updates(
        update_id INTEGER PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demo_messages(id INTEGER PRIMARY KEY, direction TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases(name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `)
    this.db.prepare('INSERT OR IGNORE INTO migrations VALUES (1, ?)').run(Date.now())
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = fn(); this.db.exec('COMMIT'); return value } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close() { this.db.close() }
  getSetting(key, fallback = null) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)) }
  listMonitors() { return this.db.prepare('SELECT * FROM monitors ORDER BY created_at, rowid').all().map(row => ({ ...row, enabled: Boolean(row.enabled), config: JSON.parse(row.config) })) }
  getMonitor(id) { return this.listMonitors().find(monitor => monitor.id === id) }
  addMonitor(input, now = Date.now()) {
    const id = input.id || randomUUID()
    this.db.prepare('INSERT INTO monitors(id,kind,name,target,config,interval_seconds,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, input.kind, input.name, input.target, JSON.stringify(input.config || {}), input.intervalSeconds, now)
    return this.getMonitor(id)
  }
  setEnabled(id, enabled) { return this.db.prepare('UPDATE monitors SET enabled=?, next_due=0 WHERE id=?').run(Number(enabled), id).changes > 0 }
  subscribe(chatId) { this.db.prepare('INSERT OR IGNORE INTO subscribers VALUES (?,?)').run(String(chatId), Date.now()) }
  unsubscribe(chatId) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM subscribers WHERE chat_id=?').run(String(chatId))
      this.db.prepare("UPDATE outbox SET state='cancelled' WHERE chat_id=? AND state IN ('pending','sending')").run(String(chatId))
    })
  }
  queue(kind, incident, monitor, now) {
    const payload = JSON.stringify({ incidentId: incident.id, monitorName: monitor.name, summary: incident.summary, openedAt: incident.opened_at, resolvedAt: incident.resolved_at || null })
    const insert = this.db.prepare('INSERT OR IGNORE INTO outbox(id,dedupe_key,chat_id,kind,payload,next_attempt,created_at) VALUES(?,?,?,?,?,?,?)')
    for (const { chat_id } of this.db.prepare('SELECT chat_id FROM subscribers').all()) {
      insert.run(randomUUID(), `${incident.id}:${kind}:${chat_id}`, chat_id, kind, payload, now, now)
    }
  }
  recordCheck(id, result, threshold, now = Date.now()) {
    return this.transaction(() => {
      const monitor = this.getMonitor(id)
      if (!monitor) throw new Error('Проверка не найдена')
      const failures = result.healthy ? 0 : monitor.failures + 1
      const status = result.healthy ? 'up' : (failures >= threshold ? 'down' : monitor.status)
      this.db.prepare('INSERT INTO checks(monitor_id,checked_at,healthy,latency_ms,summary,meta) VALUES(?,?,?,?,?,?)')
        .run(id, now, Number(result.healthy), result.latencyMs ?? null, result.summary.slice(0, 500), JSON.stringify(result.meta || {}))
      this.db.prepare('UPDATE monitors SET status=?, failures=?, last_checked=?, next_due=?, latency_ms=?, summary=? WHERE id=?')
        .run(status, failures, now, now + monitor.interval_seconds * 1000, result.latencyMs ?? null, result.summary.slice(0, 500), id)
      let incident = this.db.prepare('SELECT * FROM incidents WHERE monitor_id=? AND resolved_at IS NULL').get(id)
      let transition = null
      if (!result.healthy && failures >= threshold && !incident) {
        incident = { id: randomUUID(), monitor_id: id, opened_at: now, summary: result.summary.slice(0, 500) }
        this.db.prepare('INSERT INTO incidents(id,monitor_id,opened_at,summary) VALUES(?,?,?,?)').run(incident.id, id, now, incident.summary)
        this.queue('opened', incident, monitor, now)
        transition = 'opened'
      } else if (result.healthy && incident) {
        this.db.prepare('UPDATE incidents SET resolved_at=? WHERE id=?').run(now, incident.id)
        incident.resolved_at = now
        this.queue('resolved', incident, monitor, now)
        transition = 'resolved'
      }
      this.db.prepare('DELETE FROM checks WHERE monitor_id=? AND id NOT IN (SELECT id FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT 720)').run(id, id)
      return { monitor: this.getMonitor(id), incident, transition }
    })
  }
  acknowledge(id, actor, now = Date.now()) {
    return this.db.prepare('UPDATE incidents SET acknowledged_at=?, acknowledged_by=? WHERE id=? AND resolved_at IS NULL AND acknowledged_at IS NULL').run(now, String(actor).slice(0, 80), id).changes > 0
  }
  incidents(limit = 60) { return this.db.prepare('SELECT i.*,m.name AS monitor_name,m.kind FROM incidents i JOIN monitors m ON m.id=i.monitor_id ORDER BY (i.resolved_at IS NOT NULL),i.opened_at DESC LIMIT ?').all(limit) }
  history(id, limit = 48) { return this.db.prepare('SELECT checked_at,healthy,latency_ms,summary FROM checks WHERE monitor_id=? ORDER BY id DESC LIMIT ?').all(id, limit).reverse() }
  claimDelivery(now = Date.now()) {
    return this.transaction(() => {
      const item = this.db.prepare("SELECT * FROM outbox WHERE (state='pending' AND next_attempt<=?) OR (state='sending' AND locked_at<?) ORDER BY created_at LIMIT 1").get(now, now - 60000)
      if (!item) return null
      this.db.prepare("UPDATE outbox SET state='sending', attempts=attempts+1, locked_at=? WHERE id=?").run(now, item.id)
      return { ...item, attempts: item.attempts + 1, payload: JSON.parse(item.payload) }
    })
  }
  finishDelivery(id, now = Date.now()) { this.db.prepare("UPDATE outbox SET state='sent', sent_at=?, last_error=NULL WHERE id=?").run(now, id) }
  failDelivery(item, errorCode, retrySeconds = 0, now = Date.now()) {
    const delay = Math.max(retrySeconds * 1000, Math.min(300000, 1000 * 2 ** item.attempts))
    this.db.prepare('UPDATE outbox SET state=?, next_attempt=?, last_error=? WHERE id=?')
      .run(item.attempts >= 5 ? 'dead' : 'pending', now + delay, String(errorCode).slice(0, 120), item.id)
  }
  deliveries(limit = 30) { return this.db.prepare('SELECT id,kind,payload,state,attempts,created_at,sent_at,last_error FROM outbox ORDER BY created_at DESC LIMIT ?').all(limit).map(row => ({ ...row, payload: JSON.parse(row.payload) })) }
  retryDelivery(id, now = Date.now()) { return this.db.prepare("UPDATE outbox SET state='pending', attempts=0, next_attempt=?, last_error=NULL WHERE id=? AND state='dead'").run(now, id).changes > 0 }
  acceptUpdate(update, now = Date.now()) {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) return false
    const result = this.db.prepare('INSERT OR IGNORE INTO telegram_updates(update_id,payload,created_at) VALUES(?,?,?)').run(update.update_id, JSON.stringify(update), now)
    return result.changes > 0
  }
  nextUpdate() { const row = this.db.prepare("SELECT * FROM telegram_updates WHERE state='pending' AND attempts<3 ORDER BY update_id LIMIT 1").get(); return row ? JSON.parse(row.payload) : null }
  finishUpdate(id) { this.db.prepare("UPDATE telegram_updates SET state='done' WHERE update_id=?").run(id) }
  failUpdate(id) { this.db.prepare('UPDATE telegram_updates SET attempts=attempts+1 WHERE update_id=?').run(id) }
  offset() { return (this.db.prepare('SELECT MAX(update_id) AS last FROM telegram_updates').get().last ?? -1) + 1 }
  addDemoMessage(direction, text) {
    this.db.prepare('INSERT INTO demo_messages(direction,text,created_at) VALUES(?,?,?)').run(direction, text, Date.now())
    this.db.exec('DELETE FROM demo_messages WHERE id NOT IN (SELECT id FROM demo_messages ORDER BY id DESC LIMIT 60)')
  }
  demoMessages() { return this.db.prepare('SELECT * FROM demo_messages ORDER BY id').all() }
  claimLease(owner, now = Date.now()) {
    return this.transaction(() => {
      const current = this.db.prepare("SELECT * FROM leases WHERE name='runtime'").get()
      if (current && current.owner !== owner && current.expires_at > now) return false
      this.db.prepare("INSERT INTO leases VALUES('runtime',?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at").run(owner, now + 60000)
      return true
    })
  }
  releaseLease(owner) { this.db.prepare("DELETE FROM leases WHERE name='runtime' AND owner=?").run(owner) }
  maintenance(now = Date.now()) {
    const cutoff = now - 30 * 86400000
    this.db.prepare("DELETE FROM telegram_updates WHERE created_at<? AND (state='done' OR attempts>=3)").run(cutoff)
    this.db.prepare("DELETE FROM outbox WHERE created_at<? AND state IN ('sent','cancelled')").run(cutoff)
    this.db.prepare('DELETE FROM incidents WHERE resolved_at<?').run(cutoff)
  }
}

module.exports = { Store }
