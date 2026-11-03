'use strict'

const { validateUrl } = require('../core/network.cjs')

const menu = { reply_markup: { inline_keyboard: [[{ text: '◉ Статус', callback_data: 'status' }, { text: '⚡ Инциденты', callback_data: 'incidents' }]] } }

class BotRouter {
  constructor({ store, monitoring, registry, telegram, config, ai = null }) {
    Object.assign(this, { store, monitoring, registry, telegram, config, ai })
    this.lastManualCheck = new Map()
    this.lastAiRequest = new Map()
  }
  throttle(chatId) {
    if ((this.lastAiRequest.get(chatId) || 0) + 15000 > Date.now()) throw new Error('AI-запросы — не чаще раза в 15 секунд')
    this.lastAiRequest.set(chatId, Date.now())
  }
  requireAi(chatId) {
    if (!this.ai?.enabled) throw new Error('AI не подключён: укажи PULSE_OPENROUTER_API_KEY в .env.pulsedesk')
    this.throttle(chatId)
  }
  addSuggestion(id, index) {
    const item = this.store.aiCacheGet(`scan:${id}`)?.suggestions?.[index]
    if (!item) return 'Предложение устарело: запусти /scan ещё раз'
    try {
      const monitor = this.monitoring.add({ kind: item.kind, name: item.name, target: item.target, config: item.config })
      return `✓ Добавлено: ${monitor.name} · ${monitor.id.slice(0, 8)}`
    } catch (error) { return `Не получилось: ${error.message}` }
  }
  allowed(userId) { return this.config.mode === 'demo' ? String(userId) === '900001' : this.config.allowedUsers.has(String(userId)) }
  async handle(update) {
    const callback = update.callback_query
    const message = callback?.message || update.message
    const from = callback?.from || message?.from
    if (!message || !from || message.chat?.type !== 'private' || String(message.chat.id) !== String(from.id)) return
    if (!this.allowed(from.id)) return
    const chatId = String(message.chat.id)
    if (callback) {
      let text = 'Действие недоступно'
      if (callback.data === 'status') { await this.status(chatId); text = 'Статус обновлён' }
      if (callback.data === 'incidents') { await this.incidents(chatId); text = 'Инциденты загружены' }
      const match = /^ack:([a-f0-9-]{36})$/.exec(callback.data || '')
      if (match) text = this.store.acknowledge(match[1], from.id) ? 'Инцидент принят в работу' : 'Уже принят или закрыт'
      const suggestion = /^scan:([a-f0-9]{8}):([0-4])$/.exec(callback.data || '')
      if (suggestion) text = this.addSuggestion(suggestion[1], Number(suggestion[2]))
      await this.telegram.call('answerCallbackQuery', { callback_query_id: callback.id, text: text.slice(0, 190) })
      if (match || suggestion) await this.telegram.sendMessage(chatId, text, menu)
      return
    }
    if (typeof message.text !== 'string' || message.text.length > 1500) return
    const match = /^\/([a-z]+)(?:@[\w]+)?(?:\s+([\s\S]*))?$/i.exec(message.text.trim())
    if (!match) { await this.help(chatId); return }
    const command = `/${match[1].toLowerCase()}`
    const args = (match[2] || '').trim()
    try {
      if (command === '/start') {
        this.store.subscribe(chatId)
        await this.telegram.sendMessage(chatId, `👋 Это PulseDesk. Я слежу за сайтами, контентом и SSL и сообщаю о сбоях и восстановлении.${this.ai?.enabled ? '\nAI-ассистент объясняет сбои, пишет отчёты и отвечает на /ask.' : ''}\n\nУведомления включены. /help — команды, /unsubscribe — отключить.`, menu)
      } else if (command === '/help') await this.help(chatId)
      else if (command === '/status') await this.status(chatId)
      else if (command === '/incidents') await this.incidents(chatId)
      else if (command === '/subscribe') { this.store.subscribe(chatId); await this.telegram.sendMessage(chatId, '🔔 Уведомления включены', menu) }
      else if (command === '/unsubscribe') { this.store.unsubscribe(chatId); await this.telegram.sendMessage(chatId, '🔕 Уведомления отключены', menu) }
      else if (command === '/pause' || command === '/resume') {
        const monitor = this.findMonitor(args)
        this.store.setEnabled(monitor.id, command === '/resume')
        await this.telegram.sendMessage(chatId, `${command === '/pause' ? '⏸ Пауза' : '▶ Проверка включена'}: ${monitor.name}`, menu)
      } else if (command === '/check') {
        const monitor = this.findMonitor(args)
        if ((this.lastManualCheck.get(chatId) || 0) + 10000 > Date.now()) throw new Error('Ручная проверка доступна раз в 10 секунд')
        this.lastManualCheck.set(chatId, Date.now())
        await this.monitoring.run(monitor.id)
        await this.status(chatId)
      } else if (command === '/ask') {
        if (!args) throw new Error('Напиши вопрос после команды, например: /ask что сегодня падало?')
        this.requireAi(chatId)
        this.ai.requestAnswer(chatId, args)
        await this.telegram.sendMessage(chatId, '🧠 Думаю над вопросом. Ответ придёт отдельным сообщением.', menu)
      } else if (command === '/scan') {
        const target = validateUrl(args).href
        this.requireAi(chatId)
        this.ai.requestScan(chatId, target)
        await this.telegram.sendMessage(chatId, `🔎 Изучаю ${target} и подбираю проверки…`, menu)
      } else if (command === '/report') {
        const days = args ? Number(args) : 7
        if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('Период отчёта: от 1 до 30 дней, например /report 7')
        if (!this.ai) throw new Error('Отчёты недоступны')
        this.throttle(chatId)
        this.ai.requestReport({ chatId, days })
        await this.telegram.sendMessage(chatId, this.ai.enabled ? `🧠 Готовлю AI-отчёт за ${days} дн.…` : `📊 Готовлю отчёт за ${days} дн.…`, menu)
      } else {
        const plugin = [...this.registry.items.values()].find(item => item.command === command && item.fromCommand)
        if (!plugin) { await this.help(chatId); return }
        const monitor = this.monitoring.add({ kind: plugin.id, ...plugin.fromCommand(args) })
        await this.telegram.sendMessage(chatId, `✓ Добавлено: ${monitor.name}\nID: ${monitor.id.slice(0, 8)}\n${monitor.target}`, menu)
      }
    } catch (error) { await this.telegram.sendMessage(chatId, `Не получилось: ${error.message}`, menu) }
  }
  findMonitor(value) {
    const matches = this.store.listMonitors().filter(m => m.id === value || value.length >= 6 && m.id.startsWith(value))
    if (matches.length !== 1) throw new Error('Укажи уникальный ID проверки из /status (минимум 6 символов)')
    return matches[0]
  }
  async status(chatId) {
    const monitors = this.store.listMonitors()
    const lines = monitors.map(m => `${!m.enabled ? '⏸' : m.status === 'up' ? '🟢' : m.status === 'down' ? '🔴' : '⚪'} ${m.name}\n${m.summary || 'Ожидает первой проверки'} · ${m.id.slice(0, 8)}`)
    await this.telegram.sendMessage(chatId, `📡 PulseDesk / состояние\n\n${lines.join('\n\n') || 'Пока нет проверок. /help — как добавить.'}`, menu)
  }
  async incidents(chatId) {
    const active = this.store.incidents().filter(i => !i.resolved_at)
    if (!active.length) { await this.telegram.sendMessage(chatId, '🟢 Открытых инцидентов нет', menu); return }
    for (const incident of active.slice(0, 5)) {
      await this.telegram.sendMessage(chatId, `🔴 ${incident.monitor_name}\n${incident.summary}${incident.analysis ? `\n🧠 ${incident.analysis.cause}` : ''}\n${incident.acknowledged_at ? '✓ Принят в работу' : 'Ожидает подтверждения'}`, { reply_markup: { inline_keyboard: [[{ text: '✋ Беру в работу', callback_data: `ack:${incident.id}` }]] } })
    }
  }
  async help(chatId) {
    const modules = [...this.registry.items.values()].map(plugin => `${plugin.command} — ${plugin.title}`).join('\n')
    const ai = `AI-ассистент${this.ai?.enabled ? '' : ' (выключен: нет PULSE_OPENROUTER_API_KEY)'}:\n/ask <вопрос> — спросить о состоянии сервисов\n/report [дней] — отчёт за период\n/scan <адрес> — подобрать проверки для страницы`
    await this.telegram.sendMessage(chatId, `PulseDesk — контроль сайтов и инцидентов\n\n/status — состояние и ID проверок\n/incidents — открытые инциденты\n/check <ID> — проверить сейчас\n/pause <ID> · /resume <ID>\n/subscribe · /unsubscribe\n\nМодули:\n${modules}\n\n${ai}\n\nПримеры:\n/web https://example.com | Мой сайт\n/watch https://example.com | Оставить заявку | Форма\n/tls https://example.com | SSL сайта\n/ai https://example.com/pricing | Указаны цены и есть форма заявки | Прайс\n\n${this.config.mode === 'demo' ? 'ДЕМО: используются тестовые сервисы и тестовая доставка.' : 'Добавлять проверки могут только разрешённые пользователи.'}`, menu)
  }
}

module.exports = { BotRouter }
