import * as baileys from 'baileys'
import pino from 'pino'
import fs from 'fs'
import path from 'path'
import database from 'better-sqlite3'
import { createInterface } from 'readline'
import { pathToFileURL } from 'url'

const {
  default: make_wa_socket,
  fetchLatestBaileysVersion: fetch_latest_baileys_version,
  DisconnectReason: disconnect_reason,
  Browsers: browsers,
  makeCacheableSignalKeyStore: make_cacheable_signal_key_store,
  jidDecode: jid_decode,
  BufferJSON: buffer_json,
  initAuthCreds: init_auth_creds,
  proto
} = baileys

const db_dir = './auth'
const db_file = path.join(db_dir, 'auth.sqlite')
const handler_file = path.resolve('./core/handler.js')

const max_retries = 5
const logger = pino({ level: 'silent' })

let retry_count = 0
let pairing_requested = false
let handler_cache = null
let handler_mtime = 0
let handler_warning_shown = false

const log = {
  info: (text) => console.log(`\x1b[36m[ INFO ]\x1b[0m ${text}`),
  success: (text) => console.log(`\x1b[32m[ OK ]\x1b[0m ${text}`),
  warn: (text) => console.log(`\x1b[33m[ WARN ]\x1b[0m ${text}`),
  error: (text) => console.log(`\x1b[31m[ ERROR ]\x1b[0m ${text}`)
}

function ask(text) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    })

    rl.question(text, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

function format_phone_number(raw) {
  return String(raw || '')
    .replace(/[^0-9]/g, '')
    .replace(/^00/, '')
}

function decode_jid(jid) {
  if (!jid) return jid

  if (/:\d+@/gi.test(jid)) {
    const decoded = jid_decode(jid) || {}

    if (decoded.user && decoded.server) {
      return `${decoded.user}@${decoded.server}`
    }
  }

  return jid
}

function get_message_type(message) {
  if (!message) return ''

  const type = Object.keys(message)[0]

  if (type === 'ephemeralMessage') {
    return get_message_type(message.ephemeralMessage?.message)
  }

  if (type === 'viewOnceMessage') {
    return get_message_type(message.viewOnceMessage?.message)
  }

  if (type === 'viewOnceMessageV2') {
    return get_message_type(message.viewOnceMessageV2?.message)
  }

  return type || ''
}

function get_message_content(message) {
  if (!message) return null

  if (message.ephemeralMessage) {
    return get_message_content(message.ephemeralMessage.message)
  }

  if (message.viewOnceMessage) {
    return get_message_content(message.viewOnceMessage.message)
  }

  if (message.viewOnceMessageV2) {
    return get_message_content(message.viewOnceMessageV2.message)
  }

  return message
}

function get_message_text(message) {
  const content = get_message_content(message)

  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.buttonsResponseMessage?.selectedButtonId ||
    content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content?.templateButtonReplyMessage?.selectedId ||
    ''
  )
}

function serialize_message(sock, msg) {
  const chat = msg.key?.remoteJid || ''
  const sender = msg.key?.fromMe
    ? decode_jid(sock.user?.id || '')
    : decode_jid(msg.key?.participant || chat)

  const text = get_message_text(msg.message)
  const type = get_message_type(msg.message)

  const m = {
    ...msg,

    id: msg.key?.id || '',
    chat,
    sender,
    from_me: !!msg.key?.fromMe,
    isGroup: chat.endsWith('@g.us'),
    type,
    text,
    body: text,
    pushName: msg.pushName || 'User',

    reply: async (text, options = {}) => {
      return sock.sendMessage(
        chat,
        {
          text: String(text),
          ...options
        },
        {
          quoted: msg
        }
      )
    }
  }

  return m
}

function use_sqlite_auth_state(file) {
  if (!fs.existsSync(db_dir)) {
    fs.mkdirSync(db_dir, { recursive: true })
  }

  const sql = new database(file)

  sql.pragma('journal_mode = WAL')
  sql.pragma('synchronous = NORMAL')
  sql.pragma('busy_timeout = 5000')

  sql.exec(`
    CREATE TABLE IF NOT EXISTS auth (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  const get_stmt = sql.prepare('SELECT value FROM auth WHERE key = ?')

  const set_stmt = sql.prepare(`
    INSERT INTO auth (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)

  const del_stmt = sql.prepare('DELETE FROM auth WHERE key = ?')
  const clear_stmt = sql.prepare('DELETE FROM auth')

  function read_data(key) {
    try {
      const row = get_stmt.get(key)
      if (!row) return null

      return JSON.parse(row.value, buffer_json.reviver)
    } catch {
      return null
    }
  }

  function write_data(key, value) {
    const json = JSON.stringify(value, buffer_json.replacer)
    set_stmt.run(key, json)
  }

  function remove_data(key) {
    del_stmt.run(key)
  }

  const creds = read_data('creds') || init_auth_creds()

  const set_many = sql.transaction((data) => {
    for (const category in data) {
      for (const id in data[category]) {
        const value = data[category][id]
        const key = `${category}:${id}`

        if (value) {
          write_data(key, value)
        } else {
          remove_data(key)
        }
      }
    }
  })

  const state = {
    creds,

    keys: {
      get: async (type, ids) => {
        const result = {}

        for (const id of ids) {
          const key = `${type}:${id}`
          let value = read_data(key)

          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value)
          }

          result[id] = value
        }

        return result
      },

      set: async (data) => {
        set_many(data)
      }
    }
  }

  return {
    state,

    save_creds: async () => {
      write_data('creds', state.creds)
    },

    clear: () => {
      clear_stmt.run()
    },

    close: () => {
      sql.close()
    }
  }
}

