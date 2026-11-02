'use strict'

const dns = require('node:dns/promises')
const https = require('node:https')
const tls = require('node:tls')
const net = require('node:net')
const { performance } = require('node:perf_hooks')

const blocked = new net.BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4')
const globalV6 = new net.BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
const blockedV6 = new net.BlockList()
blockedV6.addSubnet('2001::', 23, 'ipv6')
blockedV6.addSubnet('2001:db8::', 32, 'ipv6')
blockedV6.addSubnet('2002::', 16, 'ipv6')

function isPublicIp(address) {
  const family = net.isIP(address)
  if (family === 4) return !blocked.check(address, 'ipv4')
  if (family === 6) return globalV6.check(address, 'ipv6') && !blockedV6.check(address, 'ipv6')
  return false
}

function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 1000) throw new Error('Нужен HTTPS-адрес длиной до 1000 символов')
  let url
  try { url = new URL(value) } catch { throw new Error('Некорректный адрес сайта') }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash) {
    throw new Error('Разрешён публичный HTTPS на порту 443, без пароля, query-параметров и #')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' || !host.includes('.') && !net.isIP(host) || host.endsWith('.local') || host.endsWith('.localhost')) throw new Error('Локальные адреса запрещены')
  if (net.isIP(host) && !isPublicIp(host)) throw new Error('Приватные и служебные IP запрещены')
  return url
}

async function resolvePublic(value, lookup = dns.lookup) {
  const url = validateUrl(value)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let timer
  let records
  try {
    records = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Превышено время DNS-проверки')), 3000) }),
    ])
  } finally { clearTimeout(timer) }
  if (!records.length || records.some(record => !isPublicIp(record.address))) throw new Error('DNS вернул приватный или служебный IP')
  return { url, host, record: records.find(record => record.family === 4) || records[0] }
}

function pinnedLookup(record) {
  return (_hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {} }
    if (options?.all) callback(null, [record])
    else callback(null, record.address, record.family)
  }
}

async function inspectHttp(target, { timeoutMs = 7000, maxBytes = 512 * 1024, signal } = {}) {
  const started = performance.now()
  const { url, record } = await resolvePublic(target)
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET', lookup: pinnedLookup(record), agent: false, signal,
      headers: { 'user-agent': 'PulseDesk/0.1 (+uptime-monitor)', 'accept-encoding': 'identity' },
    }, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) { request.destroy(new Error('Ответ сайта превышает 512 КБ')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        clearTimeout(timer)
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8'), latencyMs: Math.round(performance.now() - started) })
      })
    })
    const timer = setTimeout(() => request.destroy(new Error('Превышено время проверки (7 секунд)')), timeoutMs)
    request.on('error', error => { clearTimeout(timer); reject(error) })
    request.end()
  })
}

async function inspectTls(target, { timeoutMs = 7000, signal } = {}) {
  const { host, record } = await resolvePublic(target)
  if (signal?.aborted) throw new Error('Проверка остановлена')
  const started = performance.now()
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: net.isIP(host) ? undefined : host, lookup: pinnedLookup(record), rejectUnauthorized: true }, () => {
      const certificate = socket.getPeerCertificate()
      clearTimeout(timer)
      socket.end()
      const expiresAt = Date.parse(certificate.valid_to)
      if (!Number.isFinite(expiresAt)) { reject(new Error('Сертификат не содержит срок действия')); return }
      resolve({ expiresAt, latencyMs: Math.round(performance.now() - started) })
    })
    const timer = setTimeout(() => socket.destroy(new Error('Превышено время TLS-проверки')), timeoutMs)
    const abort = () => socket.destroy(new Error('Проверка остановлена'))
    signal?.addEventListener('abort', abort, { once: true })
    socket.on('close', () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) })
    socket.on('error', error => { clearTimeout(timer); reject(error) })
  })
}

module.exports = { isPublicIp, validateUrl, resolvePublic, pinnedLookup, inspectHttp, inspectTls }
