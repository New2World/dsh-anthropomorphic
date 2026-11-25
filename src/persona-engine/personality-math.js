// 五维性格核心纯函数算法：指数情绪调制矩阵、静息基线派生、施密特滞回档位编译与受约束演化步进。
// 数学定义见 .agent/algorithm.md §2 与 §8。

import {
  TRAIT_KEYS,
  EMOTION_DIMS,
  NEGATIVE_DIMS,
  PERSONALITY_PARAMS,
  TRAIT_TIER_ANCHORS,
} from './constants.js'
import { clip, round2 } from './schema.js'

/**
 * 从五维性格状态计算中间情绪调制参数、恢复时间缩放与静息基线。
 */
export function computePersonalityModifiers(traits = {}) {
  const p = {}
  for (const k of TRAIT_KEYS) {
    const s = Number(traits[k]?.score ?? traits[k] ?? 0)
    p[k] = clip(s / 5, -1, 1)
  }

  const gPos = Math.exp(0.25 * p.outgoing + 0.10 * p.openness)
  const gNeg = Math.exp(0.35 * p.emotionality - 0.10 * p.agreeableness)
  const etaExt = Math.exp(-0.22 * p.agreeableness)
  const etaInt = Math.exp(0.18 * p.agreeableness + 0.12 * p.emotionality)
  const gTrust = Math.exp(0.25 * p.agreeableness + 0.10 * p.outgoing)
  const gSurp = Math.exp(0.15 * p.openness + 0.15 * p.emotionality)

  const gain = {
    joy: round2(gPos),
    anticipation: round2(gPos),
    trust: round2(gTrust),
    anger: round2(gNeg * etaExt),
    disgust: round2(gNeg * etaExt),
    sadness: round2(gNeg * etaInt),
    fear: round2(gNeg * etaInt),
    surprise: round2(gSurp),
  }

  const negTauScale = round2(Math.exp(0.30 * p.emotionality - 0.10 * p.conscientiousness))
  const tauScale = {}
  for (const dim of EMOTION_DIMS) {
    tauScale[dim] = NEGATIVE_DIMS.has(dim) ? negTauScale : 1.0
  }

  const baselines = {
    sadness: 0,
    anger: 0,
    fear: 0,
    disgust: 0,
    surprise: 0,
    trust: round2(clip(1.00 + 0.50 * p.agreeableness, 0.30, 1.50)),
    joy: round2(clip(0.60 + 0.35 * p.outgoing - 0.15 * p.emotionality, 0.20, 1.20)),
    anticipation: round2(clip(0.65 + 0.30 * p.outgoing + 0.25 * p.openness, 0.20, 1.20)),
  }

  return {
    normalized: p,
    gPos: round2(gPos),
    gNeg: round2(gNeg),
    etaExt: round2(etaExt),
    etaInt: round2(etaInt),
    gain,
    tauScale,
    baselines,
  }
}

/**
 * 5 档施密特滞回离散化（tier ∈ {-2, -1, 0, +1, +2}），防止边界微幅波动击穿系统提示词 Prefix Cache。
 */
export function discretizeTraitTier(score, prevTier = 0, hysteresis = PERSONALITY_PARAMS.hysteresis) {
  const s = Number(score) || 0
  const h = Math.max(0, Number(hysteresis) || 0)
  let tier = [-2, -1, 0, 1, 2].includes(Number(prevTier)) ? Number(prevTier) : 0

  // 正向升级与回退
  if (tier <= 0 && s >= 1.0 + h) tier = 1
  if (tier === 1 && s >= 3.0 + h) tier = 2
  if (tier === 2 && s <= 3.0 - h) tier = 1
  if (tier === 1 && s <= 1.0 - h) tier = 0

  // 负向升级与回退
  if (tier >= 0 && s <= -1.0 - h) tier = -1
  if (tier === -1 && s <= -3.0 - h) tier = -2
  if (tier === -2 && s >= -3.0 + h) tier = -1
  if (tier === -1 && s >= -1.0 + h) tier = 0

  // 跨多档跳变（如手动改分或回滚）直接修正到位
  if (s >= 3.0 + h) tier = 2
  else if (s <= -3.0 - h) tier = -2

  return tier
}