async function load_handler() {
  try {
    if (!fs.existsSync(handler_file)) {
      if (!handler_warning_shown) {
        handler_warning_shown = true
        log.warn('No existe ./core/handler.js todavía. Los mensajes serán ignorados.')
      }

      return null
    }

    const stat = fs.statSync(handler_file)

    if (handler_cache && handler_mtime === stat.mtimeMs) {
      return handler_cache
    }

    const url = `${pathToFileURL(handler_file).href}?update=${stat.mtimeMs}`
    const mod = await import(url)

    const handler = mod.default || mod.handler || mod.handle_message

    if (typeof handler !== 'function') {
      log.error('./core/handler.js debe exportar una función.')
      return handler_cache
    }

    handler_cache = handler
    handler_mtime = stat.mtimeMs

    log.success('Handler cargado correctamente.')

    return handler_cache
  } catch (err) {
    log.error(`Error cargando handler: ${err.message}`)
    return handler_cache
  }
}

async function get_baileys_version() {
  try {
    const { version } = await fetch_latest_baileys_version()
    return version
  } catch {
    log.warn('No se pudo obtener la última versión de Baileys. Usando versión por defecto.')
    return null
  }
}

async function start_bot() {
  const auth = use_sqlite_auth_state(db_file)
  const { state, save_creds } = auth

  const version = await get_baileys_version()
  const needs_pairing = !state.creds.registered

  let phone_number = null

  if (needs_pairing) {
    phone_number = await ask('\nNúmero con código de país, sin +: ')
    phone_number = format_phone_number(phone_number)

    if (!phone_number || phone_number.length < 7) {
      log.error('Número inválido.')
      process.exit(1)
    }
  }

  const socket_options = {
    logger,
    printQRInTerminal: false,

    auth: {
      creds: state.creds,
      keys: make_cacheable_signal_key_store(state.keys, logger)
    },

    browser: browsers.macOS('Chrome'),

    markOnlineOnConnect: false,
    syncFullHistory: false,

    generateHighQualityLinkPreview: true,
    linkPreviewImageThumbnailWidth: 600,

    keepAliveIntervalMs: 45_000,
    maxIdleTimeMs: 60_000,

    shouldIgnoreJid: (jid) => {
      return jid === 'status@broadcast' || jid?.endsWith('@broadcast')
    },

    getMessage: async () => {
      return undefined
    }
  }

  if (version) {
    socket_options.version = version
  }

  const sock = make_wa_socket(socket_options)

  sock.decodeJid = decode_jid

  sock.ev.on('creds.update', save_creds)

  if (needs_pairing && phone_number && !pairing_requested) {
    pairing_requested = true

    setTimeout(async () => {
      try {
        if (state.creds.registered) return

        const code = await sock.requestPairingCode(phone_number, 'FOXEBOT1')
        const formatted = code?.match(/.{1,4}/g)?.join(' - ') || code

        console.log()
        log.success(`Código de vinculación: ${formatted}`)
        log.info('WhatsApp → Dispositivos vinculados → Vincular con número')
        console.log()
      } catch (err) {
        pairing_requested = false
        log.error(`No se pudo generar el código: ${err.message}`)
      }
    }, 2500)
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      retry_count = 0
      pairing_requested = false

      log.success('Foxe conectado correctamente.')
      await load_handler()
    }

    if (connection === 'close') {
      const status_code = lastDisconnect?.error?.output?.statusCode
      const logged_out = status_code === disconnect_reason.loggedOut || status_code === 401

      if (logged_out) {
        log.error('Sesión cerrada o inválida. Se limpiará la sesión SQL.')
        auth.clear()
        auth.close()
        process.exit(1)
      }

      retry_count++

      if (retry_count >= max_retries) {
        log.error(`${max_retries} intentos fallidos. Se limpiará la sesión SQL.`)
        auth.clear()
        auth.close()
        process.exit(1)
      }

      const delay = Math.min(5000 * retry_count, 30000)

      log.warn(`Conexión perdida (${status_code || 'sin código'}). Reconectando en ${delay / 1000}s...`)

      auth.close()

      setTimeout(() => {
        start_bot().catch((err) => {
          log.error(`Error al reconectar: ${err.message}`)
        })
      }, delay)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return

      const handler = await load_handler()
      if (!handler) return

      for (const msg of messages) {
        if (!msg.message) continue
        if (msg.key?.remoteJid === 'status@broadcast') continue

        const m = serialize_message(sock, msg)

        await handler(sock, m)
      }
    } catch (err) {
      log.error(`Error procesando mensaje: ${err.message}`)
    }
  })

  return sock
}

process.on('uncaughtException', (err) => {
  log.error(`uncaughtException: ${err.message}`)
})

process.on('unhandledRejection', (err) => {
  log.error(`unhandledRejection: ${err?.message || err}`)
})

start_bot().catch((err) => {
  log.error(`Error fatal: ${err.message}`)
  process.exit(1)
})