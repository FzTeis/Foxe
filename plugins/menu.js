import { generateWAMessageFromContent } from 'baileys'
import config from '../config.js'

async function fetchBuffer(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Error descargando thumbnail: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function loadJimp() {
  const mod = await import('jimp')
  return mod.Jimp || mod.default || mod
}

async function getJimpBuffer(image, mime) {
  if (typeof image.getBufferAsync === 'function') {
    return image.getBufferAsync(mime)
  }

  try {
    const result = image.getBuffer(mime)
    if (result instanceof Promise) return await result
  } catch {}

  return new Promise((resolve, reject) => {
    image.getBuffer(mime, (err, buffer) => {
      if (err) reject(err)
      else resolve(buffer)
    })
  })
}

async function resizeThumbnail(thumbnail, size = 400) {
  if (!thumbnail) return null

  try {
    const Jimp = await loadJimp()

    let buffer = thumbnail

    if (typeof thumbnail === 'string' && /^https?:\/\//.test(thumbnail)) {
      buffer = await fetchBuffer(thumbnail)
    }

    if (typeof thumbnail === 'string' && /^data:.*?;base64,/.test(thumbnail)) {
      buffer = Buffer.from(thumbnail.split(',')[1], 'base64')
    }

    if (!Buffer.isBuffer(buffer)) return null

    const image = await Jimp.read(buffer)

    try {
      image.cover(size, size)
    } catch {
      try {
        image.cover({ w: size, h: size })
      } catch {
        image.resize(size, size)
      }
    }

    if (typeof image.quality === 'function') {
      image.quality(85)
    }

    const mime = Jimp.MIME_JPEG || 'image/jpeg'
    return await getJimpBuffer(image, mime)
  } catch (e) {
    console.error('Error redimensionando thumbnail:', e)
    return null
  }
}

function getSender(m) {
  return m.sender || m.key?.participant || m.key?.remoteJid || ''
}

function quotedContext(m) {
  if (!m?.key) return {}

  return {
    stanzaId: m.key.id,
    participant: m.key.participant || m.key.remoteJid,
    quotedMessage: m.message
  }
}

async function sendInteractiveMenu(sock, m, menu) {
  const sender = getSender(m)

  const thumbResized = await resizeThumbnail(
    'https://cdn.adoolab.xyz/dl/9637e621.jpg',
    400
  )

  const nativeFlowPayload = {
    header: {
      documentMessage: {
        url: 'https://mmg.whatsapp.net/v/t62.7119-24/539012045_745537058346694_1512031191239726227_n.enc',
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        fileSha256: Buffer.from('fa09afbc207a724252bae1b764ecc7b13060440ba47a3bf59e77f01924924bfe', 'hex'),
        fileLength: {
          low: -727379969,
          high: 232,
          unsigned: true
        },
        pageCount: 0,
        mediaKey: Buffer.from('3163ba7c8db6dd363c4f48bda2735cc0d0413e57567f0a758f514f282889173c', 'hex'),
        fileName: config.bot_name || 'Menu',
        fileEncSha256: Buffer.from('652f2ff6d8a8dae9f5c9654e386de5c01c623fe98d81a28f63dfb0979a44a22f', 'hex'),
        directPath: '/v/t62.7119-24/539012045_745537058346694_1512031191239726227_n.enc',
        mediaKeyTimestamp: {
          low: 1756370084,
          high: 0,
          unsigned: false
        },
        ...(thumbResized ? { jpegThumbnail: thumbResized } : {}),
        contextInfo: {
          mentionedJid: sender ? [sender] : [],
          groupMentions: [],
          forwardingScore: 777,
          isForwarded: true
        }
      },
      hasMediaAttachment: true
    },

    body: {
      text: menu
    },

    footer: {
      text: '© Simple Bot Of WhatsApp'
    },

    nativeFlowMessage: {
      buttons: [],
      messageParamsJson: '{}'
    },

    contextInfo: {
      mentionedJid: sender ? [sender] : [],
      groupMentions: [],
      forwardingScore: 777,
      isForwarded: true,
      ...quotedContext(m)
    }
  }

  const msg = generateWAMessageFromContent(
    m.chat,
    {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2
          },
          interactiveMessage: nativeFlowPayload
        }
      }
    },
    {
      quoted: m,
      userJid: sock.user?.jid
    }
  )

  return sock.relayMessage(m.chat, msg.message, {
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
      return await sendInteractiveMenu(sock, m, menu.trim())
    } catch (e) {
      console.error('Error enviando menú interactivo:', e)
      return m.reply(menu.trim())
    }
  }
}