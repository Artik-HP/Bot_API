'use strict'

const path = require('node:path')
const { loadEnvironment, readConfig } = require('./src/config.cjs')
const { createApplication } = require('./src/app.cjs')

async function main() {
  const root = path.resolve(__dirname)
  loadEnvironment(root)
  const config = readConfig(process.env, { root, demo: process.argv.includes('--demo') })
  const app = createApplication(config)
  const address = await app.start()
  console.log(`PulseDesk · ${config.mode} · http://${config.host}:${address.port}`)
  if (config.mode === 'demo') console.log('ДЕМО: тестовые сервисы и тестовая доставка; Telegram не вызывается.')
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    const force = setTimeout(() => process.exit(1), 15000).unref()
    await app.stop()
    clearTimeout(force)
  }
  process.once('SIGINT', () => stop().catch(() => { process.exitCode = 1 }))
  process.once('SIGTERM', () => stop().catch(() => { process.exitCode = 1 }))
}

if (require.main === module) main().catch(error => { console.error(`PulseDesk: ${error.message}`); process.exitCode = 1 })
module.exports = { main }
