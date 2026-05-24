import fs from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import config from '../config.js'

const plugin_cache = new Map()
const command_index = new Map()
const group_metadata_cache = new Map()
const lid_cache = new Map()
const metadata_ttl = 5 * 60 * 1000
const lid_ttl = 30 * 60 * 1000
const plugins_dir = path.resolve('./plugins')
let cache_loaded = false
let anti_link_cache = null

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m'
}

const log = {
  info: text => console.log(`${c.cyan}${c.bold} INFO  ${c.reset} ${text}`),
  success: text => console.log(`${c.green}${c.bold}  OK   ${c.reset} ${text}`),
  warn: text => console.log(`${c.yellow}${c.bold} WARN  ${c.reset} ${text}`),
  error: text => console.log(`${c.red}${c.bold} ERROR ${c.reset} ${text}`)
}

function clean_number(value) {
  return String(value || '').replace(/\D/g, '')
}

function get_raw_id(jid) {
  return String(jid || '').split('@')[0].split(':')[0]
}

function normalize_jid(value) {
  if (!value) return ''
  const text = String(value)
  if (text.includes('@')) return text
  const number = clean_number(text)
  return number ? `${number}@s.whatsapp.net` : text
}

function create_jid_set(list = []) {
  const set = new Set()
  for (const item of list) {
    const jid = normalize_jid(item)
    if (jid) set.add(jid)
  }
  return set
}

const owner_set = create_jid_set(config.owners || [])

function is_owner_jid(jid) {
  const raw = get_raw_id(jid)
  for (const owner of config.owners || []) {
    if (clean_number(owner) === raw) return true
  }
  return owner_set.has(jid)
}

function set_lid_cache(key, value) {
  if (!key || !value) return
  lid_cache.set(key, value)
  setTimeout(() => lid_cache.delete(key), lid_ttl)
}

function normalize_to_jid(phone) {
  if (!phone) return null
  const base = typeof phone === 'number' ? phone.toString() : String(phone).replace(/\D/g, '')
  return base ? `${base}@s.whatsapp.net` : null
}

function same_user(a, b) {
  const raw_a = get_raw_id(a)
  const raw_b = get_raw_id(b)
  return raw_a && raw_b && raw_a === raw_b
}

function strip_ansi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, '')
}

function get_message_content(message) {
  if (!message) return null
  if (message.ephemeralMessage) return get_message_content(message.ephemeralMessage.message)
  if (message.viewOnceMessage) return get_message_content(message.viewOnceMessage.message)
  if (message.viewOnceMessageV2) return get_message_content(message.viewOnceMessageV2.message)
  if (message.documentWithCaptionMessage) return get_message_content(message.documentWithCaptionMessage.message)
  return message
}

