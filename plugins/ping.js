const cmd = {
  command: ['ping', 'p'],
  run: async (sock, m) => {
    const start = Date.now()

    const msg = await m.reply('`Calculando . . .`')

    if (!msg) return

    const end = Date.now()
    const raw = end - start

    try {
      await sock.sendMessage(m.chat, {
        text: `🍃 ¡ Pong ! :: *${raw}ms*`,
        edit: msg.key
      })
    } catch {
      await m.reply(`🍃 ¡ Pong ! :: *${raw}ms*`)
    }
  }
}

export default cmd