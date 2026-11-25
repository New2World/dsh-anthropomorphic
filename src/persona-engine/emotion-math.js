// 八维情绪动力学纯函数：平台期+分维指数衰减、非对称剩余空间阻尼叠加、跨会话防迁怒投影与效价唤醒度映射。
// 数学基准见 .agent/algorithm.md §3-§6（零旧版 0~100 标量概念）。

import {
  EMOTION_DIMS,
  POSITIVE_DIMS,
  EMOTION_HOLD_MS,
  EMOTION_TAU_MS,
  EMOTION_PARAMS,
} from './constants.js'
import { clip, round2 } from './schema.js'

/**
 * 单维度分段惰性衰减（余温保持平台期 h_i + 指数衰减 + 死区吸附）。
 */
export function decayDimension(intensity, lastStimulatedAt, now, dim, baseline = 0, tauScale = 1) {
  const e0 = clip(Number(intensity) || 0, 0, EMOTION_PARAMS.maxIntensity)
  const b = clip(Number(baseline) || 0, 0, EMOTION_PARAMS.maxIntensity)
  const t0 = Number.isFinite(Number(lastStimulatedAt)) ? Number(lastStimulatedAt) : now
  const dt = Math.max(0, Number(now) - t0)
  const hold = EMOTION_HOLD_MS[dim] ?? 8 * 60_000
  const baseTau = EMOTION_TAU_MS[dim] ?? 180 * 60_000
  const tau = Math.max(1_000, baseTau * Math.max(0.1, Number(tauScale) || 1))

  const raw = dt <= hold
    ? e0
    : b + (e0 - b) * Math.exp(-(dt - hold) / tau)

  if (Math.abs(raw - b) < EMOTION_PARAMS.deadzoneSnap) return round2(b)
  return round2(clip(raw, 0, EMOTION_PARAMS.maxIntensity))
}

/**
 * 对整个八维情绪状态执行实时只读惰性衰减，并自动过滤已消退维度的过时触发源（focal_sources）。
 */
export function decayAllEmotions(emotionState, baselines = {}, tauScale = {}, now = Date.now()) {
  const intensities = {}
  const activeFocalSources = {}
  const releasedFocal = []
  const srcEmotions = emotionState?.emotions || {}
  const srcFocal = emotionState?.focal_sources || {}

  for (const dim of EMOTION_DIMS) {
    const rec = srcEmotions[dim]
    const b = Number(baselines[dim] ?? 0)
    const e0 = typeof rec === 'number' ? rec : Number(rec?.intensity ?? b)
    const stimAt = typeof rec === 'object' && rec ? rec.last_stimulated_at : now
    const val = decayDimension(e0, stimAt, now, dim, b, tauScale[dim] ?? 1)
    intensities[dim] = val

    if (srcFocal[dim]) {
      if (Math.abs(val - b) >= EMOTION_PARAMS.focalReleaseDelta) {
        activeFocalSources[dim] = { ...srcFocal[dim] }
      } else {
        releasedFocal.push(dim)
      }
    }
  }

  return { intensities, activeFocalSources, releasedFocal }
}

/**
 * 只读派生 Plutchik 四对立轴差值（[-5, +5]，仅供展示与检查，不参与内部演进）。
 */
export function computeDerivedAxes(intensities = {}) {
  return {
    joy_sadness: round2((Number(intensities.joy) || 0) - (Number(intensities.sadness) || 0)),
    anger_fear: round2((Number(intensities.anger) || 0) - (Number(intensities.fear) || 0)),
    trust_disgust: round2((Number(intensities.trust) || 0) - (Number(intensities.disgust) || 0)),
    surprise_anticipation: round2((Number(intensities.surprise) || 0) - (Number(intensities.anticipation) || 0)),
  }
}

/**
 * 裁剪并过滤评估噪声冲量（[-3.0, +3.0]，|u| < 0.20 视为 0）。
 */
export function cleanImpulse(rawU) {
  const v = clip(Number(rawU) || 0, -3.0, 3.0)
  return Math.abs(v) < EMOTION_PARAMS.minImpulse ? 0 : round2(v)
}

/**
 * 交互场景关系权重 w_rel（见 .agent/algorithm.md §4.1）。
 */
export function relationWeight(event = {}) {
  if (event.isOwner && event.chatKind === 'private') return 1.25
  if (event.origin === 'proactive' || (event.isOwner && event.directToBot)) return 1.10
  if (event.chatKind === 'private' || event.directToBot) return 1.00
  return 0.35
}

/**
 * 单维度非对称剩余空间阻尼更新（见 .agent/algorithm.md §4.2）：
 * - uEff > 0：按剩余空间 (5 - E^-) 指数阻尼趋近上限，杜绝连夸三句爆顶锁死；
 * - uEff < 0：高位情绪向基线指数回落，平淡期正向维度受冷落可向 0 下探。
 */
