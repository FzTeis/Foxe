import { performance } from 'perf_hooks'

export default {
  command: ['ping', 'p'],
  view: ['ping', 'p'],
  category: ['info'],
  noPrefix: ["p", "ping"],
  async run(sock, m) {
    const start = performance.now()

    const msg = await m.reply('`Calculando . . .`')
    if (!msg) return

    const end = performance.now()
    const raw = (end - start).toFixed(2)

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