function get_message_text(m) {
  const content = get_message_content(m.message)
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

function get_files(dir) {
  let results = []
  if (!fs.existsSync(dir)) return results
  const files = fs.readdirSync(dir)
  for (const file of files) {
    const file_path = path.join(dir, file)
    const stat = fs.statSync(file_path)
    if (stat.isDirectory()) results = results.concat(get_files(file_path))
    else if (file.endsWith('.js') || file.endsWith('.mjs')) results.push(file_path)
  }
  return results
}

async function load_anti_link() {
  const anti_link_paths = [
    path.resolve('./plugins/antilink.js'),
    path.resolve('./core/plugins/antilink.js')
  ]
  for (const anti_link_file of anti_link_paths) {
    if (!fs.existsSync(anti_link_file)) continue
    try {
      const stat = fs.statSync(anti_link_file)
      const url = `${pathToFileURL(anti_link_file).href}?update=${stat.mtimeMs}`
      const mod = await import(url)
      anti_link_cache = mod.anti_link || mod.antiLink || mod.default || null
      return anti_link_cache
    } catch {
      return null
    }
  }
  return null
}

async function run_anti_link(sock, m) {
  try {
    const anti_link = anti_link_cache || await load_anti_link()
    if (typeof anti_link === 'function') await anti_link(sock, m)
  } catch {}
}

async function get_group_metadata(sock, chat) {
  if (!chat?.endsWith('@g.us')) return null
  const cached = group_metadata_cache.get(chat)
  if (cached && Date.now() - cached.timestamp < metadata_ttl) return cached.metadata
  try {
    const metadata = await sock.groupMetadata(chat)
    group_metadata_cache.set(chat, { metadata, timestamp: Date.now() })
    return metadata
  } catch {
    return null
  }
}

async function resolve_lid_to_real_jid(lid, sock, chat) {
  const input = String(lid || '').trim()
  if (!input) return input
  if (!chat?.endsWith('@g.us')) return input
  if (input.endsWith('@s.whatsapp.net')) return input
  if (lid_cache.has(input)) return lid_cache.get(input)

  const metadata = await get_group_metadata(sock, chat)
  const participants = metadata?.participants || []
  const participant = participants.find(p => p.id === input || p.lid === input || same_user(p.id, input) || same_user(p.lid, input))

  if (participant?.phoneNumber) {
    const real_jid = normalize_to_jid(participant.phoneNumber)
    if (real_jid) {
      set_lid_cache(input, real_jid)
      return real_jid
    }
  }

  const alt_participant = participants.find(p => p.id === input || p.lid === input)

  if (alt_participant?.phoneNumber) {
    const real_jid = normalize_to_jid(alt_participant.phoneNumber)
    if (real_jid) {
      set_lid_cache(input, real_jid)
      return real_jid
    }
  }

  return input
}

async function fix_lid(sock, m) {
  const chat = m.chat || m.key?.remoteJid || ''
  const sender = m.sender || m.key?.participant || chat || ''
  const decoded = typeof sock.decodeJid === 'function' ? sock.decodeJid(sender) : sender

  if (chat.endsWith('@g.us')) return await resolve_lid_to_real_jid(decoded, sock, chat)

  if (decoded.includes('@lid')) {
    try {
      const result = await sock.onWhatsApp(decoded)
      if (result?.length > 0 && result[0]?.jid) {
        set_lid_cache(decoded, result[0].jid)
        return result[0].jid
      }
    } catch {
      return decoded
    }
  }

  return decoded
}

function is_admin_participant(participant, jid) {
  const raw = get_raw_id(jid)
  const ids = [participant?.id, participant?.lid, participant?.phoneNumber]
  const match = ids.some(id => id && get_raw_id(id) === raw)
  const admin = participant?.admin === 'admin' || participant?.admin === 'superadmin'
  return match && admin
}

function get_command_flags(cmd) {
  return {
    owner: !!(cmd.is_owner || cmd.isOwner || cmd.owner),
    group: !!(cmd.is_group || cmd.isGroup || cmd.group),
    admin: !!(cmd.is_admin || cmd.isAdmin || cmd.admin),
    bot_admin: !!(cmd.is_bot_admin || cmd.isBotAdmin || cmd.botAdmin)
  }
}

function normalize_command_list(command) {
  if (!command) return []
  if (Array.isArray(command)) return command.map(cmd => String(cmd).toLowerCase())
  return [String(command).toLowerCase()]
}

function print_command_log(data) {
  const w = 43
  const top = `${c.magenta}┌${'─'.repeat(w)}┐${c.reset}`
  const bot = `${c.magenta}└${'─'.repeat(w)}┘${c.reset}`
  const sep = `${c.magenta}├${'─'.repeat(w)}┤${c.reset}`

  const line = (emoji, label, value) => {
    const content = ` ${emoji} ${label} ${c.dim}·${c.reset} ${value}`
    const visible_length = strip_ansi(content).length
    const plain = strip_ansi(content)
    const padded = visible_length > w ? plain.slice(0, w - 1) + '…' : content + ' '.repeat(w - visible_length)
    return `${c.magenta}│${c.reset}${padded}${c.magenta}│${c.reset}`
  }

  const rows = [
    line('🐢', 'BOT', `${c.cyan}${data.bot}${c.reset}`),
    line('🌾', 'CMD', `${c.green}${data.cmd}${c.reset}`),
    line('🦖', 'USER', `${c.yellow}${data.user}${c.reset}`),
    line('🍄', 'CHAT', `${c.white}${data.chat}${c.reset}`),
    line('🌴', 'TIME', `${c.gray}${data.time}${c.reset}`)
  ]

  console.log('')
  console.log(top)
  console.log(rows[0])
  console.log(sep)
  console.log(rows[1])
  console.log(sep)
  console.log(rows[2])
  console.log(sep)
  console.log(rows[3])
  console.log(sep)
  console.log(rows[4])
  console.log(bot)
  console.log('')
}

export async function load_plugins() {
  plugin_cache.clear()
  command_index.clear()

  if (!fs.existsSync(plugins_dir)) {
    cache_loaded = true
    log.warn('No existe la carpeta ./plugins todavía.')
    return
  }

  const plugin_files = get_files(plugins_dir)

  for (const full_path of plugin_files) {
    try {
      const stat = fs.statSync(full_path)
      const url = `${pathToFileURL(full_path).href}?update=${stat.mtimeMs}`
      const mod = await import(url)
      const plugin = mod.default || mod

      if (!plugin?.command) continue

      plugin_cache.set(full_path, plugin)

      const commands = normalize_command_list(plugin.command)
      for (const alias of commands) command_index.set(alias, plugin)
    } catch (err) {
      log.error(`Error cargando plugin ${path.basename(full_path)}: ${err.message}`)
    }
  }

  cache_loaded = true
  log.success(`${plugin_cache.size} plugins cargados.`)
}

export const plugins_ready = load_plugins()

export {
  plugin_cache,
  command_index,
  resolve_lid_to_real_jid,
  fix_lid
}

export default async function handler(sock, m) {
  try {
    if (!m?.message) return

    const prefixes = Array.isArray(config.prefix) ? config.prefix : [String(config.prefix || '.')]
    const body = get_message_text(m)

    m.text = body
    m.body = body

    if (typeof m.reply !== 'function') {
      m.reply = async (text, options = {}) => {
        return sock.sendMessage(m.chat, { text: String(text), ...options }, { quoted: m })
      }
    }

    const prefix = prefixes.find(p => body.startsWith(p))

    if (!prefix) {
      await run_anti_link(sock, m)
      return
    }

    const without_prefix = body.slice(prefix.length).trim()
    if (!without_prefix) return

    const args = without_prefix.split(/ +/)
    const command_name = String(args.shift() || '').toLowerCase()
    const text = args.join(' ')
    const command = command_name

    if (!cache_loaded) await plugins_ready

    const cmd = command_index.get(command_name)
    if (!cmd) return

    const flags = get_command_flags(cmd)
    const sender_jid = await fix_lid(sock, m)
    const sender_id = get_raw_id(sender_jid)
    const bot_jid = sock.decodeJid ? sock.decodeJid(sock.user?.id || '') : sock.user?.id || ''
    const is_owner = is_owner_jid(sender_jid)

    let group_metadata = null
    let group_name = ''
    let group_admins = []
    let is_admin = false
    let is_bot_admin = false

    if ((flags.group || flags.admin || flags.bot_admin) && !m.isGroup) {
      return m.reply(config.messages?.group || 'Grupos solamente.')
    }

    if (m.isGroup && (flags.group || flags.admin || flags.bot_admin)) {
      group_metadata = await get_group_metadata(sock, m.chat)
      group_name = group_metadata?.subject || ''
      group_admins = group_metadata?.participants?.filter(p => p.admin === 'admin' || p.admin === 'superadmin') || []
      is_admin = group_metadata?.participants?.some(p => is_admin_participant(p, sender_jid)) || false
      is_bot_admin = group_metadata?.participants?.some(p => is_admin_participant(p, bot_jid)) || false
    }

    const time = new Date().toLocaleTimeString('es-HN', {
      timeZone: 'America/Tegucigalpa',
      hour12: false
    })

    print_command_log({
      bot: config.bot_name || 'Foxe',
      cmd: command_name,
      user: m.pushName || sender_id || 'User',
      chat: group_name || m.chat,
      time
    })

    if (flags.owner && !is_owner) return m.reply(config.messages?.owner || 'Dueño solamente.')
    if (flags.admin && !is_admin) return m.reply(config.messages?.admin || 'Admins solamente.')
    if (flags.bot_admin && !is_bot_admin) return m.reply(config.messages?.bot_admin || 'Hazme admin primero.')

    const run = cmd.run || cmd.execute || cmd.handler
    if (typeof run !== 'function') return m.reply('Este comando no tiene función ejecutable.')

    return await run(sock, m, {
      args,
      text,
      prefix,
      command,
      command_name,
      sender_jid,
      sender_id,
      bot_jid,
      is_owner,
      is_admin,
      is_bot_admin,
      group_metadata,
      group_admins,
      group_name,
      config,
      load_plugins
    })
  } catch (err) {
    log.error(`Error en handler: ${err.message}`)
    console.error(err)
  }
}