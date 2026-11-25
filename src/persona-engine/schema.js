// 状态引擎数据结构归一化、数值夹逼与初始状态工厂。

import {
  ENGINE_SCHEMA,
  TRAIT_KEYS,
  DEFAULT_PERSONA_SEEDS,
  EMOTION_DIMS,
  PERSONALITY_PARAMS,
  EMOTION_PARAMS,
} from './constants.js'

export const clip = (v, lo, hi) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, n))
}

export const round2 = (v) => {
  const n = Number(v) || 0
  return Math.round((n + Math.sign(n) * 1e-12) * 100) / 100
}

export function safePersonaId(id) {
  const cleaned = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)
  return cleaned || 'default'
}

const VALID_TRENDS = new Set(['up', 'down', 'stable', 'uncertain'])
const VALID_EMOTION_TRENDS = new Set(['up', 'down', 'stable'])

/**
 * 归一化五维性格种子分（优先取传入的 YAML 种子，其次内置默认种子，其余补 0）。
 */
export function normalizeTraitSeeds(personaId, rawSeeds = null) {
  const pid = safePersonaId(personaId)
  const fallback = DEFAULT_PERSONA_SEEDS[pid] || {}
  const src = rawSeeds && typeof rawSeeds === 'object' && !Array.isArray(rawSeeds) ? rawSeeds : {}
  const out = {}
  for (const key of TRAIT_KEYS) {
    const raw = src[key] !== undefined ? Number(src[key]) : fallback[key]
    out[key] = Number.isFinite(raw) ? round2(clip(raw, PERSONALITY_PARAMS.minScore, PERSONALITY_PARAMS.maxScore)) : 0
  }
  return out
}

/** 标称初始档位（无历史档位时按 ±1.0 / ±3.0 初始化） */
export function initialTierOf(score) {
  const s = Number(score) || 0
  if (s >= 3.0) return 2
  if (s > 1.0) return 1
  if (s <= -3.0) return -2
  if (s < -1.0) return -1
  return 0
}

export function createInitialPersonality(personaId, rawSeeds = null, now = Date.now()) {
  const pid = safePersonaId(personaId)
  const seeds = normalizeTraitSeeds(pid, rawSeeds)
  const iso = new Date(now).toISOString()
  const traits = {}
  for (const key of TRAIT_KEYS) {
    const s = seeds[key]
    traits[key] = {
      score: s,
      seed_score: s,
      tier: initialTierOf(s),
      trend: 'stable',
      confidence: 0.85,
      description: '',
      evidence_ids: [],
      updated_at: iso,
    }
  }
  return {
    schema: ENGINE_SCHEMA,
    persona_id: pid,
    version: 1,
    updated_at: iso,
    last_evaluated_at: iso,
    turns_since_eval: 0,
    traits,
  }
}

export function normalizePersonalityState(raw, personaId, rawSeeds = null, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createInitialPersonality(personaId, rawSeeds, now)
  }
  const pid = safePersonaId(personaId || raw.persona_id)
  const seeds = normalizeTraitSeeds(pid, rawSeeds)
  const iso = typeof raw.updated_at === 'string' && raw.updated_at ? raw.updated_at : new Date(now).toISOString()
  const evalIso = typeof raw.last_evaluated_at === 'string' && raw.last_evaluated_at ? raw.last_evaluated_at : iso
  const traits = {}
  const srcTraits = raw.traits && typeof raw.traits === 'object' ? raw.traits : {}
  for (const key of TRAIT_KEYS) {
    const item = srcTraits[key] && typeof srcTraits[key] === 'object' ? srcTraits[key] : {}
    // 若 YAML 头明确提供了新种子，同步更新 seed_score；否则保留已存 seed_score
    const hasExplicitSeed = rawSeeds && typeof rawSeeds === 'object' && Number.isFinite(Number(rawSeeds[key]))
    const seedScore = hasExplicitSeed
      ? seeds[key]
      : Number.isFinite(Number(item.seed_score))
        ? round2(clip(item.seed_score, -5, 5))
        : seeds[key]
    const score = Number.isFinite(Number(item.score)) ? round2(clip(item.score, -5, 5)) : seedScore
    const tier = [-2, -1, 0, 1, 2].includes(Number(item.tier)) ? Number(item.tier) : initialTierOf(score)
    traits[key] = {
      score,
      seed_score: seedScore,
      tier,
      trend: VALID_TRENDS.has(item.trend) ? item.trend : 'stable',
      confidence: Number.isFinite(Number(item.confidence)) ? round2(clip(item.confidence, 0, 1)) : 0.8,
      description: typeof item.description === 'string' ? item.description.trim().slice(0, 120) : '',
      evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String).filter(Boolean).slice(0, 12) : [],
      updated_at: typeof item.updated_at === 'string' && item.updated_at ? item.updated_at : iso,
    }
  }
  return {
    schema: ENGINE_SCHEMA,
    persona_id: pid,
    version: Math.max(1, Math.floor(Number(raw.version) || 1)),
    updated_at: iso,
    last_evaluated_at: evalIso,
    turns_since_eval: Math.max(0, Math.floor(Number(raw.turns_since_eval) || 0)),
    traits,
  }
}

