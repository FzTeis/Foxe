import util from 'node:util'
import vm from 'node:vm'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const getBody = m => {
  return m.text ||
    m.body ||
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.msg?.text ||
    ''
}

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

export default {
  command: ['exec', 'eval', 'e', '>'],
  view: ['exec', 'eval', 'e', '>'],
  category: ['tools'],
  noPrefix: ['=>', '>'],
  
  async run(sock, m) {
    let rawCode = ''
    
    if (m.args && m.args.length) {
      rawCode = m.args.join(' ')
    } else {
      rawCode = getBody(m)
    }
    
    rawCode = rawCode.trim()
    
    let isExpression = false
    let code = rawCode
    
    if (rawCode.startsWith('=>')) {
      isExpression = true
      code = rawCode.slice(2).trim()
    } else if (rawCode.startsWith('>')) {
      isExpression = false
      code = rawCode.slice(1).trim()
    } else if (m.prefix === '>') {
      isExpression = false
      code = rawCode
    } else if (m.prefix === '=>') {
      isExpression = true
      code = rawCode
    }
    
    if (!code) {
      return m.reply('```\n' + safeJson({
        error: true,
        message: 'Código vacío',
        uso: '=> m.sender\n> let x = 5\n> return x * 2\n.e await sock.sendMessage(m.chat, { text: "hola" })'
      }) + '\n```')
    }
    
    try {
      let result
      
      if (isExpression) {
        const fn = new AsyncFunction('sock', 'm', 'util', 'Buffer', 'console', 'process', 
          `return (${code})`)
        result = await fn(sock, m, util, Buffer, console, process)
      } else {
        const wrapper = new AsyncFunction('sock', 'm', 'util', 'Buffer', 'console', 'process',
          `try {
            ${code}
          } catch (err) {
            return err
          }`
        )
        
        result = await wrapper(sock, m, util, Buffer, console, process)
        
        if (result instanceof Error) {
          throw result
        }
      }
      
      const formatted = safeJson(result)
      const maxLength = 65000
      
      if (formatted.length > maxLength) {
        const chunks = Math.ceil(formatted.length / maxLength)
        for (let i = 0; i < chunks; i++) {
          const chunk = formatted.slice(i * maxLength, (i + 1) * maxLength)
          await m.reply('```\n' + chunk + '\n```')
        }
      } else {
        await m.reply('\n' + formatted + '\n')
      }
      
    } catch (err) {
      await m.reply('```\n' + safeJson({
        error: true,
        name: err?.name || 'Error',
        message: err?.message || String(err),
        stack: err?.stack || null
      }) + '\n```')
    }
  }
}