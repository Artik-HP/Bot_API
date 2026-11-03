'use strict'

const { randomUUID } = require('node:crypto')
const { AiError, describeAiError } = require('./openrouter.cjs')
const prompts = require('./prompts.cjs')
const { buildDigestData, formatDigest } = require('./digest.cjs')
const { pageText, fingerprint, clip } = require('./text.cjs')

const dayOf = now => new Date(now).toISOString().slice(0, 10)
const moduleNames = { http: 'доступность', content: 'контроль фразы', tls: 'SSL-сертификат', 'ai-page': 'AI-проверка смысла' }

// Monitoring work may spend the whole daily limit; on-demand requests stop at 80%,
// so a burst of /ask or /scan cannot leave a real outage without an explanation.
const monitoringKinds = new Set(['incident', 'page'])
function allowCall({ kind, usage, limit }) {
  if (usage.calls >= limit) return false
  return monitoringKinds.has(kind) || usage.calls < Math.ceil(limit * 0.8)
}

function localParts(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(now).map(part => [part.type, part.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) }
}

function shiftDate(date, days) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

// The most recent local time the digest was due: daily at `hour`, weekly on Monday at `hour`.
function digestSlot(now, { mode, hour, timezone }) {
  const local = localParts(now, timezone)
  const passed = local.hour >= hour
  const day = passed ? local.date : shiftDate(local.date, -1)
  if (mode === 'daily') return `daily:${day}`
  return `weekly:${shiftDate(day, -(passed ? local.weekday : (local.weekday + 6) % 7))}`
}

class AiService {
  constructor({ store, client = null, config, registry, transport, now = Date.now }) {
    Object.assign(this, { store, client, config, registry, transport, now })
    this.busy = false
  }
  get enabled() { return Boolean(this.client) }

  async call(kind, request, signal) {
    if (!this.client) throw new AiError('AI_DISABLED')
    const day = dayOf(this.now())
    if (!allowCall({ kind, usage: this.store.aiUsage(day), limit: this.config.ai.dailyLimit })) {
      this.store.recordAiSkip(day)
      throw new AiError('BUDGET')
    }
    const result = await this.client.complete({ ...request, signal })
    this.store.recordAiUsage(day, result.usage)
    return result
  }

  enqueue(kind, dedupeKey, payload) { return this.store.enqueueAiJob(kind, dedupeKey, payload, this.now()) }
  onTransition({ transition, incident, result }) {
    if (transition !== 'opened' || !this.enabled) return
    const excerpt = result?.evidence?.excerpt
    this.enqueue('incident', `incident:${incident.id}`, { incidentId: incident.id, evidence: excerpt ? { excerpt: clip(excerpt, 1500) } : null })
  }
  requestReport({ chatId = null, days = 7, broadcast = false, slot = null } = {}) {
    return this.enqueue('digest', slot ? `digest:${slot}` : `report:${chatId || 'panel'}:${randomUUID()}`, { chatId, days, broadcast })
  }
  requestAnswer(chatId, question) { return this.enqueue('ask', `ask:${chatId}:${randomUUID()}`, { chatId, question: clip(question, 500) }) }
  requestScan(chatId, target) { return this.enqueue('scan', `scan:${chatId}:${randomUUID()}`, { chatId, target }) }

  schedule() {
    const { digest = 'off', digestHour = 9 } = this.config.ai || {}
    if (digest === 'off') return
    const slot = digestSlot(this.now(), { mode: digest, hour: digestHour, timezone: this.config.timezone })
    const last = this.store.getSetting('digest:slot')
    if (last === slot) return
    this.store.transaction(() => {
      // The first start only remembers the slot: a restart must not send a report that is already late.
      if (last !== null) this.requestReport({ days: digest === 'daily' ? 1 : 7, broadcast: true, slot })
      this.store.setSetting('digest:slot', slot)
    })
  }

