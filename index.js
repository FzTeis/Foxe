import pino from 'pino'
import { createInterface } from 'readline'
import {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  makeCacheableSignalKeyStore
} from 'baileys'
import { useAuth } from './core/auth.js'
import { initProc, destroyProc, getStats } from './core/proc.js'
import handler, { ready, loadPlugins } from './core/handler.js'

const AUTH_FILE = './auth/auth.sqlite'
const MAX_RETRIES = 5

const logger = pino({ level: 'silent' })

let retries = 0
let pairingSent = false
let sock = null
let auth = null

function ask(q) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    })
    rl.question(q, (ans) => {
      rl.close()
      resolve(ans.trim())
    })
  })
}

function cleanPhone(raw) {
  return String(raw || '').replace(/[^0-9]/g, '').replace(/^00/, '')
}

async function getVersion() {
  try {
    const { version } = await fetchLatestBaileysVersion()
    return version
  } catch {
    return null
  }
}

async function start() {
  auth = useAuth(AUTH_FILE)
  const { state, saveCreds, clear, close } = auth

  const version = await getVersion()
  const needsPairing = !state.creds.registered

  let phone = null

  if (needsPairing) {
    phone = await ask('\nNumero con codigo de pais sin +: ')
    phone = cleanPhone(phone)

    if (!phone || phone.length < 7) {
      console.error('Numero invalido.')
      process.exit(1)
    }
  }

  const sockOpts = {
    logger,
    printQRInTerminal: false,

    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },

    browser: Browsers.macOS('Chrome'),

    markOnlineOnConnect: false,
    syncFullHistory: false,

    generateHighQualityLinkPreview: true,
    linkPreviewImageThumbnailWidth: 600,

    keepAliveIntervalMs: 45000,
    maxIdleTimeMs: 60000,

    shouldIgnoreJid: (jid) => {
      return jid === 'status@broadcast' || jid?.endsWith('@broadcast')
    },

    getMessage: async () => undefined
  }

  if (version) sockOpts.version = version

  sock = makeWASocket(sockOpts)

  sock.decodeJid = (jid) => {
    if (!jid) return jid
    if (/:\d+@/gi.test(jid)) {
      const decoded = sock.decodeJid(jid) || {}
      if (decoded.user && decoded.server) return `${decoded.user}@${decoded.server}`
    }
    return jid
  }

  sock.ev.on('creds.update', saveCreds)

  if (needsPairing && phone && !pairingSent) {
    pairingSent = true

    setTimeout(async () => {
      try {
        if (state.creds.registered) return

        const code = await sock.requestPairingCode(phone, 'FOXEBOT1')
        const formatted = code?.match(/.{1,4}/g)?.join(' - ') || code

        console.log(`\nCodigo: ${formatted}`)
        console.log('WhatsApp > Dispositivos vinculados > Vincular con numero\n')
      } catch (err) {
        pairingSent = false
        console.error(`Error codigo: ${err.message}`)
      }
    }, 2500)
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      retries = 0
      pairingSent = false
      console.log('Conectado.')

      await ready
      await loadPlugins()

      initProc()
    }

    if (connection === 'close') {
      destroyProc()

      const code = lastDisconnect?.error?.output?.statusCode
      const loggedOut = code === DisconnectReason.loggedOut || code === 401

      if (loggedOut) {
        console.error('Sesion cerrada. Limpiando auth.')
        clear()
        close()
        process.exit(1)
      }

      retries++

      if (retries >= MAX_RETRIES) {
        console.error(`${MAX_RETRIES} intentos. Limpiando y saliendo.`)
        clear()
        close()
        process.exit(1)
      }

      const delay = Math.min(5000 * retries, 30000)

      console.log(`Reconectando en ${delay / 1000}s...`)

      close()

      setTimeout(() => {
        start().catch((err) => {
          console.error(`Error reconexion: ${err.message}`)
        })
      }, delay)
    }
  })

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]

      if (!msg.message) continue
      if (msg.key?.remoteJid === 'status@broadcast') continue

      const m = {
        ...msg,
        id: msg.key?.id || '',
        chat: msg.key?.remoteJid || '',
        sender: msg.key?.fromMe
          ? (sock.decodeJid(sock.user?.id || '') || '')
          : (sock.decodeJid(msg.key?.participant || msg.key?.remoteJid || '') || ''),
        from_me: !!msg.key?.fromMe,
        isGroup: (msg.key?.remoteJid || '').endsWith('@g.us'),
        pushName: msg.pushName || 'User',
        type: '',
        text: '',
        body: '',
        reply: async (text, opts = {}) => {
          return sock.sendMessage(
            msg.key.remoteJid,
            { text: String(text), ...opts },
            { quoted: msg }
          )
        }
      }

      handler(sock, m)
    }
  })

  return sock
}

process.on('uncaughtException', (err) => {
  console.error(`uncaughtException: ${err.message}`)
})

process.on('unhandledRejection', (err) => {
  console.error(`unhandledRejection: ${err?.message || err}`)
})

process.on('SIGINT', () => {
  console.log('\nApagando...')

  destroyProc()

  if (auth) {
    auth.close()
  }

  process.exit(0)
})

process.on('SIGTERM', () => {
  destroyProc()

  if (auth) {
    auth.close()
  }

  process.exit(0)
})

start().catch((err) => {
  console.error(`Error fatal: ${err.message}`)
  process.exit(1)
})