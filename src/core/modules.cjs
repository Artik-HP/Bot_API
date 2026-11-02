'use strict'

class ModuleRegistry {
  constructor() { this.items = new Map() }
  register(plugin) {
    if (!plugin || !/^[a-z][a-z0-9-]{1,30}$/.test(plugin.id) || typeof plugin.check !== 'function' || typeof plugin.validate !== 'function') throw new Error('Некорректный модуль проверки')
    if (this.items.has(plugin.id)) throw new Error(`Модуль ${plugin.id} уже зарегистрирован`)
    this.items.set(plugin.id, Object.freeze(plugin))
    return this
  }
  get(id) { const plugin = this.items.get(id); if (!plugin) throw new Error('Неизвестный модуль проверки'); return plugin }
  list() { return [...this.items.values()].map(({ id, title, description, icon, command, fields = [] }) => ({ id, title, description, icon, command, fields })) }
  create(input, intervalSeconds = 60) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Нужен объект проверки')
    const plugin = this.get(input.kind)
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 70) throw new Error('Название: от 1 до 70 символов')
    const validated = plugin.validate(input)
    return { kind: plugin.id, name: input.name.trim(), target: validated.target, config: validated.config, intervalSeconds }
  }
}

module.exports = { ModuleRegistry }
