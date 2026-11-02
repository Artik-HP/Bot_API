'use strict'
const { readdirSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? files(target) : /\.(cjs|js)$/.test(entry.name) ? [target] : []
  })
}
const targets = ['index.js', ...['src', 'scripts', 'test', 'public'].flatMap(files)]
for (const target of targets) {
  const result = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
console.log(`Синтаксис: ${targets.length} файлов проверено`)