export function applyDampedImpulse(ePrior, uEff, dim, baseline = 0) {
  const e0 = clip(Number(ePrior) || 0, 0, EMOTION_PARAMS.maxIntensity)
  const u = Number(uEff) || 0
  const b = clip(Number(baseline) || 0, 0, EMOTION_PARAMS.maxIntensity)
  if (Math.abs(u) < 1e-6) return round2(e0)

  let next
  if (u > 0) {
    next = e0 + (EMOTION_PARAMS.maxIntensity - e0) * (1 - Math.exp(-EMOTION_PARAMS.betaUp * u))
  } else if (POSITIVE_DIMS.has(dim)) {
    if (e0 > b + 0.30) {
      next = b + (e0 - b) * Math.exp(EMOTION_PARAMS.betaDown * u)
    } else {
      next = e0 * Math.exp(EMOTION_PARAMS.betaDown * u)
    }
  } else {
    next = b + (e0 - b) * Math.exp(EMOTION_PARAMS.betaDown * u)
    if (Math.abs(next - b) < EMOTION_PARAMS.deadzoneSnap) next = b
  }
  return round2(clip(next, 0, EMOTION_PARAMS.maxIntensity))
}

export function computeTrend(ePrior, eNext) {
  const d = (Number(eNext) || 0) - (Number(ePrior) || 0)
  if (d >= EMOTION_PARAMS.trendThreshold) return 'up'
  if (d <= -EMOTION_PARAMS.trendThreshold) return 'down'
  return 'stable'
}

/**
 * 在已有状态上应用整轮评估冲量（纯状态变换，由调用者在 Mutex 内使用）。
 * 严格维护单维度平台期不变量：
 * - 未受任何冲量与交叉抑制影响的维度保留原 intensity 与 last_stimulated_at，零舍入漂移、不续杯平台期；
 * - 向远离基线方向激发时刷新 last_stimulated_at = now；
 * - 向基线平复或被交叉软消解时写入新值，但锚定时间不早于已消耗的平台期（不额外赠送新平台期）。
 */
export function stepEmotionState({ state, assessment, event = {}, modifiers, now = Date.now() }) {
  const baselines = modifiers.baselines
  const iso = new Date(now).toISOString()
  const before = {}
  const after = {}
  const deltas = {}

  const conf = clip(Number(assessment?.confidence ?? 0), 0, 1)
  const valid = Boolean(assessment && conf >= EMOTION_PARAMS.minConfidence)
  const wRel = event.weightOverride !== undefined ? Number(event.weightOverride) : relationWeight(event)

  const rawJoy = valid ? cleanImpulse(assessment.impulses?.joy) : 0
  const effJoy = rawJoy * conf * wRel * (modifiers.gain.joy ?? 1)

  const nextEmotions = {}
  const nextFocal = { ...(state.focal_sources || {}) }

  for (const dim of EMOTION_DIMS) {
    const rec = state.emotions[dim] || { intensity: baselines[dim] ?? 0, trend: 'stable', last_stimulated_at: now, updated_at: iso }
    const b = baselines[dim] ?? 0
    const ePrior = decayDimension(rec.intensity, rec.last_stimulated_at, now, dim, b, modifiers.tauScale[dim] ?? 1)
    before[dim] = ePrior

    const rawU = valid ? cleanImpulse(assessment.impulses?.[dim]) : 0
    const uEff = rawU * conf * wRel * (modifiers.gain[dim] ?? 1)

    let eNext = applyDampedImpulse(ePrior, uEff, dim, b)
    let crossInhibited = false
    if (
      effJoy >= EMOTION_PARAMS.crossInhibitJoyMin &&
      rawU <= 0 &&
      (dim === 'sadness' || dim === 'anger') &&
      eNext > b
    ) {
      const softened = eNext * Math.exp(-EMOTION_PARAMS.crossInhibitRate * effJoy)
      eNext = Math.abs(softened - b) < EMOTION_PARAMS.deadzoneSnap ? round2(b) : round2(softened)
      crossInhibited = eNext !== ePrior
    }

    after[dim] = eNext
    deltas[dim] = round2(eNext - ePrior)

    const stimulated = Math.abs(uEff) >= 0.05 || crossInhibited
    if (!stimulated) {
      // 完全未受本轮刺激：若自然衰减已吸附回基线则归位清理，否则原样保留指数轨迹锚点
      if (ePrior === round2(b) && rec.intensity !== round2(b)) {
        nextEmotions[dim] = {
          intensity: round2(b),
          trend: 'stable',
          last_stimulated_at: rec.last_stimulated_at,
          updated_at: rec.updated_at || iso,
        }
      } else {
        nextEmotions[dim] = { ...rec, trend: 'stable' }
      }
    } else {
      const hold = EMOTION_HOLD_MS[dim] ?? 8 * 60_000
      const movedAwayFromBaseline = Math.abs(eNext - b) > Math.abs(ePrior - b) + 1e-6
      const nextStimAt = movedAwayFromBaseline
        ? now
        : Math.min(now, Math.max(Number(rec.last_stimulated_at) || 0, now - hold))
      nextEmotions[dim] = {
        intensity: eNext,
        trend: computeTrend(ePrior, eNext),
        last_stimulated_at: nextStimAt,
        updated_at: iso,
      }
    }

    // 维护触发源归属 focal_sources
    if (Math.abs(eNext - b) < EMOTION_PARAMS.focalReleaseDelta) {
      delete nextFocal[dim]
    } else {
      const d = eNext - ePrior
      if (d >= EMOTION_PARAMS.focalWriteDelta && eNext >= EMOTION_PARAMS.focalWriteMin && event?.chatId) {
        const prev = nextFocal[dim]
        const sameChat = prev && (
          prev.chatId === event.chatId ||
          (event.chatKind === 'private' && prev.userId && event.userId && String(prev.userId) === String(event.userId))
        )
        const dominates = !prev || sameChat || d >= 0.50 * Math.max(0, ePrior - b)
        if (dominates) {
          nextFocal[dim] = {
            chatId: String(event.chatId).slice(0, 64),
            userId: String(event.userId || '').slice(0, 32),
            who: String(event.who || (event.isOwner ? '主人' : '别人')).slice(0, 40),
            isOwner: Boolean(event.isOwner),
            reason: String(assessment?.reason || event.reason || '').slice(0, 80),
            at: now,
          }
        }
      }
    }
  }

  return { nextEmotions, nextFocal, before, after, deltas, valid }
}

