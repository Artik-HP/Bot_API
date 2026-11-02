'use strict'

const $ = selector => document.querySelector(selector)
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
const clock = value => value ? new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }).format(value) : '—'
const dateTime = value => value ? new Intl.DateTimeFormat('ru', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv' }).format(value) : '—'
let state = null
let filter = 'all'
let apiKey = ''
let toastTimer
let refreshing = false
let currentModuleList = []

function toast(message, error = false) {
  const element = $('#toast')
  element.textContent = message
  element.classList.toggle('error', error)
  element.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { element.hidden = true }, 4500)
}

async function api(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-pulsedesk': 'dashboard' }), ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const value = await response.json()
  if (!response.ok) throw Object.assign(new Error(value.error || 'Не удалось выполнить запрос'), { status: response.status })
  return value
}

async function action(button, path, payload, success) {
  button.disabled = true
  try { await api(path, payload); await refresh(); if (success) toast(success); return true } catch (error) { toast(error.message, true); return false } finally { button.disabled = false }
}

function navigate() {
  const view = location.hash.slice(1) || 'overview'
  const safe = ['overview', 'incidents', 'deliveries', 'modules'].includes(view) ? view : 'overview'
  const titles = { overview: ['Контрольная комната', 'Твои сервисы работают. Ты занимаешься своим делом.', 'Обзор'], incidents: ['Инциденты', 'Заметить. Подтвердить. Дождаться восстановления.', 'Инциденты'], deliveries: ['Доставка сообщений', 'Каждый сигнал сохраняется до отправки.', 'Доставка'], modules: ['Больше возможностей', 'Новая задача — новый модуль. Ядро остаётся общим.', 'Модули'] }
  const [title, description, crumb] = titles[safe]
  $('#page-title').textContent = `${title} /`
  $('#page-description').textContent = description
  $('#breadcrumb-current').textContent = crumb
  document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== safe })
  document.querySelectorAll('[data-nav]').forEach(link => { link.classList.toggle('active', link.dataset.nav === safe); if (link.dataset.nav === safe) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current') })
}

function monitorRows() {
  let monitors = state.monitors
  if (filter === 'issues') monitors = monitors.filter(m => m.enabled && (m.status === 'down' || m.failures > 0))
  if (!monitors.length) return `<div class="empty"><span class="empty-icon">◉</span><strong>${filter === 'issues' ? 'Всё спокойно' : 'Пока нет проверок'}</strong><p>${filter === 'issues' ? 'Проверки не обнаружили проблем.' : 'Добавь сайт через панель или Telegram-команду /web.'}</p></div>`
  return monitors.map(m => {
    const status = !m.enabled ? 'Пауза' : m.status === 'down' ? 'Сбой' : m.failures ? 'Проверяем' : m.status === 'up' ? 'В норме' : 'Ожидание'
    const icon = { http: '⌁', content: '▣', tls: '♧' }[m.kind] || '◇'
    const bars = m.history.slice(-15).map(check => `<i class="level-${Math.min(5, Math.max(1, Math.ceil((check.latency_ms || 30) / 120)))} ${check.healthy ? '' : 'failed'}"></i>`).join('')
    return `<div class="monitor-row"><span class="monitor-icon ${escapeHtml(m.kind)}">${icon}</span><div><strong class="monitor-name">${escapeHtml(m.name)}</strong><span class="monitor-target">${escapeHtml(m.target.replace('https://', ''))}</span></div><span class="monitor-status ${!m.enabled ? 'paused' : m.status === 'down' ? 'down' : ''}"><span class="online-dot"></span>${status}</span><span class="sparkbars" aria-hidden="true">${bars}</span><button class="monitor-action" data-monitor="${escapeHtml(m.id)}" data-operation="${m.enabled ? 'pause' : 'resume'}" title="${m.enabled ? 'Приостановить' : 'Возобновить'} проверку" aria-label="${m.enabled ? 'Приостановить' : 'Возобновить'}: ${escapeHtml(m.name)}">${m.enabled ? 'Ⅱ' : '▷'}</button></div>`
  }).join('')
}

function incidentRows(items) {
  if (!items.length) return '<div class="empty"><span class="empty-icon">✓</span><strong>Хорошие новости: инцидентов пока нет.</strong><p>Когда что-то произойдёт, вся история появится здесь.</p></div>'
  return items.map(i => `<article class="event-row"><span class="event-dot ${i.resolved_at ? '' : 'down'}"></span><div class="event-content"><strong>${escapeHtml(i.monitor_name)} <span class="pill ${i.resolved_at ? 'good' : 'bad'}">${i.resolved_at ? 'Восстановлено' : 'Открыт'}</span></strong><p>${escapeHtml(i.summary)}</p>${i.resolved_at ? `<span class="event-ack">Восстановлен ${dateTime(i.resolved_at)}</span>` : i.acknowledged_at ? `<span class="event-ack">✓ Принят в работу · ${clock(i.acknowledged_at)}</span>` : `<button class="ack-button" data-ack="${escapeHtml(i.id)}">✋ Беру в работу</button>`}</div><time class="event-time">${dateTime(i.opened_at)}</time></article>`).join('')
}

function renderChart() {
  const monitor = state.monitors.find(m => m.kind === 'http')
  const checks = (monitor?.history || []).filter(c => Number.isFinite(c.latency_ms))
  const svg = $('#latency-chart')
  if (!checks.length) { svg.innerHTML = '<text x="250" y="80" fill="#86947b" font-size="12">Ожидаем измерения</text>'; return }
  const maximum = Math.ceil(Math.max(300, ...checks.map(c => c.latency_ms)) / 100) * 100
  const points = checks.map((c, i) => `${i / Math.max(1, checks.length - 1) * 700},${145 - c.latency_ms / maximum * 130}`)
  const path = `M${points.join(' L')}`
  svg.innerHTML = `<defs><linearGradient id="chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#b8e66e" stop-opacity=".17"/><stop offset="100%" stop-color="#b8e66e" stop-opacity=".01"/></linearGradient></defs><path d="M0 15H700 M0 80H700 M0 145H700" stroke="#34412f" stroke-width="1" stroke-dasharray="3 4"/><path d="${path} L700,150 L0,150 Z" fill="url(#chart-fill)"/><path d="${path}" fill="none" stroke="#c5ed7c" stroke-width="2" vector-effect="non-scaling-stroke"/>`
  $('#chart-max').textContent = maximum
  $('#chart-mid').textContent = Math.round(maximum / 2)
  $('#chart-from').textContent = clock(checks[0].checked_at)
  $('.chart-legend').lastChild.textContent = ` ${monitor.name}`
}

function render() {
  const { metrics } = state
  const demo = state.mode === 'demo'
  $('#demo-banner').hidden = !demo
  $('#demo-controls').hidden = !demo
  $('#command-controls').hidden = !demo
  $('.telegram-caption').textContent = demo ? 'Демо-диалог · сообщения остаются локально' : 'Уведомления уходят подписчикам через Telegram'
  $('#telegram-subtitle').textContent = demo ? 'Тестовая доставка · без Telegram API' : 'Рабочий Telegram-бот'
  $('#footer-mode').textContent = demo ? 'Интерактивное демо на тестовых данных' : 'Рабочий режим · приватный доступ'
  $('#access-button').hidden = demo
  $('#metric-up').textContent = metrics.up
  $('#metric-total').textContent = `/ ${metrics.active}`
  $('#metric-uptime').textContent = metrics.uptime?.toFixed(2).replace('.', ',') ?? '—'
  $('#metric-latency').textContent = metrics.averageLatency ?? '—'
  $('#metric-incidents').textContent = metrics.openIncidents
  $('#metric-samples').textContent = `По ${metrics.samples} последним сохранённым измерениям`
  $('#monitor-number').textContent = state.monitors.length
  $('#incident-count').textContent = metrics.openIncidents
  $('#incident-count').classList.toggle('has-incidents', metrics.openIncidents > 0)
  $('#overall-pill').textContent = metrics.openIncidents ? 'Есть сбой' : metrics.active ? 'В норме' : 'Нет активных'
  $('#overall-pill').className = `pill ${metrics.openIncidents ? 'bad' : 'good'}`
  $('#incident-pill').textContent = metrics.openIncidents ? 'Нужен ты' : 'Тихо'
  $('#incident-pill').className = `pill ${metrics.openIncidents ? 'bad' : 'good'}`
  $('#monitors').innerHTML = monitorRows()
  const latest = Math.max(0, ...state.monitors.map(m => m.last_checked || 0))
  $('#last-check').textContent = `Последняя проверка · ${clock(latest)}`
  $('#recent-incidents').innerHTML = incidentRows(state.incidents.slice(0, 3))
  $('#all-incidents').innerHTML = incidentRows(state.incidents)
  const labels = { sent: demo ? 'Демо: обработано' : 'Telegram принял', pending: 'В очереди', sending: 'Отправляется', dead: 'Не доставлено', cancelled: 'Отменено' }
  $('#all-deliveries').innerHTML = state.deliveries.length ? state.deliveries.map(item => `<article class="event-row"><span class="event-dot ${item.state === 'dead' ? 'down' : ''}"></span><div class="event-content"><strong>${escapeHtml(item.payload.monitorName)} · ${item.kind === 'opened' ? 'Сбой' : 'Восстановление'}</strong><p>${escapeHtml(item.payload.summary)}</p><div class="delivery-meta"><span class="pill ${item.state === 'dead' ? 'bad' : item.state === 'sent' ? 'good' : 'neutral'}">${labels[item.state] || escapeHtml(item.state)}</span><span>Попыток: ${item.attempts}</span></div>${item.state === 'dead' ? `<button class="ack-button" data-retry="${escapeHtml(item.id)}">Повторить доставку</button>` : ''}</div><time class="event-time">${dateTime(item.created_at)}</time></article>`).join('') : '<div class="empty"><span class="empty-icon">↗</span><strong>Очередь пуста</strong><p>При сбое и восстановлении здесь появятся уведомления.</p></div>'
  if (!currentModuleList.length) {
    currentModuleList = state.modules
    $('#module-list').innerHTML = state.modules.map(m => `<article class="module-card"><span class="monitor-icon ${escapeHtml(m.id)}">${{ http: '⌁', content: '▣', tls: '♧' }[m.id] || '◇'}</span><h3>${escapeHtml(m.title)}</h3><p>${escapeHtml(m.description)}</p><footer><code>${escapeHtml(m.command)}</code><span>● Подключён</span></footer></article>`).join('')
    $('#module-select').innerHTML = state.modules.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.title)}</option>`).join('')
    renderModuleFields()
    $('.nav-badge').textContent = state.modules.length
  }
  renderChart()
  const messages = state.demoMessages
  const messageKey = messages.map(m => m.id).join(',')
  if ($('#telegram-messages').dataset.key !== messageKey) {
    $('#telegram-messages').dataset.key = messageKey
    $('#telegram-messages').innerHTML = messages.length ? messages.slice(-15).map(m => `<div class="message ${m.direction === 'in' ? 'in' : ''}">${escapeHtml(m.text)}<time>${clock(m.created_at)}${m.direction === 'out' ? ' ✓✓' : ''}</time></div>`).join('') : '<div class="message">Бот готов. Уведомления получают пользователи, которые отправили /start или /subscribe.</div>'
    $('#telegram-messages').scrollTop = $('#telegram-messages').scrollHeight
  }
}

async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    state = await api('/api/overview')
    render()
    $('#load-error').hidden = true
    $('#connection').innerHTML = '<span class="online-dot"></span>Данные с сервера'
  } catch (error) {
    $('#load-error').textContent = error.status === 401 ? 'Панель закрыта. Нажми на ключ вверху, чтобы подключиться.' : 'Нет связи с сервером. Показанные данные могут быть устаревшими.'
    $('#load-error').hidden = false
    $('#connection').textContent = 'Нет подключения'
  } finally { refreshing = false }
}

function renderModuleFields() {
  const module = currentModuleList.find(m => m.id === $('#module-select').value)
  $('#module-fields').innerHTML = (module?.fields || []).map(field => `<label>${escapeHtml(field.label)}<input name="${escapeHtml(field.key)}" type="${field.type === 'number' ? 'number' : 'text'}" placeholder="${escapeHtml(field.placeholder)}" ${field.required ? 'required' : ''} maxlength="1000"></label>`).join('')
}

$('#help-button').addEventListener('click', () => $('#info-dialog').showModal())
$('#module-info-button').addEventListener('click', () => $('#info-dialog').showModal())
$('#access-button').addEventListener('click', () => $('#access-dialog').showModal())
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()))
$('#add-button').addEventListener('click', () => {
  if (!state) { $('#access-dialog').showModal(); return }
  const demo = state.mode === 'demo'
  $('#add-description').textContent = demo ? 'В демо подключены три тестовых сервиса. Для своих сайтов включи рабочий режим с новым Telegram-ботом по инструкции в README.' : 'Проверяются публичные HTTPS-адреса. Внутренние сети и переадресации не используются.'
  $('#add-form').hidden = demo
  $('#add-dialog').showModal()
})
$('#module-select').addEventListener('change', renderModuleFields)
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault()
  const formElement = event.currentTarget
  const form = new FormData(formElement)
  const input = { kind: form.get('kind'), name: form.get('name'), target: form.get('target'), config: {} }
  for (const [key, value] of form) if (!['kind', 'name', 'target'].includes(key) && value) input.config[key] = value
  const button = $('#add-submit'); button.disabled = true
  try { await api('/api/monitors', input); $('#add-dialog').close(); formElement.reset(); renderModuleFields(); await refresh(); toast('Проверка добавлена') } catch (error) { $('#add-error').textContent = error.message } finally { button.disabled = false }
})
$('#access-form').addEventListener('submit', async event => {
  event.preventDefault(); apiKey = $('#access-key').value
  try { await api('/api/overview'); $('#access-key').value = ''; $('#access-error').textContent = ''; $('#access-dialog').close(); await refresh(); toast('Панель подключена') } catch (error) { apiKey = ''; $('#access-error').textContent = error.message }
})
$('#scenario-button').addEventListener('click', async event => {
  const scenario = $('#scenario-select').value
  const success = await action(event.currentTarget, '/api/demo/scenario', { scenario }, scenario === 'slow' ? 'Отклик вырос: проверь график' : 'Сценарий выполнен: проверь инциденты и Telegram')
  if (success) $('#scenario-state').textContent = `Сценарий: ${$('#scenario-select').selectedOptions[0].textContent.toLowerCase()}`
})
$('#restore-button').addEventListener('click', async event => {
  const success = await action(event.currentTarget, '/api/demo/scenario', { scenario: 'healthy' }, 'Тестовые сервисы восстановлены')
  if (success) $('#scenario-state').textContent = 'Сценарий: сервисы работают'
})
$('#command-form').addEventListener('submit', async event => {
  event.preventDefault()
  const text = $('#command-input').value.trim()
  if (!text) return
  await action(event.currentTarget.querySelector('button'), '/api/demo/command', { text })
  $('#command-input').value = ''
})
document.addEventListener('click', async event => {
  const command = event.target.closest('[data-command]')
  if (command) { await action(command, '/api/demo/command', { text: command.dataset.command }); return }
  const filterButton = event.target.closest('[data-filter]')
  if (filterButton) {
    filter = filterButton.dataset.filter
    document.querySelectorAll('[data-filter]').forEach(button => button.classList.toggle('selected', button === filterButton))
    if (state) $('#monitors').innerHTML = monitorRows()
  }
  const ack = event.target.closest('[data-ack]')
  if (ack) await action(ack, `/api/incidents/${encodeURIComponent(ack.dataset.ack)}/ack`, {}, 'Инцидент принят в работу')
  const monitor = event.target.closest('[data-monitor]')
  if (monitor) await action(monitor, `/api/monitors/${encodeURIComponent(monitor.dataset.monitor)}/${monitor.dataset.operation}`, {}, monitor.dataset.operation === 'pause' ? 'Проверка приостановлена' : 'Проверка возобновлена')
  const retry = event.target.closest('[data-retry]')
  if (retry) await action(retry, `/api/deliveries/${encodeURIComponent(retry.dataset.retry)}/retry`, {}, 'Сообщение возвращено в очередь')
})
window.addEventListener('hashchange', navigate)
navigate()
refresh()
setInterval(refresh, 4000)
