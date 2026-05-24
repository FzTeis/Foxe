import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { addToQueue, acquireLock, releaseLock } from './proc.js'

const PLUGINS_DIR = path.resolve('./plugins')
const CONFIG_FILE = path.resolve('./config.js')
const META_TTL = 5 * 60 * 1000
const LID_TTL = 30 * 60 * 1000

const plugins = new Map()
const cmdMap = new Map()
const metaCache = new Map()
const lidCache = new Map()

let loaded = false
let antiLink = null
let configCache = null
let configMtime = 0

function cleanNum(v) {
  return String(v || '').replace(/\D/g, '')
}

function rawId(jid) {
  return String(jid || '').split('@')[0].split(':')[0]
}

function normJid(v) {
  if (!v) return ''
  const t = String(v)
  if (t.includes('@')) return t
  const n = cleanNum(t)
  return n ? `${n}@s.whatsapp.net` : t
}

function sameUser(a, b) {
  const ra = rawId(a)
  const rb = rawId(b)
  return ra && rb && ra === rb
}

async function loadConfig(force = false) {
  const fallback = {
    bot_name: 'Foxe',
    bot_author: '',
    owners: [],
    prefix: ['.'],
    messages: {}
  }

  if (!fs.existsSync(CONFIG_FILE)) return fallback

  try {
    const stat = fs.statSync(CONFIG_FILE)
    if (!force && configCache && configMtime === stat.mtimeMs) return configCache
    const token = force ? `${Date.now()}-${stat.mtimeMs}` : stat.mtimeMs
    const mod = await import(`${pathToFileURL(CONFIG_FILE).href}?update=${token}`)
    configCache = { ...fallback, ...(mod.default || mod.config || {}) }
    configMtime = stat.mtimeMs
    return configCache
  } catch {
    return configCache || fallback
  }
}

function isOwner(jid, config) {
  const raw = rawId(jid)
  for (const o of config.owners || []) {
    if (cleanNum(o) === raw) return true
  }
  return false
}

function getContent(msg) {
  if (!msg) return null
  if (msg.ephemeralMessage) return getContent(msg.ephemeralMessage.message)
  if (msg.viewOnceMessage) return getContent(msg.viewOnceMessage.message)
  if (msg.viewOnceMessageV2) return getContent(msg.viewOnceMessageV2.message)
  if (msg.documentWithCaptionMessage) return getContent(msg.documentWithCaptionMessage.message)
  return msg
}

function getText(m) {
  const content = getContent(m.message)
  return (
    m.text ||
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    content?.buttonsResponseMessage?.selectedButtonId ||
    content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    content?.templateButtonReplyMessage?.selectedId ||
    content?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ''
  )
}

function getFlags(cmd) {
  return {
    owner: !!(cmd.is_owner || cmd.isOwner || cmd.owner),
    group: !!(cmd.is_group || cmd.isGroup || cmd.group),
    admin: !!(cmd.is_admin || cmd.isAdmin || cmd.admin),
    botAdmin: !!(cmd.is_bot_admin || cmd.isBotAdmin || cmd.botAdmin)
  }
}

function getAliases(cmd) {
  if (!cmd) return []
  if (Array.isArray(cmd)) return cmd.map(c => String(c).toLowerCase())
  return [String(cmd).toLowerCase()]
}

function logCmd(data) {
  const time = new Date().toLocaleTimeString('es-HN', {
    timeZone: 'America/Tegucigalpa',
    hour12: false
  })

  setImmediate(() => {
    console.log(
      `\x1b[35m[${time}]\x1b[0m ` +
      `\x1b[36m${data.cmd}\x1b[0m ` +
      `\x1b[90mde\x1b[0m ` +
      `\x1b[33m${data.user}\x1b[0m ` +
      `\x1b[90men\x1b[0m ` +
      `\x1b[37m${data.chat}\x1b[0m ` +
      `\x1b[90m${data.ms}ms\x1b[0m`
    )
  })
}

