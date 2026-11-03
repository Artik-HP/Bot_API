'use strict'
const { validateUrl } = require('../../core/network.cjs')
const { pageText } = require('../../ai/text.cjs')
const { describeAiError } = require('../../ai/openrouter.cjs')
const { fields } = require('../fields.cjs')

module.exports = {
  id: 'ai-page', title: 'AI-проверка смысла', icon: 'sparkles', command: '/ai',
  description: 'Модель читает страницу и проверяет условие простыми словами: «указаны цены и есть форма заявки». Повторно спрашивает AI, только когда текст изменился.',
  fields: [{ key: 'target', label: 'HTTPS-адрес', placeholder: 'https://example.com/pricing', required: true }, { key: 'expectation', label: 'Что должно быть на странице', placeholder: 'Указаны цены в рублях и есть кнопка заявки', required: true }],
  fromCommand(args) { const [target, expectation, name] = fields(args); return { target, name: name || 'AI-проверка', config: { expectation } } },
  validate(input) {
    const expectation = input.config?.expectation
    if (typeof expectation !== 'string' || expectation.trim().length < 5 || expectation.length > 300) throw new Error('Условие для AI: от 5 до 300 символов')
    return { target: validateUrl(input.target).href, config: { expectation: expectation.trim() } }
  },
  async check(monitor, context) {
    const page = await context.transport.http(monitor.target, { signal: context.signal })
    const base = { latencyMs: page.latencyMs, meta: { status: page.status } }
    if (page.status < 200 || page.status >= 300) return { ...base, healthy: false, summary: `HTTP ${page.status}: страница недоступна` }
    const text = pageText(page.text)
    if (!text) return { ...base, healthy: false, summary: 'Страница пустая: проверять нечего' }
    const evidence = { excerpt: text.slice(0, 1500) }
    // Without a model the check degrades to availability instead of raising false alarms.
    if (!context.ai?.enabled) return { ...base, healthy: true, summary: 'HTTP 200 · AI не подключён, смысл не проверялся', evidence }
    let verdict
    try { verdict = await context.ai.judgePage({ monitorId: monitor.id, expectation: monitor.config.expectation, text, signal: context.signal }) } catch (error) {
      if (context.signal?.aborted) throw error
      return { ...base, healthy: true, summary: `HTTP 200 · AI не ответил (${describeAiError(error)}), проверен только ответ`, evidence }
    }
    return { ...base, healthy: verdict.ok, summary: `AI: ${verdict.ok ? 'условие выполнено' : 'условие нарушено'} — ${verdict.reason}`, meta: { ...base.meta, ai: verdict.cached ? 'cache' : 'model' }, evidence }
  },
}
