'use strict'
const { createHash } = require('node:crypto')

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–' }

function entity(match, code) {
  if (code[0] !== '#') return entities[code.toLowerCase()] ?? match
  const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
  return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : ' '
}

// Visible text only: the model and the cache key must not depend on markup, scripts or comments.
function pageText(html, limit = 6000) {
  return String(html || '')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(br|p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer|main|nav|button|form)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d{1,7}|#x[\da-f]{1,6}|[a-z]{2,8});/gi, entity)
    .replace(/[ \t\f\v\r ]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim()
    .slice(0, limit)
}

function fingerprint(text) { return createHash('sha256').update(text).digest('hex').slice(0, 32) }

function clip(value, limit) {
  const text = String(value ?? '').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

module.exports = { pageText, fingerprint, clip }