async function scanDir(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out

  const entries = fs.readdirSync(dir)
  for (const entry of entries) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      const sub = await scanDir(full)
      out.push(...sub)
    } else if (entry.endsWith('.js') || entry.endsWith('.mjs')) {
      out.push(full)
    }
  }
  return out
}

async function loadAntiLink(force = false) {
  if (antiLink && !force) return antiLink

  const paths = [
    path.resolve('./plugins/antilink.js'),
    path.resolve('./core/plugins/antilink.js')
  ]

  for (const f of paths) {
    if (!fs.existsSync(f)) continue
    try {
      const stat = fs.statSync(f)
      const token = force ? `${Date.now()}-${stat.mtimeMs}` : stat.mtimeMs
      const url = `${pathToFileURL(f).href}?update=${token}`
      const mod = await import(url)
      antiLink = mod.anti_link || mod.antiLink || mod.default || null
      return antiLink
    } catch {
      return null
    }
  }
  return null
}

async function runAntiLink(sock, m) {
  try {
    const fn = antiLink || await loadAntiLink()
    if (typeof fn === 'function') await fn(sock, m)
  } catch {}
}

async function getMeta(sock, chat) {
  if (!chat?.endsWith('@g.us')) return null
  const cached = metaCache.get(chat)
  if (cached && Date.now() - cached.ts < META_TTL) return cached.data
  try {
    const meta = await sock.groupMetadata(chat)
    metaCache.set(chat, { data: meta, ts: Date.now() })
    return meta
  } catch {
    return null
  }
}

async function getLid(sock, chat, lid) {
  const input = String(lid || '').trim()
  if (!input || !chat?.endsWith('@g.us')) return input
  if (input.endsWith('@s.whatsapp.net')) return input
  if (lidCache.has(input)) return lidCache.get(input)

  const meta = await getMeta(sock, chat)
  const parts = meta?.participants || []
  const match = parts.find(p =>
    p.id === input || p.lid === input ||
    sameUser(p.id, input) || sameUser(p.lid, input)
  )

  if (match?.phoneNumber) {
    const jid = normJid(match.phoneNumber)
    if (jid) {
      lidCache.set(input, jid)
      setTimeout(() => lidCache.delete(input), LID_TTL)
      return jid
    }
  }

  return input
}

async function fixLid(sock, m) {
  const chat = m.chat || m.key?.remoteJid || ''
  const sender = m.sender || m.key?.participant || chat || ''
  const decoded = typeof sock.decodeJid === 'function' ? sock.decodeJid(sender) : sender

  if (chat.endsWith('@g.us')) return await getLid(sock, chat, decoded)

  if (decoded.includes('@lid')) {
    try {
      const res = await sock.onWhatsApp(decoded)
      if (res?.length > 0 && res[0]?.jid) {
        lidCache.set(decoded, res[0].jid)
        setTimeout(() => lidCache.delete(decoded), LID_TTL)
        return res[0].jid
      }
    } catch {
      return decoded
    }
  }

  return decoded
}

function isAdmin(p, jid) {
  const raw = rawId(jid)
  const ids = [p?.id, p?.lid, p?.phoneNumber]
  const match = ids.some(id => id && rawId(id) === raw)
  const admin = p?.admin === 'admin' || p?.admin === 'superadmin'
  return match && admin
}

export async function loadPlugins(force = false) {
  plugins.clear()
  cmdMap.clear()

  if (!fs.existsSync(PLUGINS_DIR)) {
    loaded = true
    return
  }

  const files = await scanDir(PLUGINS_DIR)

  for (const full of files) {
    try {
      const stat = fs.statSync(full)
      const token = force ? `${Date.now()}-${stat.mtimeMs}` : stat.mtimeMs
      const url = `${pathToFileURL(full).href}?update=${token}`
      const mod = await import(url)
      const plugin = mod.default || mod

      if (!plugin?.command) continue

      plugins.set(full, plugin)

      const aliases = getAliases(plugin.command)
      for (const alias of aliases) cmdMap.set(alias, plugin)
    } catch {}
  }

  loaded = true
}

