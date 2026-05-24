import fs from 'fs'
import path from 'path'

const queues = new Map()
const locks = new Map()
const timers = new Map()

const MAX_CONCURRENT = 16
const QUEUE_TIMEOUT = 120000
const CMD_TIMEOUT = 10000
const MAX_QUEUE_PER_CHAT = 50

function clean(str) {
  return String(str || '').trim()
}

function now() {
  return Date.now()
}

function getChatKey(chat) {
  return clean(chat)
}

function createQueue(chatKey) {
  if (queues.has(chatKey)) return queues.get(chatKey)

  const q = {
    items: [],
    running: 0,
    lastActive: now()
  }

  queues.set(chatKey, q)
  return q
}

function clearIdleQueues() {
  const cutoff = now() - QUEUE_TIMEOUT

  for (const [key, q] of queues) {
    if (q.running === 0 && q.items.length === 0 && q.lastActive < cutoff) {
      queues.delete(key)
    }
  }
}

function scheduleCleanup() {
  timers.set('queueCleanup', setInterval(clearIdleQueues, 60000))
}

export function initProc() {
  scheduleCleanup()
}

export function destroyProc() {
  for (const timer of timers.values()) {
    clearInterval(timer)
  }
  timers.clear()
  queues.clear()
  locks.clear()
}

export function acquireLock(key, ttl = 5000) {
  const lockKey = clean(key)
  const existing = locks.get(lockKey)

  if (existing && now() - existing.ts < existing.ttl) {
    return false
  }

  locks.set(lockKey, { ts: now(), ttl })
  return true
}

export function releaseLock(key) {
  locks.delete(clean(key))
}

export async function addToQueue(chat, user, fn, opts = {}) {
  const chatKey = getChatKey(chat)
  const q = createQueue(chatKey)

  const {
    timeout = CMD_TIMEOUT,
    cmd = '',
    priority = 0
  } = opts

  q.lastActive = now()

  return new Promise((resolve, reject) => {
    const job = {
      fn,
      chat: chatKey,
      timeout,
      cmd,
      priority,
      resolve,
      reject,
      created: now()
    }

    if (priority > 0) {
      const insertAt = q.items.findIndex(item => (item.priority || 0) < priority)
      if (insertAt >= 0) {
        q.items.splice(insertAt, 0, job)
      } else {
        q.items.unshift(job)
      }
    } else {
      if (q.items.length >= MAX_QUEUE_PER_CHAT) {
        const oldest = q.items.shift()
        if (oldest) oldest.resolve(null)
      }
      q.items.push(job)
    }

    processQueue(chatKey)
  })
}

function processQueue(chatKey) {
  const q = queues.get(chatKey)
  if (!q) return

  while (q.running < MAX_CONCURRENT && q.items.length > 0) {
    const job = q.items.shift()
    if (job) executeJob(chatKey, q, job)
  }
}

async function executeJob(chatKey, q, job) {
  q.running++

  let resolved = false
  let timer = null

  const finish = (err, result) => {
    if (resolved) return
    resolved = true

    if (timer) clearTimeout(timer)

    q.running = Math.max(0, q.running - 1)
    q.lastActive = now()

    if (err) {
      job.reject(err)
    } else {
      job.resolve(result)
    }

    processQueue(chatKey)
  }

  timer = setTimeout(() => {
    finish(new Error('CMD_TIMEOUT'), null)
  }, job.timeout)

  try {
    const result = await job.fn()
    finish(null, result)
  } catch (err) {
    finish(err, null)
  }
}

export function getStats() {
  let totalQueued = 0
  let totalRunning = 0
  let activeQueues = 0

  for (const q of queues.values()) {
    totalQueued += q.items.length
    totalRunning += q.running
    if (q.items.length > 0 || q.running > 0) activeQueues++
  }

  return {
    activeQueues,
    totalQueued,
    totalRunning,
    maxConcurrent: MAX_CONCURRENT,
    lockCount: locks.size
  }
}

export function flushQueue(chat) {
  const chatKey = getChatKey(chat)
  const q = queues.get(chatKey)
  if (!q) return 0

  const count = q.items.length

  for (const job of q.items) {
    job.resolve(null)
  }

  q.items = []
  return count
}

export function flushAll() {
  let total = 0

  for (const [key, q] of queues) {
    for (const job of q.items) {
      job.resolve(null)
    }
    total += q.items.length
    q.items = []
  }

  return total
}