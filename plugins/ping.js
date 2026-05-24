import { performance } from 'perf_hooks'

export default {
  command: ['ping', 'p'],
  view: ['ping'],
  category: ['info'],

  async run(sock, m, { config }) {
    const start = performance.now()
    const uptime = process.uptime()
    const memory = process.memoryUsage()
    const ram = (memory.rss / 1024 / 1024).toFixed(2)
    const seconds = Math.floor(uptime % 60)
    const minutes = Math.floor((uptime / 60) % 60)
    const hours = Math.floor((uptime / 3600) % 24)
    const days = Math.floor(uptime / 86400)
    const end = performance.now()
    const ping = (end - start).toFixed(3)

    await m.reply(
      `📍 Pong\n\n` +
      `> *=>* Ping: ${ping} ms\n` +
      `> *=>* Uptime: ${days}d ${hours}h ${minutes}m ${seconds}s\n` +
      `> *=>* RAM: ${ram} MB`
    )
  }
}