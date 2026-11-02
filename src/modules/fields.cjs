'use strict'
function fields(args) { return args.split('|').map(part => part.trim()) }
module.exports = { fields }
