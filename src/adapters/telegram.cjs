'use strict'

class TelegramError extends Error {
  constructor(code, retryAfter = 0) {
    super(`Telegram: ${code}`)
    this.code = String(code)
    this.retryAfter = Number(retryAfter) || 0
  }
}

class TelegramTransport {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher }
  async call(method, payload = {}, signal) {
    let response
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(12000),
      })
    } catch { throw new TelegramError('NETWORK_ERROR') }
    let body
    try { body = await response.json() } catch { throw new TelegramError('INVALID_RESPONSE') }
    if (!response.ok || !body?.ok) throw new TelegramError(body?.error_code || response.status, body?.parameters?.retry_after)
    return body.result
  }
  sendMessage(chatId, text, options = {}) { return this.call('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), ...options }) }
}

class DemoTelegramTransport {
  constructor(store) { this.store = store }
  async call(method) { if (method === 'getUpdates') return []; return true }
  async sendMessage(_chatId, text) { this.store.addDemoMessage('out', text); return { message_id: this.store.demoMessages().at(-1).id } }
}

module.exports = { TelegramTransport, DemoTelegramTransport, TelegramError }