  async drain(limit = 3, signal) {
    if (this.busy) return
    this.busy = true
    try {
      for (let count = 0; count < limit && !signal?.aborted; count++) {
        const job = this.store.claimAiJob(this.now())
        if (!job) break
        try { this.store.finishAiJob(job.id, await this.handle(job, signal), this.now()) } catch (error) {
          if (signal?.aborted) { this.store.releaseAiJob(job.id); break }
          const final = ['AI_DISABLED', 'BUDGET'].includes(error.code)
          if (final) this.store.skipAiJob(job.id, error.code, this.now())
          else this.store.failAiJob(job, error.code || 'AI_JOB_FAILED', this.now())
          if ((final || job.attempts >= 3) && job.payload.chatId && ['ask', 'scan'].includes(job.kind)) {
            this.reply(job, { title: 'AI', summary: 'Запрос не выполнен', text: `🧠 Не получилось: ${describeAiError(error)}.` })
          }
        }
      }
    } finally { this.busy = false }
  }
  handle(job, signal) {
    if (job.kind === 'incident') return this.analyzeIncident(job.payload, signal)
    if (job.kind === 'digest') return this.digest(job, signal)
    if (job.kind === 'ask') return this.answer(job, signal)
    if (job.kind === 'scan') return this.scan(job, signal)
    throw new AiError('UNKNOWN_JOB')
  }
  reply(job, payload) { this.store.enqueueMessage(job.payload.chatId, `job:${job.id}:${job.payload.chatId}`, 'message', payload, this.now()) }

  async analyzeIncident({ incidentId, evidence }, signal) {
    const incident = this.store.getIncident(incidentId)
    if (!incident) return { text: 'Инцидент уже удалён' }
    const monitor = this.store.getMonitor(incident.monitor_id)
    const { data, model } = await this.call('incident', prompts.incident({ monitor, incident, history: this.store.history(monitor.id, 12), evidence, timezone: this.config.timezone }), signal)
    const analysis = {
      summary: clip(data.summary, 300), cause: clip(data.cause, 400),
      steps: (Array.isArray(data.steps) ? data.steps : []).slice(0, 4).map(step => clip(step, 200)).filter(Boolean),
      severity: ['high', 'medium', 'low'].includes(data.severity) ? data.severity : 'medium', model, createdAt: this.now(),
    }
    const text = prompts.formatAnalysis(analysis)
    this.store.transaction(() => {
      this.store.setIncidentAnalysis(incident.id, analysis)
      this.store.broadcast('analysis', `${incident.id}:analysis`, { incidentId: incident.id, monitorName: monitor.name, summary: analysis.summary, text }, this.now())
    })
    return { text }
  }

  async judgePage({ monitorId, expectation, text, signal }) {
    const exact = `page:${monitorId}:${fingerprint(`${expectation}\n${text}`)}`
    const cached = this.store.aiCacheGet(exact)
    if (cached) return { ...cached, cached: true }
    // Pages with clocks or counters change on every fetch; the pause keeps them from calling the model each minute.
    const last = this.store.aiCacheGet(`page:${monitorId}:last`)
    if (last && this.now() - last.at < this.config.ai.pageRecheckMinutes * 60000) return { ...last.verdict, cached: true }
    const { data } = await this.call('page', prompts.page({ expectation, text }), signal)
    const verdict = { ok: data.ok === true, reason: clip(data.reason, 200) }
    this.store.aiCacheSet(exact, verdict, this.now())
    this.store.aiCacheSet(`page:${monitorId}:last`, { at: this.now(), verdict }, this.now())
    return verdict
  }

  async digest(job, signal) {
    const { chatId, days = 7, broadcast } = job.payload
    const data = buildDigestData(this.store, { now: this.now(), days, timezone: this.config.timezone })
    let text = formatDigest(data)
    let source = 'template'
    if (this.enabled) {
      try {
        text = `📊 PulseDesk · AI-отчёт за ${days} дн.\n\n${(await this.call('digest', prompts.digest(data), signal)).text}`
        source = 'ai'
      } catch (error) {
        if (signal?.aborted) throw error
        text = `${text}\n\n(AI-сводка недоступна: ${describeAiError(error)})`
      }
    }
    const payload = { title: `Отчёт за ${days} дн.`, summary: data.totals.incidents ? `Инцидентов: ${data.totals.incidents}` : 'Без инцидентов', text: clip(text, 3900) }
    if (broadcast) this.store.broadcast('message', `job:${job.id}`, payload, this.now())
    else if (chatId) this.reply(job, payload)
    this.store.setSetting('ai:lastReport', { text, source, days, createdAt: this.now() })
    return { text: clip(text, 600), source }
  }

