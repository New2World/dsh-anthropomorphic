// 按 personaId 物理隔离的状态持久化、进程内串行互斥锁（Mutex）与 JSONL 审计/归档日志。
// 对只读沙盒目录提供内存兜底，保证插件在受限环境下挂载不崩溃。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir, readJson, writeJson } from '../core/store.js'
import {
  safePersonaId,
  normalizePersonalityState,
  normalizeEmotionState,
} from './schema.js'

const MAX_JSONL_LINES = 2000
const TRIM_TO_LINES = 1400

export function createEngineStorage({ baseDir = () => dataDir('persona-engine'), log } = {}) {
  const mutexes = new Map() // personaKey -> Promise chain
  const memFallback = new Map() // `${root}|${personaId}|${key}` -> cloned state (只读磁盘兜底)

  const rootOf = () => (typeof baseDir === 'function' ? baseDir() : baseDir)
  const dirOf = (personaId) => join(rootOf(), safePersonaId(personaId))
  const fileOf = (personaId, name) => join(dirOf(personaId), name)
  const memKey = (personaId, name) => `${rootOf()}|${safePersonaId(personaId)}|${name}`

  /**
   * 同一 personaId 下的状态修改串行化执行，消除异步评估并发写覆盖（Lost Update）。
   */
  function withMutex(personaId, fn) {
    const key = `${rootOf()}|${safePersonaId(personaId)}`
    const prev = mutexes.get(key) || Promise.resolve()
    const run = prev.then(() => fn(), () => fn())
    const settled = run.then(() => {}, () => {})
    mutexes.set(key, settled)
    return run
  }

  function readStateFile(personaId, name) {
    const f = fileOf(personaId, name)
    if (existsSync(f)) {
      const parsed = readJson(f, null)
      if (parsed) return parsed
    }
    const hit = memFallback.get(memKey(personaId, name))
    return hit ? structuredClone(hit) : null
  }

  function writeStateFile(personaId, name, state) {
    const copy = structuredClone(state)
    memFallback.set(memKey(personaId, name), copy)
    try {
      writeJson(fileOf(personaId, name), state)
      return true
    } catch (error) {
      log?.debug?.(`状态写入磁盘失败，暂留内存兜底（${name}）：`, error.message)
      return false
    }
  }

  function loadPersonality(personaId, seeds = null, now = Date.now()) {
    const raw = readStateFile(personaId, 'personality.json')
    return normalizePersonalityState(raw, personaId, seeds, now)
  }

  function savePersonality(personaId, state) {
    writeStateFile(personaId, 'personality.json', state)
    return state
  }

  function loadEmotion(personaId, baselines = {}, now = Date.now()) {
    const raw = readStateFile(personaId, 'emotion.json')
    return normalizeEmotionState(raw, personaId, baselines, now)
  }

  function saveEmotion(personaId, state) {
    writeStateFile(personaId, 'emotion.json', state)
    return state
  }

  function appendJsonl(personaId, filename, entry) {
    const key = memKey(personaId, filename)
    const memList = memFallback.get(key) || []
    memList.push(structuredClone(entry))
    if (memList.length > MAX_JSONL_LINES) memList.splice(0, memList.length - TRIM_TO_LINES)
    memFallback.set(key, memList)

    try {
      const dir = dirOf(personaId)
      mkdirSync(dir, { recursive: true })
      const f = join(dir, filename)
      appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8')
      // 超长滚动裁剪
      if (memList.length % 100 === 0 && existsSync(f)) {
        const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
        if (lines.length > MAX_JSONL_LINES) {
          writeFileSync(f, lines.slice(-TRIM_TO_LINES).join('\n') + '\n', 'utf8')
        }
      }
    } catch (error) {
      log?.debug?.(`追加日志失败（${filename}）：`, error.message)
    }
  }

  function readJsonl(personaId, filename, { since = 0, limit = 100 } = {}) {
    let rows = []
    try {
      const f = fileOf(personaId, filename)
      if (existsSync(f)) {
        rows = readFileSync(f, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => { try { return JSON.parse(line) } catch { return null } })
          .filter(Boolean)
      } else {
        rows = structuredClone(memFallback.get(memKey(personaId, filename)) || [])
      }
    } catch {
      rows = structuredClone(memFallback.get(memKey(personaId, filename)) || [])
    }
    if (since > 0) rows = rows.filter((r) => Number(r.at || 0) >= since)
    return limit > 0 ? rows.slice(-limit) : rows
  }

  return {
    dirOf,
    withMutex,
    loadPersonality,
    savePersonality,
    loadEmotion,
    saveEmotion,
    appendEmotionAudit: (personaId, record) => appendJsonl(personaId, 'emotion-audit.jsonl', record),
    readEmotionAudit: (personaId, opts) => readJsonl(personaId, 'emotion-audit.jsonl', opts),
    appendPersonalityAudit: (personaId, record) => appendJsonl(personaId, 'personality-audit.jsonl', record),
    readPersonalityAudit: (personaId, opts) => readJsonl(personaId, 'personality-audit.jsonl', opts),
    appendEvent: (personaId, event) => appendJsonl(personaId, 'events.jsonl', event),
    readEvents: (personaId, opts) => readJsonl(personaId, 'events.jsonl', opts),
  }
}
