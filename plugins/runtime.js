const tesis_uwu = Date.now()

function formatRuntime(ms) {
const totalSeconds = Math.floor(ms / 1000)
const days = Math.floor(totalSeconds / 86400)
const hours = Math.floor((totalSeconds % 86400) / 3600)
const minutes = Math.floor((totalSeconds % 3600) / 60)
const seconds = totalSeconds % 60

const parts = []
if (days) parts.push(`${days}d`)
if (hours) parts.push(`${hours}h`)
if (minutes) parts.push(`${minutes}m`)
parts.push(`${seconds}s`)
return parts.join(' ')
}

export default { command: ['run', 'uptime'], view: ['nose'], category: ['info'],
async run(sock, m) {
const elapsed = Date.now() - tesis_uwu
const uptime = formatRuntime(elapsed)
const mem = process.memoryUsage()
const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(1)
const rssMB = (mem.rss / 1024 / 1024).toFixed(1)
const text = `\`⿻  Runtime:\`
⏰ » ${uptime}`
return m.reply(text)
  }
}
