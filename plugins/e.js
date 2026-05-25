import util from 'node:util'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const cleanCode = code => String(code || '')
  .replace(/^```(?:js|javascript)?\s*/i, '')
  .replace(/```$/i, '')
  .trim()

const getBody = m => {
  return m.text ||
    m.body ||
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.msg?.text ||
    ''
}

const getExecCode = m => {
  if (Array.isArray(m.args) && m.args.length) {
    return cleanCode(m.args.join(' '))
  }

  return cleanCode(
    getBody(m).replace(/^[./#!]?(exec|eval|e|>)\s*/i, '')
  )
}

const safeJson = value => {
  const seen = new WeakSet()

  return JSON.stringify(value === undefined ? null : value, (_, val) => {
    if (typeof val === 'bigint') return val.toString()
    if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`
    if (typeof val === 'symbol') return val.toString()

    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack
      }
    }

    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
    }

    return val
  })
}

const withTimeout = async (promise, ms = 60000) => {
  let timer

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Tiempo agotado: ${ms / 1000}s`))
    }, ms)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

const executeCode = async ({ code, context }) => {
  const names = Object.keys(context)
  const values = Object.values(context)

  let fn

  try {
    fn = new AsyncFunction(...names, `"use strict"; return (${code})`)
  } catch {
    fn = new AsyncFunction(...names, `"use strict"; ${code}`)
  }

  return await fn(...values)
}

export default {
  command: ['exec', 'eval', 'e', '>'],
  view: ['exec', 'eval', 'e', '>'],
  category: ['tools'],

  async run(sock, m) {
    const code = getExecCode(m)

    if (!code) {
      return m.reply(safeJson({
        error: true,
        message: 'Código vacío',
        use: '.exec await sock.sendMessage(m.chat, { text: "hola" })'
      }))
    }

    try {
      const result = await withTimeout(
        executeCode({
          code,
          context: {
            sock,
            conn: sock,
            m,
            msg: m,
            args: m.args || [],
            text: getBody(m),
            command: m.command,
            Buffer,
            console,
            util,
            process
          }
        }),
        60000
      )

      return m.reply(safeJson(result))
    } catch (err) {
      return m.reply(safeJson({
        error: true,
        name: err?.name || 'Error',
        message: err?.message || String(err),
        stack: err?.stack || null
      }))
    }
  }
}