import { cmdMap } from '../core/handler.js'
import config from '../config.js'

const cmd = {
  command: ['menu', 'help', 'comandos'],
  run: async (sock, m) => {
    if (cmdMap.size === 0) return m.reply('No hay comandos cargados.')

    const cmds = [...new Set(cmdMap.keys())].sort()

    let menu = `🌳 Hola, soy *${config.bot_name}*, aquí está la lista de comandos disponibles.\n\n`

    menu += cmds.map(c => `. # 🌲 *${c}*`).join('\n')

    await m.reply(menu)
  }
}

export default cmd