  snapshot() {
    const now = this.now()
    const iso = value => prompts.localTime(value, this.config.timezone)
    return {
      now: iso(now), timezone: this.config.timezone,
      monitors: this.store.listMonitors().map(monitor => ({
        id: monitor.id.slice(0, 8), name: monitor.name, kind: monitor.kind, target: monitor.target, enabled: monitor.enabled,
        status: monitor.status, summary: monitor.summary, latencyMs: monitor.latency_ms, lastChecked: iso(monitor.last_checked),
        recent: this.store.history(monitor.id, 6).map(check => ({ at: iso(check.checked_at), ok: Boolean(check.healthy), ms: check.latency_ms })),
      })),
      incidents: this.store.incidents(10).map(incident => ({
        monitor: incident.monitor_name, openedAt: iso(incident.opened_at), resolvedAt: iso(incident.resolved_at),
        acknowledged: Boolean(incident.acknowledged_at), summary: incident.summary, cause: incident.analysis?.cause || null,
      })),
      week: buildDigestData(this.store, { now, days: 7, timezone: this.config.timezone }).monitors,
    }
  }
  async answer(job, signal) {
    const { text } = await this.call('ask', prompts.ask({ question: job.payload.question, context: this.snapshot() }), signal)
    this.reply(job, { title: 'Ответ AI', summary: clip(job.payload.question, 120), text: `🧠 ${clip(text, 3800)}` })
    return { text: clip(text, 600) }
  }

  async scan(job, signal) {
    const { target } = job.payload
    let page
    try { page = await this.transport.http(target, { signal }) } catch (error) {
      if (signal?.aborted) throw error
      this.reply(job, { title: 'AI-подбор проверок', summary: target, text: '🔎 Не удалось открыть страницу. Проверь адрес: нужен публичный HTTPS без редиректа.' })
      return { text: 'Страница не открылась' }
    }
    const text = pageText(page.text, 6000)
    const { data } = await this.call('scan', prompts.scan({ target, status: page.status, text }), signal)
    const suggestions = []
    for (const item of (Array.isArray(data.suggestions) ? data.suggestions : []).slice(0, 5)) {
      const value = clip(item.value, 160)
      const input = { kind: item.kind, name: clip(item.name, 40) || 'Проверка', target, config: item.kind === 'content' ? { text: value } : item.kind === 'ai-page' ? { expectation: value } : {} }
      // A phrase the model did not copy from the page would open an incident on the first check.
      if (item.kind === 'content' && !text.includes(value)) continue
      try { this.registry.create(input) } catch { continue }
      suggestions.push({ ...input, why: clip(item.why, 120) })
    }
    const id = fingerprint(job.id).slice(0, 8)
    this.store.aiCacheSet(`scan:${id}`, { target, suggestions }, this.now())
    const demo = this.config.mode === 'demo'
    const lines = [`🔎 ${clip(data.summary, 200)}`, '']
    suggestions.forEach((item, index) => lines.push(`${index + 1}. ${item.name} — ${moduleNames[item.kind]}${item.config.text ? `: «${item.config.text}»` : item.config.expectation ? `: ${item.config.expectation}` : ''}\n   ${item.why}`))
    if (!suggestions.length) lines.push('Модель не предложила проверок, которые проходят валидацию модулей.')
    else lines.push('', demo ? 'В демо добавление отключено. В рабочем режиме здесь будут кнопки «＋».' : 'Нажми «＋ номер», чтобы поставить проверку на радар.')
    const markup = suggestions.length && !demo ? { inline_keyboard: [suggestions.map((_, index) => ({ text: `＋ ${index + 1}`, callback_data: `scan:${id}:${index}` }))] } : null
    this.reply(job, { title: 'AI-подбор проверок', summary: target, text: lines.join('\n'), markup })
    return { text: `${suggestions.length} предложений для ${target}` }
  }

  overview() {
    const usage = this.store.aiUsage(dayOf(this.now()))
    const label = job => job.kind === 'ask' ? job.payload.question : job.kind === 'scan' ? job.payload.target
      : job.kind === 'digest' ? `Отчёт за ${job.payload.days} дн.` : 'Разбор инцидента'
    return {
      enabled: this.enabled, model: this.config.ai.model, reasoning: this.config.ai.reasoning, limit: this.config.ai.dailyLimit,
      digest: this.config.ai.digest, digestHour: this.config.ai.digestHour,
      usage: { calls: usage.calls, skipped: usage.skipped, tokens: usage.prompt_tokens + usage.completion_tokens, cost: Math.round(usage.cost * 10000) / 10000 },
      jobs: this.store.aiJobs(12).map(job => ({
        id: job.id, kind: job.kind, state: job.state, error: job.error, created_at: job.created_at, finished_at: job.finished_at,
        label: clip(label(job), 90), incidentId: job.payload.incidentId || null, result: job.result?.text ? clip(job.result.text, 400) : null,
      })),
      lastReport: this.store.getSetting('ai:lastReport'),
    }
  }
}

module.exports = { AiService, allowCall, digestSlot }
