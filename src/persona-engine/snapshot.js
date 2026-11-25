// 单轮对话不可变只读状态快照注册表（Snapshot Registry）。
// 保证同一轮生成与气泡投递期间读到的情绪提示词、物理行为倍率与性格状态 100% 一致。

import { computePersonalityModifiers, compilePersonalityPrompt } from './personality-math.js'
import {
  decayAllEmotions,
  computeDerivedAxes,
  projectCrossSessionEmotion,
  computeValenceArousal,
  computeBehaviorEffects,
} from './emotion-math.js'
import { compileEmotionContext, summarizeEmotionLabel } from './compiler.js'

const SNAPSHOT_TTL_MS = 10 * 60_000

export function buildReadOnlySnapshot({
  personaId,
  chat = {},
  personalityState,
  emotionState,
  ownerTitle = '主人',
  now = Date.now(),
}) {
  const modifiers = computePersonalityModifiers(personalityState.traits)
  const decayed = decayAllEmotions(emotionState, modifiers.baselines, modifiers.tauScale, now)
  const projected = projectCrossSessionEmotion(
    decayed.intensities,
    modifiers.baselines,
    decayed.activeFocalSources,
    chat,
  )
  const va = computeValenceArousal(projected.effective, modifiers.baselines)
  const behaviorEffects = computeBehaviorEffects(projected.effective, modifiers.baselines, modifiers.normalized)
  const emotionContext = compileEmotionContext({
    effective: projected.effective,
    modes: projected.modes,
    baselines: modifiers.baselines,
    focalSources: decayed.activeFocalSources,
    ownerTitle,
  })
  const emotionLabel = summarizeEmotionLabel(projected.effective, modifiers.baselines)
  const personalityPrompt = compilePersonalityPrompt(personalityState)
  const axes = computeDerivedAxes(decayed.intensities)

  return Object.freeze({
    personaId,
    chatId: String(chat?.chatId || ''),
    createdAt: now,
    personalityVersion: personalityState.version,
    emotionVersion: emotionState.version,
    personalityPrompt,
    emotionContext,
    emotionLabel,
    behaviorEffects: Object.freeze(behaviorEffects),
    valenceArousal: Object.freeze(va),
    effectiveEmotions: Object.freeze({ ...projected.effective }),
    projectionModes: Object.freeze({ ...projected.modes }),
    rawDecayedEmotions: Object.freeze({ ...decayed.intensities }),
    activeFocalSources: Object.freeze({ ...decayed.activeFocalSources }),
    baselines: Object.freeze({ ...modifiers.baselines }),
    axes: Object.freeze(axes),
    modifiers,
  })
}

export function createSnapshotRegistry() {
  const bySession = new Map() // sessionId -> snapshot
  const byChat = new Map() // chatId -> snapshot

  function sweepExpired(now = Date.now()) {
    for (const [k, snap] of bySession) {
      if (now - snap.createdAt > SNAPSHOT_TTL_MS) bySession.delete(k)
    }
    for (const [k, snap] of byChat) {
      if (now - snap.createdAt > SNAPSHOT_TTL_MS) byChat.delete(k)
    }
  }

  function store({ sessionId, chatId }, snapshot) {
    sweepExpired(snapshot.createdAt)
    if (sessionId) bySession.set(String(sessionId), snapshot)
    if (chatId) byChat.set(String(chatId), snapshot)
    return snapshot
  }

  function get({ sessionId, chatId } = {}) {
    if (sessionId && bySession.has(String(sessionId))) return bySession.get(String(sessionId))
    if (chatId && byChat.has(String(chatId))) return byChat.get(String(chatId))
    return null
  }

  function release({ sessionId, chatId } = {}) {
    if (sessionId) bySession.delete(String(sessionId))
    if (chatId) byChat.delete(String(chatId))
  }

  return {
    store,
    get,
    release,
  }
}