export async function reloadFiles() {
  configCache = null
  configMtime = 0
  antiLink = null
  metaCache.clear()
  lidCache.clear()
  await loadConfig(true)
  await loadAntiLink(true)
  await loadPlugins(true)
}

export const ready = loadPlugins()

export { cmdMap, plugins, fixLid, getMeta, loadConfig }

export default async function handler(sock, m) {
  if (!m?.message) return

  const config = await loadConfig()
  const prefixes = Array.isArray(config.prefix) ? config.prefix : [String(config.prefix || '.')]
  const body = getText(m)

  m.text = body
  m.body = body

  if (typeof m.reply !== 'function') {
    m.reply = async (text, opts = {}) => {
      return sock.sendMessage(m.chat, { text: String(text), ...opts }, { quoted: m })
    }
  }

  const prefix = prefixes.find(p => body.startsWith(p))

  if (!prefix) {
    runAntiLink(sock, m)
    return
  }

  const withoutPrefix = body.slice(prefix.length).trim()
  if (!withoutPrefix) return

  const args = withoutPrefix.split(/ +/)
  const cmdName = String(args.shift() || '').toLowerCase()
  const text = args.join(' ')

  if (!loaded) await ready

  const cmd = cmdMap.get(cmdName)
  if (!cmd) return

  const flags = getFlags(cmd)
  const senderJid = await fixLid(sock, m)
  const senderId = rawId(senderJid)
  const botJid = sock.decodeJid ? sock.decodeJid(sock.user?.id || '') : sock.user?.id || ''
  const owner = isOwner(senderJid, config)

  let groupMeta = null
  let groupName = ''
  let groupAdmins = []
  let admin = false
  let botAdmin = false

  if ((flags.group || flags.admin || flags.botAdmin) && !m.isGroup) {
    return m.reply(config.messages?.group || 'Solo grupos.')
  }

  if (m.isGroup && (flags.group || flags.admin || flags.botAdmin)) {
    groupMeta = await getMeta(sock, m.chat)
    groupName = groupMeta?.subject || ''
    groupAdmins = groupMeta?.participants?.filter(p => p.admin === 'admin' || p.admin === 'superadmin') || []
    admin = groupMeta?.participants?.some(p => isAdmin(p, senderJid)) || false
    botAdmin = groupMeta?.participants?.some(p => isAdmin(p, botJid)) || false
  }

  if (flags.owner && !owner) return m.reply(config.messages?.owner || 'Dueño solamente.')
  if (flags.admin && !admin) return m.reply(config.messages?.admin || 'Admins solamente.')
  if (flags.botAdmin && !botAdmin) return m.reply(config.messages?.bot_admin || 'Hazme admin primero.')

  const run = cmd.run || cmd.execute || cmd.handler
  if (typeof run !== 'function') return

  const lockKey = `${m.chat}:${cmdName}`
  const lockTtl = Number(cmd.lock_ttl || cmd.lockTtl || 3000)

  if (!acquireLock(lockKey, lockTtl)) return

  const startTime = Date.now()

  try {
    await addToQueue(m.chat, senderJid, async () => {
      const result = await run(sock, m, {
        args,
        text,
        prefix,
        command: cmdName,
        command_name: cmdName,
        sender_jid: senderJid,
        sender_id: senderId,
        bot_jid: botJid,
        is_owner: owner,
        is_admin: admin,
        is_bot_admin: botAdmin,
        group_metadata: groupMeta,
        group_admins: groupAdmins,
        group_name: groupName,
        config,
        load_plugins: loadPlugins,
        reload_files: reloadFiles,
        reloadFiles,
        plugins,
        cmdMap
      })

      const elapsed = Date.now() - startTime

      logCmd({
        cmd: cmdName,
        user: m.pushName || senderId || 'User',
        chat: groupName || m.chat,
        ms: elapsed
      })

      return result
    }, {
      timeout: Number(cmd.timeout || 10000),
      cmd: cmdName,
      priority: owner ? 10 : 0
    })
  } finally {
    releaseLock(lockKey)
  }
}