/**
 * 跨会话防迁怒情绪投影算子（见 .agent/algorithm.md §5.2）。
 * @param {object} intensities 当前衰减后的八维强度
 * @param {object} baselines 八维静息基线
 * @param {object} focalSources 当前活跃触发源
 * @param {object} targetChat { chatId, kind, userId, isOwnerPrivate }
 */
export function projectCrossSessionEmotion(intensities = {}, baselines = {}, focalSources = {}, targetChat = {}) {
  const effective = {}
  const modes = {}
  const targetId = targetChat?.chatId ? String(targetChat.chatId) : ''
  const targetKind = targetChat?.kind || (targetId.startsWith('private:') ? 'private' : targetId ? 'group' : '')
  const targetUid = targetChat?.userId
    ? String(targetChat.userId)
    : targetId.startsWith('private:')
      ? targetId.slice('private:'.length)
      : ''

  for (const dim of EMOTION_DIMS) {
    const b = Number(baselines[dim] ?? 0)
    const e = Number(intensities[dim] ?? b)
    const src = focalSources?.[dim]
    const sameOrigin = !src || !targetId || targetId === src.chatId || (
      targetKind === 'private' && targetUid && src.userId && targetUid === String(src.userId)
    )

    if (sameOrigin) {
      effective[dim] = round2(e)
      modes[dim] = 'direct'
    } else if (targetChat?.isOwnerPrivate && !src.isOwner) {
      effective[dim] = round2(e)
      modes[dim] = 'external_to_owner'
    } else {
      effective[dim] = round2(b + EMOTION_PARAMS.crossChatGamma * (e - b))
      modes[dim] = 'attenuated'
    }
  }

  return { effective, modes }
}

/**
 * 将八维外显情绪正交投影到归一化效价-唤醒度空间 (Valence, Arousal) ∈ [-1, +1]^2。
 */
export function computeValenceArousal(effectiveEmotions = {}, baselines = {}) {
  const e = (k) => Number(effectiveEmotions[k] ?? 0)
  const bTrust = Number(baselines.trust ?? 1.0)

  const vRaw = (
    1.00 * e('joy') +
    0.50 * (e('trust') - bTrust) +
    0.35 * e('anticipation') -
    1.00 * e('sadness') -
    0.90 * e('anger') -
    0.85 * e('disgust') -
    0.40 * e('fear')
  ) / 4.5

  const aRaw = (
    0.75 * e('joy') +
    0.95 * e('anger') +
    0.90 * e('surprise') +
    0.60 * e('anticipation') +
    0.55 * e('fear') -
    0.80 * e('sadness')
  ) / 4.5

  return {
    valence: round2(clip(vRaw, -1, 1)),
    arousal: round2(clip(aRaw, -1, 1)),
  }
}

/**
 * 计算喂给 hub.js 的四项物理行为倍率（表情概率、语音概率、拆条打字间隔、群聊插话欲）。
 */
export function computeBehaviorEffects(effectiveEmotions = {}, baselines = {}, normalizedTraits = {}) {
  const { valence: V, arousal: A } = computeValenceArousal(effectiveEmotions, baselines)
  const pOut = clip(Number(normalizedTraits.outgoing ?? 0), -1, 1)
  const eSad = clip(Number(effectiveEmotions.sadness ?? 0), 0, 5)
  const eDis = clip(Number(effectiveEmotions.disgust ?? 0), 0, 5)

  return {
    sticker: round2(clip(1.00 + 0.50 * V + 0.15 * pOut, 0.25, 1.75)),
    voice: round2(clip(1.00 + 0.40 * V + 0.20 * A + 0.15 * pOut, 0.30, 1.65)),
    delay: round2(clip(1.00 - 0.25 * A + 0.30 * (eSad / 5), 0.75, 1.55)),
    chatty: round2(clip(1.00 + 0.35 * V + 0.25 * A + 0.25 * pOut - 0.20 * (eDis / 5), 0.30, 1.65)),
  }
}
