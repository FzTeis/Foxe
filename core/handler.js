import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { addToQueue } from './proc.js'

const PLUGINS_DIR = path.resolve('./plugins')
const CONFIG_FILE = path.resolve('./config.js')
const META_TTL = 10 * 60 * 1000
const LID_TTL = 120 * 60 * 1000
const CONFIG_TTL = 5000

const plugins = new Map()
const cmdMap = new Map()
const metaCache = new Map()
const lidCache = new Map()

let loaded = false
let antiLink = null
let configCache = null
let configMtime = 0
let lastConfigFetch = 0

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

  const now = Date.now()
  if (!force && configCache && (now - lastConfigFetch) < CONFIG_TTL) {
    return configCache
  }

  try {
    const stat = fs.statSync(CONFIG_FILE)
    if (!force && configCache && configMtime === stat.mtimeMs) {
      lastConfigFetch = now
      return configCache
    }
    const token = `${Date.now()}-${stat.mtimeMs}`
    const mod = await import(`${pathToFileURL(CONFIG_FILE).href}?update=${token}`)
    configCache = { ...fallback, ...(mod.default || mod.config || {}) }
    configMtime = stat.mtimeMs
    lastConfigFetch = now
    return configCache
  } catch {
    return configCache || fallback
  }
}

function isOwner(jid, config) {
  const raw = rawId(jid)
  const owners = config.owners || []
  for (let i = 0; i < owners.length; i++) {
    if (cleanNum(owners[i]) === raw) return true
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

async function scanDir(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out

  const entries = fs.readdirSync(dir)
  for (const entry of entries) {
    const full = path.join(dir, entry)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) {
      const sub = await scanDir(full)
      for (let i = 0; i < sub.length; i++) out.push(sub[i])
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
  if (!antiLink) {
    antiLink = await loadAntiLink()
  }
  if (typeof antiLink === 'function') {
    try {
      await antiLink(sock, m)
    } catch {}
  }
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
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.id === input || p.lid === input || sameUser(p.id, input) || sameUser(p.lid, input)) {
      if (p?.phoneNumber) {
        const jid = normJid(p.phoneNumber)
        if (jid) {
          lidCache.set(input, jid)
          setTimeout(() => lidCache.delete(input), LID_TTL)
          return jid
        }
      }
      break
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
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] && rawId(ids[i]) === raw) {
      return p?.admin === 'admin' || p?.admin === 'superadmin'
    }
  }
  return false
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
      for (let i = 0; i < aliases.length; i++) {
        cmdMap.set(aliases[i], plugin)
      }

      if (plugin.noPrefix && Array.isArray(plugin.noPrefix)) {
        for (let i = 0; i < plugin.noPrefix.length; i++) {
          const alias = plugin.noPrefix[i]
          if (!cmdMap.has(alias)) {
            cmdMap.set(alias, plugin)
          }
        }
      }
    } catch {}
  }

  loaded = true
}

