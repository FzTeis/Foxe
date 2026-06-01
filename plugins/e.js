import util from 'node:util'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const safeJson = value => {
  const seen = new WeakSet()
  return JSON.stringify(value === undefined ? null : value, (_, val) => {
    if (typeof val === 'bigint') return val.toString()
    if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`
    if (typeof val === 'symbol') return val.toString()
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack }
    }
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
    }
    return val
  }, 2)
}

export default {
  command: ['exec', 'eval', 'e', '>'],
  view: ['exec', 'eval', 'e', '>'],
  category: ['tools'],
  noPrefix: ['=>', '>'],

  async run(sock, m) {
    let rawCode = m.args?.length ? m.args.join(' ') : (m.text || m.body || '')
    rawCode = rawCode.trim()

    if (!rawCode) {
      return m.reply('```\n{\n  "error": true,\n  "message": "Código vacío"\n}\n```')
    }

    let isExpression = false
    let code = rawCode

    if (rawCode.startsWith('=>')) {
      isExpression = true
      code = rawCode.slice(2).trim()
    } else if (rawCode.startsWith('>')) {
      isExpression = false
      code = rawCode.slice(1).trim()
    }

    try {
      let result
      
      if (isExpression) {
        const fn = new AsyncFunction('m', `return (${code})`)
        result = await fn(m)
      } else {
        const fn = new AsyncFunction('m', code)
        result = await fn(m)
      }
      
      const formatted = safeJson(result)
      await m.reply('```\n' + formatted + '\n```')
      
    } catch (err) {
      await m.reply('```\n' + safeJson({
        error: true,
        name: err.name || 'Error',
        message: err.message || String(err)
      }) + '\n```')
    }
  }
}