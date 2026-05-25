const cmd = {
  command: ['testmention', 'tm'],
  run: async (lunex, m) => {
    try {
      const from = m.chat
      const sender2 = m.sender

      await lunex.sendMessage(from, {
        text: `This is just a test, my noble friend.\n\n@${sender2.split('@')[0]}`,
        contextInfo: {
          remoteJid: from,
          mentionedJid: [sender2]
        }
      })
    } catch (e) {
      console.error(e)
      await m.reply('❌ Error enviando el mensaje con mención.')
    }
  }
}

export default cmd