/**
 * 将五维性格状态编译为稳定的自然语言系统提示词段落（附加在 {{aurabot_persona}} 尾部）。
 * 当所有特质均为均衡档且无自定义行为描述时返回空串。
 */
export function compilePersonalityPrompt(personalityState) {
  if (!personalityState?.traits) return ''
  const lines = []
  for (const key of TRAIT_KEYS) {
    const t = personalityState.traits[key]
    if (!t) continue
    const tier = [-2, -1, 0, 1, 2].includes(Number(t.tier))
      ? Number(t.tier)
      : discretizeTraitTier(t.score, 0, 0)
    const customDesc = typeof t.description === 'string' ? t.description.trim() : ''
    const anchor = TRAIT_TIER_ANCHORS[key]?.[String(tier)] || ''
    const text = customDesc || anchor
    if (text) lines.push(`- ${text}`)
  }
  if (!lines.length) return ''
  const joined = lines.join('\n')
  return `【性格倾向】\n${joined.length > 260 ? joined.slice(0, 260) : joined}`
}

/**
 * 非主人交互按「用户 × 小时桶」去重，再按主人高配额 + 社交低配额分层抽样（见 .agent/algorithm.md §8.1）。
 */
export function sampleEvolutionEvidence(events = [], opts = {}) {
  const cap = opts.sampleCap ?? PERSONALITY_PARAMS.sampleCap
  const ownerQuota = opts.ownerQuota ?? PERSONALITY_PARAMS.ownerQuota
  const socialQuota = opts.socialQuota ?? PERSONALITY_PARAMS.socialQuota

  const ownerPool = []
  const socialBuckets = new Map() // `${userId}|${hourBucket}` -> best event

  for (const ev of events) {
    if (!ev || !ev.eventId) continue
    if (ev.isOwner) {
      ownerPool.push({ ...ev, sampleWeight: 1.0 })
    } else {
      const uid = String(ev.userId || ev.chatId || 'anon')
      const bucket = `${uid}|${Math.floor((Number(ev.at) || 0) / 3600_000)}`
      const prev = socialBuckets.get(bucket)
      const rank = (x) => (Number(x.affectShift) || 0) * 10 + Math.min(80, String(x.cleanUserText || x.userText || '').length)
      if (!prev || rank(ev) >= rank(prev)) {
        socialBuckets.set(bucket, { ...ev, sampleWeight: 0.35 })
      }
    }
  }

  const pickedOwners = ownerPool.slice(-ownerQuota)
  const leftForSocial = Math.max(socialQuota, cap - pickedOwners.length)
  const pickedSocial = [...socialBuckets.values()].slice(-leftForSocial)
  return [...pickedOwners, ...pickedSocial]
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
    .slice(-cap)
}

/**
 * 四重抗幻觉校验 + 受约束平滑步进更新（见 .agent/algorithm.md §8.2）。
 * @param {object} params
 * @param {object} params.currentTraits 当前五维状态
 * @param {object} params.proposals LLM 给出的五维建议 { outgoing: { raw_delta, confidence, description, evidence_ids, reason, trend } }
 * @param {Map<string, object>} params.sampledMap 本次采样的真实候选事件映射 eventId -> event
 * @param {object} [params.config] 演化超参数覆盖
 * @param {number} [params.now]
 */
