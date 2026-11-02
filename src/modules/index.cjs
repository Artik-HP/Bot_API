'use strict'
const { ModuleRegistry } = require('../core/modules.cjs')

function createRegistry() {
  return new ModuleRegistry()
    .register(require('./http/index.cjs'))
    .register(require('./content/index.cjs'))
    .register(require('./tls/index.cjs'))
}

module.exports = { createRegistry }