export async function reloadFiles() {
  configCache = null
  configMtime = 0
  lastConfigFetch = 0
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
  const prefixes = config.prefix || ['.']
  const body = getText(m)

  m.text = body
  m.body = body

  if (typeof m.reply !== 'function') {
    m.reply = async (text, opts = {}) => {
      return sock.sendMessage(m.chat, { text: String(text), ...opts }, { quoted: m })
    }
  }

  m.id = m.key?.id
  m.isGroup = m.chat?.endsWith('@g.us')
  m.sender = m.key?.participant || m.chat
  m.timestamp = m.messageTimestamp
  m.fromMe = m.key?.fromMe || false

  const rawContent = getContent(m.message)
  
  m.hasMedia = !!(rawContent?.imageMessage || rawContent?.videoMessage || rawContent?.audioMessage || rawContent?.documentMessage || rawContent?.stickerMessage)
  
  if (rawContent?.imageMessage) m.type = 'image'
  else if (rawContent?.videoMessage) m.type = 'video'
  else if (rawContent?.audioMessage) m.type = 'audio'
  else if (rawContent?.documentMessage) m.type = 'document'
  else if (rawContent?.stickerMessage) m.type = 'sticker'
  else m.type = 'text'
  
  if (m.hasMedia) {
    m.caption = rawContent?.imageMessage?.caption || rawContent?.videoMessage?.caption || rawContent?.documentMessage?.caption || ''
    m.mimetype = rawContent?.imageMessage?.mimetype || rawContent?.videoMessage?.mimetype || rawContent?.audioMessage?.mimetype || rawContent?.documentMessage?.mimetype || ''
    m.size = rawContent?.imageMessage?.fileLength || rawContent?.videoMessage?.fileLength || rawContent?.audioMessage?.fileLength || rawContent?.documentMessage?.fileLength || 0
  }
  
  const mentionedJids = rawContent?.extendedTextMessage?.contextInfo?.mentionedJid || []
  const textMentions = (body || '').match(/@(\d{5,})/g) || []
  const mentionsSet = new Set(mentionedJids)
  for (const num of textMentions) {
    mentionsSet.add(`${num.slice(1)}@s.whatsapp.net`)
  }
  m.mentions = Array.from(mentionsSet)
  
  const quotedRaw = rawContent?.extendedTextMessage?.contextInfo
  m.isQuoted = !!quotedRaw?.quotedMessage
  
  if (m.isQuoted) {
    const quotedFull = {
      key: {
        remoteJid: m.chat,
        fromMe: false,
        id: quotedRaw.stanzaId,
        participant: quotedRaw.participant || m.sender
      },
      message: quotedRaw.quotedMessage,
      sender: quotedRaw.participant,
      chat: m.chat,
      isGroup: m.isGroup
    }
    
    const quotedType = Object.keys(quotedRaw.quotedMessage)[0]
    const quotedMsgObj = quotedRaw.quotedMessage[quotedType]
    
    quotedFull.type = quotedType
    quotedFull.mimetype = quotedMsgObj?.mimetype || ''
    
    if (quotedMsgObj?.text) {
      quotedFull.text = quotedMsgObj.text
    } else if (quotedMsgObj?.caption) {
      quotedFull.text = quotedMsgObj.caption
    } else if (quotedType === 'conversation') {
      quotedFull.text = quotedRaw.quotedMessage.conversation || ''
    } else if (quotedMsgObj?.extendedTextMessage?.text) {
      quotedFull.text = quotedMsgObj.extendedTextMessage.text
    } else {
      quotedFull.text = ''
    }
    
    quotedFull.hasMedia = !!(quotedRaw.quotedMessage?.imageMessage || quotedRaw.quotedMessage?.videoMessage || quotedRaw.quotedMessage?.audioMessage || quotedRaw.quotedMessage?.documentMessage || quotedRaw.quotedMessage?.stickerMessage)
    
    quotedFull.download = async () => {
      try {
        return await sock.downloadMediaMessage(quotedFull)
      } catch {
        return null
      }
    }
    
    quotedFull.reply = async (text, opts = {}) => {
      return sock.sendMessage(m.chat, { text: String(text), ...opts }, { quoted: quotedFull })
    }
    
    m.quoted = quotedFull
  } else {
    m.quoted = null
  }
  
  m.download = async () => {
    try {
      return await sock.downloadMediaMessage(m)
    } catch {
      return null
    }
  }
  
  m.react = async (emoji) => {
    await sock.sendMessage(m.chat, { react: { text: emoji, key: m.key } })
  }
  
  m.send = async (text, opts = {}) => {
    return sock.sendMessage(m.chat, { text: String(text), ...opts })
  }

  let prefix = null
  for (let i = 0; i < prefixes.length; i++) {
    if (body.startsWith(prefixes[i])) {
      prefix = prefixes[i]
      break
    }
  }

  let cmdName = null
  let args = []
  let cmdText = ''

  if (prefix) {
    const withoutPrefix = body.slice(prefix.length).trim()
    if (withoutPrefix) {
      const parts = withoutPrefix.split(/ +/)
      cmdName = parts[0].toLowerCase()
      args = parts.slice(1)
      cmdText = args.join(' ')
    }
  } else if (body) {
    const parts = body.split(/ +/)
    cmdName = parts[0].toLowerCase()
    args = parts.slice(1)
    cmdText = args.join(' ')
  }

  if (!cmdName) {
    if (!prefix) await runAntiLink(sock, m)
    return
  }

  if (!loaded) await ready

  let cmd = cmdMap.get(cmdName)
  if (!cmd) return

  const flags = getFlags(cmd)
  const senderJid = await fixLid(sock, m)
  const senderId = rawId(senderJid)
  const botJid = sock.decodeJid ? sock.decodeJid(sock.user?.id || '') : sock.user?.id || ''
  const owner = isOwner(senderJid, config)

  m.args = args
  m.cmd = cmdName
  m.prefix = prefix || ''
  m.isOwner = owner

  let groupMeta = null
  let groupName = ''
  let groupAdmins = []
  let admin = false
  let botAdmin = false

  if ((flags.group || flags.admin || flags.botAdmin) && !m.isGroup) {
    await m.reply(config.messages?.group || 'Solo grupos.')
    return
  }

  if (m.isGroup && (flags.group || flags.admin || flags.botAdmin)) {
    groupMeta = await getMeta(sock, m.chat)
    if (groupMeta) {
      groupName = groupMeta.subject || ''
      const participants = groupMeta.participants || []
      groupAdmins = []
      for (let i = 0; i < participants.length; i++) {
        const p = participants[i]
        if (p.admin === 'admin' || p.admin === 'superadmin') {
          groupAdmins.push(p)
        }
      }
      for (let i = 0; i < participants.length; i++) {
        if (isAdmin(participants[i], senderJid)) {
          admin = true
          break
        }
      }
      for (let i = 0; i < participants.length; i++) {
        if (isAdmin(participants[i], botJid)) {
          botAdmin = true
          break
        }
      }
    }
    m.isAdmin = admin
    m.isBotAdmin = botAdmin
    m.groupMetadata = groupMeta
    m.groupName = groupName
    m.groupAdmins = groupAdmins
  }

  if (flags.owner && !owner) {
    await m.reply(config.messages?.owner || 'Dueño solamente.')
    return
  }
  if (flags.admin && !admin) {
    await m.reply(config.messages?.admin || 'Admins solamente.')
    return
  }
  if (flags.botAdmin && !botAdmin) {
    await m.reply(config.messages?.bot_admin || 'Hazme admin primero.')
    return
  }

  const run = cmd.run || cmd.execute || cmd.handler
  if (typeof run !== 'function') return

  const startTime = Date.now()

  try {
    await addToQueue(m.chat, senderJid, async () => {
      await run(sock, m, {
        args,
        text: cmdText,
        prefix: prefix || '',
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
      const time = new Date().toLocaleTimeString('es-HN', {
        timeZone: 'America/Tegucigalpa',
        hour12: false
      })

      console.log(
        `\x1b[35m[${time}]\x1b[0m ` +
        `\x1b[36m${cmdName}\x1b[0m ` +
        `\x1b[90mde\x1b[0m ` +
        `\x1b[33m${m.pushName || senderId || 'User'}\x1b[0m ` +
        `\x1b[90men\x1b[0m ` +
        `\x1b[37m${groupName || m.chat}\x1b[0m ` +
        `\x1b[90m${elapsed}ms\x1b[0m`
      )
    }, {
      timeout: Number(cmd.timeout || 10000),
      cmd: cmdName,
      priority: owner ? 10 : 0
    })
  } catch (err) {
    console.error(`Error en comando ${cmdName}:`, err)
  }
}