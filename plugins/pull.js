import { execFile } from 'child_process'
import { promisify } from 'util'
import { performance } from 'perf_hooks'

const exec_file = promisify(execFile)

function cutText(text, limit = 2200) {
  text = String(text || '').trim()
  return text.length > limit ? text.slice(0, limit) + '\n...[recortado]' : text
}

export default {
  command: ['pull'],
  view: ['pull'],
  category: ['owner'],
  is_owner: true,
  timeout: 120000,
  lock_ttl: 120000,

  async run(sock, m, { config, reload_files }) {
    const start = performance.now()
    const cwd = process.cwd()

    try {
      await exec_file('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd,
        timeout: 10000
      })

      const { stdout, stderr } = await exec_file('git', ['pull'], {
        cwd,
        timeout: 120000,
        maxBuffer: 1024 * 1024 * 8
      })

      if (typeof globalThis.reloadAllFiles === 'function') {
        await globalThis.reloadAllFiles()
      } else if (typeof reload_files === 'function') {
        await reload_files()
      }

      const end = performance.now()
      const time = (end - start).toFixed(2)
      const output = cutText([stdout, stderr].filter(Boolean).join('\n')) || 'Sin cambios.'

      await m.reply(
        `🌴 Actualización Realizada!\n\n` +
        `> *=>* Tiempo: ${time} ms\n`
        `*• Result:*\n${output}`
      )
    } catch (err) {
      const output = cutText(err?.stdout || err?.stderr || err?.message || err)

      await m.reply(
        `📍 Fix Failed\n\n` +
        `⚠️ Reason:\n${output}`
      )
    }
  }
}
