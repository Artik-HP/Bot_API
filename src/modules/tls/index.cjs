'use strict'
const { validateUrl } = require('../../core/network.cjs')
const { fields } = require('../fields.cjs')

module.exports = {
  id: 'tls', title: 'SSL-сертификат', icon: 'shield', command: '/tls',
  description: 'Контролирует TLS-соединение и предупреждает до истечения сертификата.',
  fields: [{ key: 'target', label: 'HTTPS-адрес', placeholder: 'https://example.com', required: true }, { key: 'warningDays', label: 'Предупредить за, дней', placeholder: '14', type: 'number' }],
  fromCommand(args) { const [target, name] = fields(args); return { target, name: name || 'SSL-сертификат' } },
  validate(input) {
    const days = Number(input.config?.warningDays ?? 14)
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Порог сертификата: от 1 до 90 дней')
    return { target: validateUrl(input.target).origin, config: { warningDays: days } }
  },
  async check(monitor, context) {
    const result = await context.transport.tls(monitor.target, { signal: context.signal })
    const days = Math.floor((result.expiresAt - context.now()) / 86400000)
    return { healthy: days > monitor.config.warningDays, latencyMs: result.latencyMs, summary: `Сертификат: осталось ${days} дн.`, meta: { days, expiresAt: result.expiresAt } }
  },
}
