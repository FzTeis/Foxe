import { execFile } from 'child_process'
import { promisify } from 'util'
import { performance } from 'perf_hooks'

const exec_file = promisify(execFile)

function cutText(text, limit = 2200) {
  text = String(text || '').trim()
  return text.length > limit ? text.slice(0, limit) + '\n...[recortado]' : text
}

function errorOutput(err) {
  return [err?.stdout, err?.stderr, err?.message, String(err || '')]
    .filter(Boolean)
    .join('\n')
}

export default {
  command: ['pull'],
  view: ['pull'],
  category: ['owner'],
  is_owner: true,
  timeout: 120000,
  lock_ttl: 120000,

  async run(sock, m, { reload_files, reload_all_files, load_plugins } = {}) {
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

      const reloader =
        typeof reload_files === 'function' ? reload_files :
        typeof reload_all_files === 'function' ? reload_all_files :
        typeof load_plugins === 'function' ? load_plugins :
        typeof globalThis.reloadAllFiles === 'function' ? globalThis.reloadAllFiles :
        null

      const reloadResult = reloader ? await reloader() : null
      const end = performance.now()
      const time = (end - start).toFixed(2)
      const output = cutText([stdout, stderr].filter(Boolean).join('\n')) || 'Sin cambios.'
      const reloadText = reloadResult
        ? `${reloadResult.plugins ?? 0} plugins / ${reloadResult.commands ?? 0} comandos`
        : 'No disponible'

      await m.reply(
        `🌴 Actualización Realizada!\n\n` +
        `> *=>* Tiempo: ${time} ms\n` +
        `> *=>* Recargado: ${reloadText}\n\n` +
        `*• Result:*\n${output}`
      )
    } catch (err) {
      const output = cutText(errorOutput(err)) || 'Error desconocido.'

      await m.reply(
        `📍 Fix Failed\n\n` +
        `⚠️ Reason:\n${output}`
      )
    }
  }
}
