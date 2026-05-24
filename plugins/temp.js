const cmd = {
  command: ['getidgrupo', 'gid', 'groupid'],
  run: async (sock, m) => {
    try {
      const text =
        m.text ||
        m.body ||
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        ''

      const args = text.trim().split(/\s+/).slice(1).join(' ')

      if (!args) {
        return m.reply(
          '🍃 Usa el comando así:\n\n' +
          '`getidgrupo https://chat.whatsapp.com/XXXXXXXXXXXXXXX`'
        )
      }

      const link = args.trim()

      const match = link.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i)

      if (!match) {
        return m.reply('❌ Ese no parece ser un enlace válido de grupo.')
      }

      const code = match[1]

      const info = await sock.groupGetInviteInfo(code)

      if (!info?.id) {
        return m.reply('❌ No pude obtener el ID del grupo.')
      }

      const msg =
        `🍃 *Información del grupo*\n\n` +
        `*Nombre:* ${info.subject || 'Desconocido'}\n` +
        `*ID:* \`${info.id}\`\n` +
        `*Participantes:* ${info.size || info.participants?.length || 'Desconocido'}\n` +
        `*Código:* \`${code}\``

      await m.reply(msg)
    } catch (e) {
      console.error(e)

      let error = '❌ No pude obtener la información del grupo.'

      if (String(e).includes('not-authorized')) {
        error = '❌ El enlace no es válido, expiró o no tengo permiso para verlo.'
      }

      await m.reply(error)
    }
  }
}

export default cmd