export function createInitialEmotion(personaId, baselines = {}, now = Date.now()) {
  const pid = safePersonaId(personaId)
  const iso = new Date(now).toISOString()
  const emotions = {}
  for (const dim of EMOTION_DIMS) {
    const b = round2(clip(baselines[dim] ?? 0, 0, EMOTION_PARAMS.maxIntensity))
    emotions[dim] = {
      intensity: b,
      trend: 'stable',
      last_stimulated_at: now,
      updated_at: iso,
    }
  }
  return {
    schema: ENGINE_SCHEMA,
    persona_id: pid,
    version: 1,
    updated_at: iso,
    emotions,
    focal_sources: {},
    confidence: 1,
    trigger_event_ids: [],
    processed_event_ids: [],
  }
}

export function normalizeEmotionState(raw, personaId, baselines = {}, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return createInitialEmotion(personaId, baselines, now)
  }
  const pid = safePersonaId(personaId || raw.persona_id)
  const iso = typeof raw.updated_at === 'string' && raw.updated_at ? raw.updated_at : new Date(now).toISOString()
  const fallbackAt = Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : now
  const srcEmotions = raw.emotions && typeof raw.emotions === 'object' ? raw.emotions : {}
  const emotions = {}
  for (const dim of EMOTION_DIMS) {
    const rawEntry = srcEmotions[dim]
    const b = round2(clip(baselines[dim] ?? 0, 0, EMOTION_PARAMS.maxIntensity))
    if (typeof rawEntry === 'number') {
      emotions[dim] = {
        intensity: round2(clip(rawEntry, 0, EMOTION_PARAMS.maxIntensity)),
        trend: 'stable',
        last_stimulated_at: fallbackAt,
        updated_at: iso,
      }
    } else if (rawEntry && typeof rawEntry === 'object') {
      const stimAt = Number(rawEntry.last_stimulated_at)
      const entryIso = typeof rawEntry.updated_at === 'string' && rawEntry.updated_at ? rawEntry.updated_at : iso
      const parsedEntryAt = Number.isFinite(Date.parse(entryIso)) ? Date.parse(entryIso) : fallbackAt
      emotions[dim] = {
        intensity: Number.isFinite(Number(rawEntry.intensity)) ? round2(clip(rawEntry.intensity, 0, EMOTION_PARAMS.maxIntensity)) : b,
        trend: VALID_EMOTION_TRENDS.has(rawEntry.trend) ? rawEntry.trend : 'stable',
        last_stimulated_at: Number.isFinite(stimAt) && stimAt > 0 ? stimAt : parsedEntryAt,
        updated_at: entryIso,
      }
    } else {
      emotions[dim] = {
        intensity: b,
        trend: 'stable',
        last_stimulated_at: fallbackAt,
        updated_at: iso,
      }
    }
  }
  const focal_sources = {}
  if (raw.focal_sources && typeof raw.focal_sources === 'object') {
    for (const dim of EMOTION_DIMS) {
      const f = raw.focal_sources[dim]
      if (f && typeof f === 'object' && f.chatId) {
        focal_sources[dim] = {
          chatId: String(f.chatId).slice(0, 64),
          userId: String(f.userId || '').slice(0, 32),
          who: String(f.who || '').slice(0, 40),
          isOwner: Boolean(f.isOwner),
          reason: String(f.reason || '').slice(0, 80),
          at: Number(f.at) || fallbackAt,
        }
      }
    }
  }
  return {
    schema: ENGINE_SCHEMA,
    persona_id: pid,
    version: Math.max(1, Math.floor(Number(raw.version) || 1)),
    updated_at: iso,
    emotions,
    focal_sources,
    confidence: Number.isFinite(Number(raw.confidence)) ? round2(clip(raw.confidence, 0, 1)) : 1,
    trigger_event_ids: Array.isArray(raw.trigger_event_ids) ? raw.trigger_event_ids.map(String).filter(Boolean).slice(-10) : [],
    processed_event_ids: Array.isArray(raw.processed_event_ids) ? raw.processed_event_ids.map(String).filter(Boolean).slice(-500) : [],
  }
}
