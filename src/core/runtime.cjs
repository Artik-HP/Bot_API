'use strict'

const { randomUUID } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')

class Runtime {
  constructor({ store, monitoring, notifications, bot, telegram, config }) {
    Object.assign(this, { store, monitoring, notifications, bot, telegram, config })
    this.owner = randomUUID()
    this.controller = new AbortController()
    this.lastTick = null
    this.lastError = null
    this.pollTask = null
    this.loopTask = null
    this.heartbeat = null
    this.lastMaintenance = 0
  }
  async start() {
    if (!this.store.claimLease(this.owner)) throw new Error('Эта база уже обслуживается другим процессом PulseDesk (lease: до 60 сек.)')
    this.heartbeat = setInterval(() => {
      try {
        if (!this.store.claimLease(this.owner)) { this.lastError = 'LEASE_LOST'; this.controller.abort() }
      } catch { this.lastError = 'LEASE_FAILED'; this.controller.abort() }
    }, 10000)
    this.store.maintenance()
    this.lastMaintenance = Date.now()
    if (this.config.mode === 'polling') {
      await this.telegram.call('deleteWebhook', { drop_pending_updates: false })
      this.pollTask = this.poll()
    }
    if (this.config.mode === 'webhook') {
      await this.telegram.call('setWebhook', { url: `${this.config.origin}/telegram/webhook`, secret_token: this.config.webhookSecret, allowed_updates: ['message', 'callback_query'] })
    }
    this.loopTask = this.loop()
  }
  async tick() {
    if (!this.store.claimLease(this.owner)) throw new Error('Потеряна блокировка процесса')
    if (Date.now() - this.lastMaintenance > 3600000) { this.store.maintenance(); this.lastMaintenance = Date.now() }
    for (let n = 0; n < 10; n++) {
      const update = this.store.nextUpdate()
      if (!update) break
      try { await this.bot.handle(update); this.store.finishUpdate(update.update_id) } catch { this.store.failUpdate(update.update_id) }
    }
    await this.monitoring.due()
    await this.notifications.drain()
    this.lastTick = Date.now()
    this.lastError = null
  }
  async loop() {
    while (!this.controller.signal.aborted) {
      try { await this.tick() } catch { this.lastError = 'BACKGROUND_TASK_FAILED' }
      await delay(this.config.tickMs, undefined, { signal: this.controller.signal }).catch(() => {})
    }
  }
  async poll() {
    while (!this.controller.signal.aborted) {
      try {
        const updates = await this.telegram.call('getUpdates', { offset: this.store.offset(), timeout: 25, limit: 25, allowed_updates: ['message', 'callback_query'] }, this.controller.signal)
        if (!Array.isArray(updates)) throw new Error('INVALID_UPDATES')
        for (const update of updates) this.store.acceptUpdate(update)
        if (!updates.length) await delay(250, undefined, { signal: this.controller.signal }).catch(() => {})
      } catch {
        if (!this.controller.signal.aborted) await delay(3000, undefined, { signal: this.controller.signal }).catch(() => {})
      }
    }
  }
  healthy() { return this.lastTick !== null && Date.now() - this.lastTick < 45000 && !this.lastError }
  async stop() {
    clearInterval(this.heartbeat)
    this.monitoring.stop()
    this.controller.abort()
    await Promise.allSettled([this.pollTask, this.loopTask].filter(Boolean))
    this.store.releaseLease(this.owner)
  }
}

module.exports = { Runtime }
