import { cmdMap } from '../core/handler.js'
import config from '../config.js'

const cmd = {
  command: ['menu', 'help', 'comandos'],
  run: async (sock, m, { prefix, is_owner }) => {
    const cats = new Map()

    for (const [alias, plugin] of cmdMap) {
      if (plugin.is_owner || plugin.isOwner || plugin.owner) {
        if (!is_owner) continue
      }

      if (plugin.is_admin || plugin.isAdmin || plugin.admin) continue
      if (plugin.is_bot_admin || plugin.isBotAdmin || plugin.botAdmin) continue

      const cat = plugin.category || plugin.cat || plugin.group || 'Sin categoría'

      if (!cats.has(cat)) cats.set(cat, [])
      cats.get(cat).push(alias)
    }

    let menu = `🌳 Hola, soy *${config.bot_name}*, aquí está la lista de comandos disponibles.\n\n`

    for (const [cat, cmds] of cats) {
      cmds.sort()
      menu += `• 🌴 - *${cat.toUpperCase()}*\n\n`
      menu += cmds.map(c => `. # 🌲 *${c}*`).join('\n')
      menu += '\n\n'
    }

    await m.reply(menu.trimEnd())
  }
}

export default cmd