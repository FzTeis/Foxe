import fs from 'fs'
import path from 'path'
import database from 'better-sqlite3'
import { initAuthCreds, BufferJSON, proto } from 'baileys'

const DB_DIR = './auth'

export function useAuth(file) {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

  const db = new database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('cache_size = -8000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_auth_key ON auth(key);
  `)

  const getStmt = db.prepare('SELECT value FROM auth WHERE key = ?')
  const setStmt = db.prepare('INSERT OR REPLACE INTO auth (key, value) VALUES (?, ?)')
  const delStmt = db.prepare('DELETE FROM auth WHERE key = ?')
  const clearStmt = db.prepare('DELETE FROM auth')
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM auth')
  const oldKeysStmt = db.prepare(`
    DELETE FROM auth WHERE key LIKE 'app-state-sync-key:%' AND key NOT IN (
      SELECT key FROM auth WHERE key LIKE 'app-state-sync-key:%' ORDER BY key DESC LIMIT 50
    )
  `)

  let vaccuumTimer = null

  function read(key) {
    try {
      const row = getStmt.get(key)
      if (!row) return null
      return JSON.parse(row.value, BufferJSON.reviver)
    } catch {
      return null
    }
  }

  function write(key, value) {
    const json = JSON.stringify(value, BufferJSON.replacer)
    setStmt.run(key, json)
  }

  function remove(key) {
    delStmt.run(key)
  }

  function vacuum() {
    try {
      const { count } = countStmt.get()
      if (count > 5000) {
        oldKeysStmt.run()
        db.exec('PRAGMA incremental_vacuum')
      }
    } catch {}
  }

  function scheduleVacuum() {
    if (vaccuumTimer) clearTimeout(vaccuumTimer)
    vaccuumTimer = setTimeout(() => {
      vacuum()
      scheduleVacuum()
    }, 15 * 60 * 1000)
  }

  scheduleVacuum()

  const creds = read('creds') || initAuthCreds()

  const setMany = db.transaction((data) => {
    for (const category in data) {
      for (const id in data[category]) {
        const value = data[category][id]
        const key = `${category}:${id}`
        if (value) write(key, value)
        else remove(key)
      }
    }
  })

  const state = {
    creds,
    keys: {
      get: async (type, ids) => {
        const result = {}
        for (const id of ids) {
          const key = `${type}:${id}`
          let value = read(key)
          if (type === 'app-state-sync-key' && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value)
          }
          result[id] = value
        }
        return result
      },
      set: async (data) => {
        setMany(data)
      }
    }
  }

  return {
    state,
    saveCreds: async () => {
      write('creds', state.creds)
    },
    clear: () => {
      if (vaccuumTimer) clearTimeout(vaccuumTimer)
      clearStmt.run()
    },
    close: () => {
      if (vaccuumTimer) clearTimeout(vaccuumTimer)
      vacuum()
      db.close()
    }
  }
}

export function makeCacheableKeyStore(keys, logger) {
  const cache = new Map()
  const MAX = 5000
  let hits = 0
  let misses = 0
  let lastLog = Date.now()

  function evict() {
    if (cache.size <= MAX) return
    const toDelete = Math.floor(cache.size * 0.3)
    const entries = [...cache.entries()]
    entries.sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0))
    for (let i = 0; i < toDelete; i++) {
      if (entries[i]) cache.delete(entries[i][0])
    }
  }

  function logStats() {
    const now = Date.now()
    if (now - lastLog < 300000) return
    const total = hits + misses
    const rate = total > 0 ? ((hits / total) * 100).toFixed(1) : '0.0'
    const size = cache.size
    const memEstimate = (size * 2.5 / 1024).toFixed(1)
    if (logger?.info) logger.info(`Signal cache: ${size} keys (~${memEstimate}KB) | hit rate: ${rate}%`)
    hits = 0
    misses = 0
    lastLog = now
  }

  return {
    get: async (type, ids) => {
      const result = {}
      const missing = []

      for (const id of ids) {
        const cacheKey = `${type}:${id}`
        const cached = cache.get(cacheKey)
        if (cached) {
          hits++
          result[id] = cached.value
        } else {
          misses++
          missing.push(id)
        }
      }

      if (missing.length > 0) {
        const fromDB = await keys.get(type, missing)
        for (const id of missing) {
          const cacheKey = `${type}:${id}`
          const value = fromDB[id]
          if (value) {
            cache.set(cacheKey, { value, ts: Date.now() })
            result[id] = value
          }
        }
      }

      if (cache.size > MAX) evict()
      logStats()
      return result
    },

    set: async (data) => {
      await keys.set(data)
      for (const category in data) {
        for (const id in data[category]) {
          const value = data[category][id]
          const cacheKey = `${category}:${id}`
          if (value) {
            cache.set(cacheKey, { value, ts: Date.now() })
          } else {
            cache.delete(cacheKey)
          }
        }
      }
      if (cache.size > MAX) evict()
    },

    clear: () => {
      cache.clear()
    },

    stats: () => ({
      size: cache.size,
      max: MAX,
      hits,
      misses
    })
  }
}