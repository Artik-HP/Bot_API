'use strict'

function formatNotification(item) {
  const payload = item.payload
  if (item.kind === 'message') return payload.text
  if (item.kind === 'analysis') return `🧠 AI-разбор: ${payload.monitorName}\n\n${payload.text}\n#${payload.incidentId.slice(0, 8)}`
  if (item.kind === 'resolved') {
    const seconds = Math.max(0, Math.round((payload.resolvedAt - payload.openedAt) / 1000))
    return `🟢 Восстановлено: ${payload.monitorName}\nСервис снова работает. Длительность инцидента: ${seconds} сек.\n#${payload.incidentId.slice(0, 8)}`
  }
  return `🔴 Инцидент: ${payload.monitorName}\n${payload.summary}\n#${payload.incidentId.slice(0, 8)}\nНажми «Беру в работу», чтобы подтвердить инцидент.`
}

class NotificationWorker {
  constructor(store, telegram) { this.store = store; this.telegram = telegram; this.busy = false }
  async drain(limit = 10) {
    if (this.busy) return
    this.busy = true
    try {
      for (let count = 0; count < limit; count++) {
        const item = this.store.claimDelivery()
        if (!item) break
        try {
          const options = item.kind === 'opened' ? { reply_markup: { inline_keyboard: [[{ text: '✋ Беру в работу', callback_data: `ack:${item.payload.incidentId}` }]] } }
            : item.kind === 'message' && item.payload.markup ? { reply_markup: item.payload.markup } : {}
          await this.telegram.sendMessage(item.chat_id, formatNotification(item), options)
          this.store.finishDelivery(item.id)
        } catch (error) { this.store.failDelivery(item, error.code || 'DELIVERY_ERROR', error.retryAfter) }
      }
    } finally { this.busy = false }
  }
}

module.exports = { NotificationWorker, formatNotification }
