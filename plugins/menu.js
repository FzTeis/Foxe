import { generateWAMessageFromContent } from 'baileys'
import config from '../config.js'

async function fetchBuffer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Error descargando thumbnail: ${res.status}`)
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

async function resolveThumbnail(thumbnail) {
  if (!thumbnail) return ''

  try {
    let buf = thumbnail

    if (typeof thumbnail === 'string' && /^https?:\/\//.test(thumbnail)) {
      buf = await fetchBuffer(thumbnail)
    }

    if (typeof thumbnail === 'string' && /^data:.*?;base64,/.test(thumbnail)) {
      buf = Buffer.from(thumbnail.split(',')[1], 'base64')
    }

    if (Buffer.isBuffer(buf)) return buf.toString('base64')
  } catch (_) {}

  return ''
}

async function sendModify(sock, jid, text = '', opts = {}) {
  const {
    title = '',
    body = '',
    description = '',
    thumbnail,
    matchedText = 'https://chat.whatsapp.com',
    quoted,
    mentions = [],
    dimension = false
  } = opts

  const jpegThumbnail = await resolveThumbnail(thumbnail)
  const finalText = matchedText && !text.includes(matchedText)
    ? text + '\n' + matchedText
    : text

  const contextInfo = {
    mentionedJid: mentions,
    groupMentions: [],
    statusAttributions: [],
    ...(quoted
      ? {
          stanzaId: quoted.key?.id,
          participant: quoted.key?.participant || quoted.key?.remoteJid,
          quotedMessage: quoted.message
        }
      : {})
  }

  const content = {
    extendedTextMessage: {
      text: finalText,
      matchedText,
      title,
      description: description || body,
      previewType: 0,
      renderLargerThumbnail: dimension,
      ...(jpegThumbnail ? { jpegThumbnail } : {}),
      contextInfo,
      inviteLinkGroupTypeV2: 0
    }
  }

  const msg = generateWAMessageFromContent(jid, content, {
    ...(quoted ? { quoted } : {}),
    userJid: sock.user?.jid
  })

  return sock.relayMessage(jid, msg.message, {
    messageId: msg.key.id
  })
}

function toArray(value) {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function unique(arr) {
  return [...new Set(arr.filter(Boolean))]
}

function getPlugins(ctx = {}) {
  const source =
    ctx.plugins ||
    ctx.plugin_list ||
    ctx.commands ||
    globalThis.plugins ||
    globalThis.commands ||
    []

  if (source instanceof Map) return [...source.values()]
  if (Array.isArray(source)) return source
  if (typeof source === 'object') return Object.values(source)

  return []
}

export default {
  command: ['menu', 'help', 'comandos'],
  view: ['menu', 'help', 'comandos'],
  category: ['info'],

  async run(sock, m, ctx = {}) {
    const plugins = getPlugins(ctx)

    if (!plugins.length) return m.reply('No hay comandos cargados.')

    const categories = new Map()

    for (const plugin of plugins) {
      if (!plugin || plugin.disabled || plugin.hidden) continue

      const views = unique(
        toArray(plugin.view || plugin.command)
          .map(v => String(v || '').trim())
      )

      if (!views.length) continue

      const pluginCategories = unique(
        toArray(plugin.category || 'otros')
          .map(c => String(c || 'otros').trim().toLowerCase())
      )

      for (const category of pluginCategories) {
        if (!categories.has(category)) categories.set(category, [])
        categories.get(category).push(...views)
      }
    }

    if (categories.size === 0) return m.reply('No hay comandos cargados.')

    let menu = `🌳 Hola, soy *${config.bot_name}*, aquí está la lista de comandos disponibles.\n\n`

    for (const category of [...categories.keys()].sort()) {
      const cmds = unique(categories.get(category)).sort()

      menu += `*${category.toUpperCase()}*\n`
      menu += cmds.map(c => `. # 🌲 *${c}*`).join('\n')
      menu += '\n\n'
    }

    try {
      return await sendModify(sock, m.chat, menu.trim(), {
        title: config.bot_name,
        body: '© Simple Bot Of WhatsApp',
        description: '',
        thumbnail: 'https://cdn.adoolab.xyz/dl/9637e621.jpg',
        quoted: m,
        matchedText: '',
        dimension: true
      })
    } catch (e) {
      console.error(e)
      return m.reply(menu.trim())
    }
  }
}