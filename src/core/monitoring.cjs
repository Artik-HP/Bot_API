'use strict'

class MonitoringService {
  constructor({ store, registry, transport, config, ai = null, now = Date.now }) {
    Object.assign(this, { store, registry, transport, config, ai, now })
    this.running = new Map()
    this.observers = []
    this.controller = new AbortController()
  }
  observe(listener) { this.observers.push(listener) }
  add(input) {
    if (this.config.mode === 'demo') throw new Error('В демо используются тестовые сервисы. Реальные адреса добавляются в рабочем режиме.')
    if (this.store.listMonitors().length >= this.config.maxMonitors) throw new Error('Достигнут лимит проверок')
    const monitor = this.registry.create(input, this.config.intervalSeconds)
    try { return this.store.addMonitor(monitor, this.now()) } catch (error) {
      if (error.code?.startsWith('ERR_SQLITE')) throw new Error('Такая проверка уже добавлена')
      throw error
    }
  }
  async run(id) {
    if (this.controller.signal.aborted) return null
    if (this.running.has(id)) return this.running.get(id)
    const task = this.execute(id)
    this.running.set(id, task)
    try { return await task } finally { this.running.delete(id) }
  }
  async execute(id) {
    const monitor = this.store.getMonitor(id)
    if (!monitor) throw new Error('Проверка не найдена')
    if (!monitor.enabled) throw new Error('Проверка на паузе')
    let result
    try { result = await this.registry.get(monitor.kind).check(monitor, { transport: this.transport, now: this.now, signal: this.controller.signal, ai: this.ai }) } catch (error) {
      if (this.controller.signal.aborted) return null
      result = { healthy: false, latencyMs: null, summary: safeProbeError(error) }
    }
    if (this.controller.signal.aborted) return null
    if (typeof result?.healthy !== 'boolean' || typeof result?.summary !== 'string') throw new Error('Модуль вернул некорректный результат')
    const outcome = this.store.recordCheck(id, result, this.config.failureThreshold, this.now())
    // Observers enrich a committed transition; their failure must not undo or fail the check itself.
    if (outcome.transition) for (const listener of this.observers) { try { listener({ ...outcome, result }) } catch {} }
    return outcome
  }
  async due() {
    const due = this.store.listMonitors().filter(monitor => monitor.enabled && monitor.next_due <= this.now()).sort((a, b) => a.next_due - b.next_due).slice(0, 3)
    // Sequential probes bound sockets and memory even when every target is unavailable.
    for (const monitor of due) { if (this.controller.signal.aborted) break; await this.run(monitor.id) }
  }
  stop() { this.controller.abort() }
  overview() {
    const monitors = this.store.listMonitors().map(monitor => ({ ...monitor, history: this.store.history(monitor.id) }))
    const incidents = this.store.incidents()
    const checks = monitors.flatMap(monitor => monitor.history)
    const successful = checks.filter(check => check.healthy).length
    const latencies = checks.map(check => check.latency_ms).filter(Number.isFinite)
    return {
      product: 'PulseDesk', mode: this.config.mode, timestamp: this.now(),
      monitors, incidents, modules: this.registry.list(), deliveries: this.store.deliveries(),
      metrics: { monitors: monitors.length, active: monitors.filter(m => m.enabled).length,
        up: monitors.filter(m => m.enabled && m.status === 'up').length,
        openIncidents: incidents.filter(i => !i.resolved_at).length,
        uptime: checks.length ? Number((successful / checks.length * 100).toFixed(2)) : null,
        averageLatency: latencies.length ? Math.round(latencies.reduce((sum, n) => sum + n, 0) / latencies.length) : null,
        samples: checks.length },
      demoMessages: this.config.mode === 'demo' ? this.store.demoMessages() : [],
    }
  }
}

function safeProbeError(error) {
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) return 'DNS: адрес не найден'
  if (['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) return 'Сайт не принял соединение'
  if (error.code?.includes('CERT') || error.code?.includes('TLS')) return 'TLS: ошибка проверки сертификата'
  const message = String(error.message || '')
  if (/приватн|служебн|запрещ|Превышено|превышает/.test(message)) return message.slice(0, 180)
  return 'Не удалось выполнить сетевую проверку'
}

module.exports = { MonitoringService }
