'use strict'
const { validateUrl } = require('../../core/network.cjs')
const { pageText } = require('../../ai/text.cjs')
const { fields } = require('../fields.cjs')

module.exports = {
  id: 'http', title: 'Доступность', icon: 'activity', command: '/web',
  description: 'HTTP-статус и время ответа. Два сбоя подряд открывают инцидент.',
  fields: [{ key: 'target', label: 'HTTPS-адрес', placeholder: 'https://example.com', required: true }],
  fromCommand(args) { const [target, name] = fields(args); return { target, name: name || 'Сайт' } },
  validate(input) { return { target: validateUrl(input.target).href, config: {} } },
  async check(monitor, context) {
    const result = await context.transport.http(monitor.target, { signal: context.signal })
    return { healthy: result.status >= 200 && result.status < 400, latencyMs: result.latencyMs, summary: `HTTP ${result.status}`, meta: { status: result.status }, evidence: { excerpt: pageText(result.text, 1500) } }
  },
}
