import util from 'util'

export default {
  command: ['exec', 'eval', 'e', '>'],
  view: ['exec', 'eval', 'e', '>'],
  category: ['tools'],
  noPrefix: ['=>', '>'],

  async run(sock, m) {
    let rawCode = m.args?.length ? m.args.join(' ') : (m.text || m.body || '')
    rawCode = rawCode.trim()

    if (!rawCode) {
      return m.reply('🌳 Introduzca el código que desea ejecutar.')
    }

    const logs = []
    const fakeConsole = {
      ...console,
      log: (...x) => logs.push(x.map(v => format(v)).join(' ')),
      error: (...x) => logs.push(x.map(v => format(v)).join(' ')),
      warn: (...x) => logs.push(x.map(v => format(v)).join(' ')),
      info: (...x) => logs.push(x.map(v => format(v)).join(' ')),
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
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
      
      let result
      
      if (isExpression) {
        const fn = new AsyncFunction('m', 'sock', 'console', `return (${code})`)
        result = await fn(m, sock, fakeConsole)
      } else {
        const fn = new AsyncFunction('m', 'sock', 'console', code)
        result = await fn(m, sock, fakeConsole)
      }

      let output = ''

      if (logs.length) {
        output += logs.join('\n')
      }

      if (result !== undefined) {
        if (output) output += '\n\n'
        output += format(result)
      }

      if (!output) output = '✅ Sin resultado'

      if (output.length > 50000) {
        output = output.slice(0, 50000) + '\n... 😿'
      }

      await m.reply('```js\n' + output + '\n```')
      
    } catch (err) {
      let errorMsg = err?.stack || err?.message || String(err)
      if (errorMsg.length > 50000) {
        errorMsg = errorMsg.slice(0, 50000) + '\n... 😿'
      }
      await m.reply('🚫 Error:\n```js\n' + errorMsg + '\n```')
    }
  }
}

function format(value) {
  return typeof value === 'string'
    ? value
    : util.inspect(value, {
        depth: 3,
        breakLength: 80,
        compact: false,
        colors: false
      })
}