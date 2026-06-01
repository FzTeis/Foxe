import util from 'node:util'
import vm from 'node:vm'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const cleanCode = code => String(code || '')
  .replace(/^(?:js|javascript)?\s*/i, '')
  .replace(/$/i, '')
  .trim()

const getBody = m => {
  return m.text ||
    m.body ||
    m.message?.conversation ||
    m.message?.extendedTextMessage?.text ||
    m.msg?.text ||
    ''
}

const getExecCode = (m, rawCode = null) => {
  let code = rawCode
  
  if (!code) {
    if (Array.isArray(m.args) && m.args.length) {
      code = cleanCode(m.args.join(' '))
    } else {
      code = cleanCode(
        getBody(m).replace(/^[./#!]?(exec|eval|e|>)\s*/i, '')
      )
    }
  }
  
  const prefix = m.prefix || ''
  const fullText = getBody(m)
  
  if (fullText.startsWith('=>')) {
    let execCode = fullText.slice(2).trim()
    if (!execCode.includes('return') && !execCode.includes('=>')) {
      execCode = `return (${execCode})`
    }
    return execCode
  }
  
  if (prefix === '>') {
    return code
  }
  
  if (code.startsWith('=>')) {
    let execCode = code.slice(2).trim()
    if (!execCode.includes('return') && !execCode.includes('=>')) {
      execCode = `return (${execCode})`
    }
    return execCode
  }
  
  return code
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

const executeCode = async ({ code, context }) => {
  const names = Object.keys(context)
  const values = Object.values(context)
  
  let fn
  
  try {
    fn = new AsyncFunction(...names, `"use strict"; return (${code})`)
  } catch {
    try {
      fn = new AsyncFunction(...names, `"use strict"; ${code}`)
    } catch (err) {
      const sandbox = { ...context }
      const script = new vm.Script(code)
      const result = script.runInNewContext(sandbox)
      return result
    }
  }
  
  return await fn(...values)
}

export default {
  command: ['exec', 'eval', 'e', '>'],
  view: ['exec', 'eval', 'e', '>'],
  category: ['tools'],
  noPrefix: ['=>', '>'],
  
  async run(sock, m) {
    let code = getExecCode(m)
    
    if (!code) {
      return m.reply('```\n' + safeJson({
        error: true,
        message: 'Código vacío',
        use: '.e await sock.sendMessage(m.chat, { text: "hola" })\n=> m.sender\n> const fs = require("fs"); fs.readFileSync("file.txt", "utf8")'
      }) + '\n```')
    }
    
    const importCache = new Map()
    
    const customRequire = async (moduleName) => {
      if (importCache.has(moduleName)) {
        return importCache.get(moduleName)
      }
      
      try {
        if (moduleName.startsWith('http')) {
          const res = await fetch(moduleName)
          const text = await res.text()
          const blob = new Blob([text], { type: 'application/javascript' })
          const url = URL.createObjectURL(blob)
          const module = await import(url)
          URL.revokeObjectURL(url)
          importCache.set(moduleName, module)
          return module
        }
        
        const module = await import(moduleName)
        importCache.set(moduleName, module)
        return module
      } catch {
        const module = require(moduleName)
        importCache.set(moduleName, module)
        return module
      }
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
            process,
            require: customRequire,
            import: customRequire,
            fetch: global.fetch,
            setTimeout,
            setInterval,
            clearTimeout,
            clearInterval
          }
        }),
        60000
      )
      
      const formatted = safeJson(result)
      const maxLength = 65000
      
      if (formatted.length > maxLength) {
        const chunks = Math.ceil(formatted.length / maxLength)
        for (let i = 0; i < chunks; i++) {
          const chunk = formatted.slice(i * maxLength, (i + 1) * maxLength)
          await m.reply('```\n' + chunk + '\n```')
        }
      } else {
        await m.reply('```\n' + formatted + '\n```')
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