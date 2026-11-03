'use strict'

class AiError extends Error {
  constructor(code, status = 0) {
    super(`AI: ${code}`)
    this.code = String(code)
    this.status = status
  }
}

const messages = {
  AI_DISABLED: 'AI не подключён: укажи PULSE_OPENROUTER_API_KEY',
  BUDGET: 'дневной лимит AI-запросов исчерпан',
  UNAUTHORIZED: 'OpenRouter отклонил ключ',
  NO_CREDITS: 'на балансе OpenRouter закончились средства',
  RATE_LIMITED: 'OpenRouter просит подождать',
  TIMEOUT: 'модель не ответила вовремя',
  OUTPUT_LIMIT: 'ответ модели не поместился в лимит токенов',
  PROVIDER_ERROR: 'провайдер модели временно недоступен',
}

function describeAiError(error) { return messages[error?.code] || 'не удалось получить ответ модели' }

function errorCode(status, payload) {
  if (status === 401 || status === 403) return 'UNAUTHORIZED'
  if (status === 402) return 'NO_CREDITS'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 408 || status === 504) return 'TIMEOUT'
  if (status >= 500 || payload?.error) return 'PROVIDER_ERROR'
  return `HTTP_${status}`
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : part?.text || '').join('')
  return ''
}

class OpenRouterClient {
  constructor({ apiKey, model, baseUrl, timeoutMs, maxTokens, reasoning }, fetcher = fetch) {
    Object.assign(this, { apiKey, model, baseUrl, timeoutMs, maxTokens, reasoning, fetcher })
  }
  async complete({ system, user, schema, maxTokens, signal }) {
    const body = {
      model: this.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens || this.maxTokens,
      usage: { include: true },
      ...(this.reasoning === 'none' ? {} : { reasoning: { effort: this.reasoning, exclude: true } }),
      ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } } } : {}),
    }
    const timeout = AbortSignal.timeout(this.timeoutMs)
    let response
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'x-title': 'PulseDesk' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
    } catch { throw new AiError(signal?.aborted ? 'ABORTED' : timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR') }
    let payload
    try { payload = await response.json() } catch { throw new AiError('INVALID_RESPONSE', response.status) }
    // Provider messages are never forwarded: they may echo request details back.
    if (!response.ok || payload?.error) throw new AiError(errorCode(response.status, payload), response.status)
    const choice = payload.choices?.[0]
    const text = extractText(choice?.message?.content).trim()
    if (!text) throw new AiError(choice?.finish_reason === 'length' ? 'OUTPUT_LIMIT' : 'EMPTY_RESPONSE')
    let data = null
    if (schema) { try { data = JSON.parse(text) } catch { throw new AiError(choice?.finish_reason === 'length' ? 'OUTPUT_LIMIT' : 'INVALID_JSON') } }
    const usage = payload.usage || {}
    return {
      text, data, model: payload.model || this.model,
      usage: { prompt: usage.prompt_tokens || 0, completion: usage.completion_tokens || 0, cost: Number(usage.cost) || 0 },
    }
  }
}

module.exports = { OpenRouterClient, AiError, describeAiError }