export function applyConstrainedTraitStep({ currentTraits, proposals = {}, sampledMap, config = {}, now = Date.now() }) {
  const alpha = config.alpha ?? PERSONALITY_PARAMS.alpha
  const maxStep = config.maxStep ?? PERSONALITY_PARAMS.maxStep
  const maxDrift = config.maxDrift === null ? null : (config.maxDrift ?? PERSONALITY_PARAMS.maxDrift)
  const minConf = config.minConfidence ?? PERSONALITY_PARAMS.minConfidence
  const minEv = config.minEvidence ?? PERSONALITY_PARAMS.minEvidence
  const hysteresis = config.hysteresis ?? PERSONALITY_PARAMS.hysteresis
  const iso = new Date(now).toISOString()

  const nextTraits = {}
  const deltas = {}
  const auditDetails = {}
  let anyChanged = false

  for (const key of TRAIT_KEYS) {
    const cur = currentTraits[key]
    const prop = proposals?.[key] && typeof proposals[key] === 'object' ? proposals[key] : null
    if (!prop) {
      nextTraits[key] = { ...cur }
      deltas[key] = 0
      auditDetails[key] = { accepted: false, reason: 'no-proposal', valid_evidence_ids: [] }
      continue
    }

    const rawIds = Array.isArray(prop.evidence_ids) ? [...new Set(prop.evidence_ids.map(String))] : []
    const validEvents = rawIds.map((id) => sampledMap?.get(id)).filter(Boolean)
    const validIds = validEvents.map((e) => e.eventId)
    const hasOwnerEv = validEvents.some((e) => e.isOwner)
    const distinctUsers = new Set(validEvents.map((e) => String(e.userId || e.chatId))).size
    const sourceDiverse = hasOwnerEv || distinctUsers >= 2

    const conf = clip(prop.confidence ?? 0, 0, 1)
    const rawDelta = clip(prop.raw_delta ?? prop.direction_delta ?? 0, -1, 1)

    const enoughEvidence = validIds.length >= minEv && sourceDiverse
    const enoughConf = conf >= minConf

    if (!enoughEvidence || !enoughConf || Math.abs(rawDelta) < 0.05) {
      nextTraits[key] = {
        ...cur,
        trend: !enoughEvidence || !enoughConf ? (rawDelta !== 0 ? 'uncertain' : 'stable') : 'stable',
      }
      deltas[key] = 0
      auditDetails[key] = {
        accepted: false,
        reason: !enoughConf ? 'low-confidence' : !enoughEvidence ? 'insufficient-evidence' : 'negligible-delta',
        confidence: round2(conf),
        valid_evidence_ids: validIds,
      }
      continue
    }

    const rawStep = clip(alpha * conf * rawDelta, -maxStep, maxStep)
    const seed = Number.isFinite(Number(cur.seed_score)) ? Number(cur.seed_score) : 0
    const lo = maxDrift == null ? -5 : Math.max(-5, seed - maxDrift)
    const hi = maxDrift == null ? 5 : Math.min(5, seed + maxDrift)
    const nextScore = round2(clip(cur.score + rawStep, lo, hi))
    const actualDelta = round2(nextScore - cur.score)
    const nextTier = discretizeTraitTier(nextScore, cur.tier, hysteresis)
    const nextTrend = actualDelta >= 0.05 ? 'up' : actualDelta <= -0.05 ? 'down' : 'stable'
    const cleanDesc = typeof prop.description === 'string' && prop.description.trim()
      ? prop.description.trim().slice(0, 120)
      : cur.description

    if (actualDelta !== 0 || cleanDesc !== cur.description) anyChanged = true

    nextTraits[key] = {
      score: nextScore,
      seed_score: seed,
      tier: nextTier,
      trend: nextTrend,
      confidence: round2(conf),
      description: cleanDesc,
      evidence_ids: validIds.slice(0, 10),
      updated_at: actualDelta !== 0 ? iso : cur.updated_at,
    }
    deltas[key] = actualDelta
    auditDetails[key] = {
      accepted: actualDelta !== 0,
      confidence: round2(conf),
      raw_delta: round2(rawDelta),
      applied_delta: actualDelta,
      valid_evidence_ids: validIds,
      reason: String(prop.reason || '').slice(0, 120),
    }
  }

  return { nextTraits, deltas, auditDetails, anyChanged }
}
