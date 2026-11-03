'use strict'

const dayMs = 86400000
const isoDay = value => new Date(value).toISOString().slice(0, 10)
const number = value => String(value).replace('.', ',')

// Daily rollups cover the whole period; raw checks are trimmed to the last 720 per monitor.
function buildDigestData(store, { now = Date.now(), days = 7, timezone = 'Europe/Kyiv' } = {}) {
  const from = now - days * dayMs
  const format = new Intl.DateTimeFormat('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: timezone })
  const stats = new Map(store.dailyStats(isoDay(from), isoDay(now)).map(row => [row.monitor_id, row]))
  const monitors = store.listMonitors().map(monitor => {
    const row = stats.get(monitor.id)
    return {
      name: monitor.name, kind: monitor.kind, status: monitor.enabled ? monitor.status : 'paused', checks: row?.checks || 0,
      uptime: row?.checks ? Math.round(row.ok / row.checks * 10000) / 100 : null,
      avgLatencyMs: row?.latency_count ? Math.round(row.latency_sum / row.latency_count) : null,
      maxLatencyMs: row?.latency_count ? row.latency_max : null,
    }
  })
  const incidents = store.incidentsSince(from).map(incident => ({
    monitor: incident.monitor_name, openedAt: format.format(incident.opened_at),
    minutes: Math.max(1, Math.round(((incident.resolved_at || now) - incident.opened_at) / 60000)),
    open: !incident.resolved_at, acknowledged: Boolean(incident.acknowledged_at), summary: incident.summary,
    cause: incident.analysis?.cause || null,
  }))
  return {
    days, period: `${format.format(from)} — ${format.format(now)}`, monitors, incidents,
    totals: {
      checks: monitors.reduce((sum, monitor) => sum + monitor.checks, 0), incidents: incidents.length,
      open: incidents.filter(incident => incident.open).length, downtimeMinutes: incidents.reduce((sum, incident) => sum + incident.minutes, 0),
    },
  }
}

function icon(monitor) {
  if (monitor.status === 'paused') return '⏸'
  if (monitor.status === 'down') return '🔴'
  if (monitor.uptime === null) return '⚪'
  return monitor.uptime < 99 ? '🟡' : '🟢'
}

function formatDigest(data) {
  const lines = [`📊 PulseDesk · отчёт за ${data.days} дн.`, data.period, '']
  lines.push(data.totals.incidents ? `Инцидентов: ${data.totals.incidents} (открыто: ${data.totals.open}), простой ≈ ${data.totals.downtimeMinutes} мин.` : 'Инцидентов не было: все проверки работали штатно.')
  lines.push(`Измерений за период: ${data.totals.checks}.`, '')
  for (const monitor of data.monitors) {
    lines.push(`${icon(monitor)} ${monitor.name} — ${monitor.uptime === null ? 'нет измерений' : `${number(monitor.uptime)}% успешных`}${monitor.avgLatencyMs === null ? '' : ` · ${monitor.avgLatencyMs} мс`}`)
  }
  if (data.incidents.length) {
    lines.push('', 'Инциденты:')
    for (const incident of data.incidents.slice(0, 8)) lines.push(`• ${incident.monitor} — ${incident.openedAt}, ${incident.minutes} мин.${incident.open ? ' (открыт)' : ''}: ${incident.summary}`)
  }
  return lines.join('\n')
}

module.exports = { buildDigestData, formatDigest }
