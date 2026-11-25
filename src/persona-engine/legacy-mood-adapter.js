// 旧版 `mood` 模块隔离兼容适配层（Legacy Mood Adapter）。
// 核心引擎内部零 `0~100` 标量概念；所有面向旧版 Web 面板 `/state`、翻唱/主动搭话/闭嘴命令 `nudge(±d)` 的双向换算全部收敛在此文件，后续重构前端或旧模块后可直接整文件删除。

import { clip, round2 } from './schema.js'
import { computeValenceArousal } from './emotion-math.js'

/**
 * 将八维情绪的归一化效价投影为旧面板 `0~100` 标量心情分（静息基线对齐为 60）。
 */
export function projectLegacyMoodScore(effectiveEmotions = {}, baselines = {}) {
  const { valence } = computeValenceArousal(effectiveEmotions, baselines)
  const { valence: restValence } = computeValenceArousal(baselines, baselines)
  const netV = clip(valence - restValence, -1, 1)
  return Math.round(clip(60 + 38 * netV, 5, 100))
}

/**
 * 将旧版模块 `mood.nudge(delta)` 的标量增减（通常 -20 ~ +20）逆映射为标准八维情绪冲量。
 */
export function legacyNudgeToImpulses(delta) {
  const d = clip(Number(delta) || 0, -25, 25)
  if (Math.abs(d) < 0.5) return {}
  if (d > 0) {
    const out = { joy: round2(clip(d / 5, 0.25, 2.5)) }
    if (d >= 4) out.anticipation = round2(clip(d / 10, 0.2, 1.2))
    return out
  }
  const abs = Math.abs(d)
  const out = { sadness: round2(clip(abs / 5, 0.25, 2.5)) }
  if (abs >= 4) out.anger = round2(clip(abs / 12, 0.2, 1.0))
  return out
}

export function createLegacyMoodAdapter({ engine, getConfig = () => ({}) } = {}) {
  function current() {
    if (!engine) return Number(getConfig()?.mood?.base ?? 60)
    const st = engine.getState()
    return projectLegacyMoodScore(st.emotion.intensities, st.emotion.baselines)
  }

  function label() {
    if (!engine) return '平平常常'
    return engine.getState().emotion.label || '平平常常'
  }

  function state() {
    if (!engine) return { value: 60, label: '平平常常', reason: '', history: [] }
    const st = engine.getState()
    const value = projectLegacyMoodScore(st.emotion.intensities, st.emotion.baselines)
    const audits = engine.getAudit(st.personaId, { kind: 'emotion', limit: 20 })
    const history = audits.slice().reverse().map((rec) => {
      const from = projectLegacyMoodScore(rec.before || st.emotion.baselines, st.emotion.baselines)
      const to = projectLegacyMoodScore(rec.after || st.emotion.baselines, st.emotion.baselines)
      return {
        at: rec.at,
        from,
        to,
        delta: to - from,
        by: rec.source || '聊天',
        reason: rec.reason || rec.appraisal || '',
      }
    })
    const activeSources = Object.values(st.emotion.focal_sources || {})
    const latestReason = activeSources.sort((a, b) => (b.at || 0) - (a.at || 0))[0]?.reason
      || history[0]?.reason
      || ''

    return {
      value,
      label: st.emotion.label || '平平常常',
      reason: latestReason,
      history,
      eightDim: st.emotion.intensities,
      baselines: st.emotion.baselines,
      axes: st.emotion.axes,
    }
  }

  function effects(chat = {}, sessionId = '') {
    if (!engine) return { sticker: 1, voice: 1, delay: 1, chatty: 1 }
    const normChat = typeof chat === 'string' ? { chatId: chat } : (chat || {})
    return engine.behaviorEffectsFor({ chat: normChat, sessionId })
  }

  function contextLine(chat = {}, sessionId = '') {
    if (!engine) return ''
    const normChat = typeof chat === 'string' ? { chatId: chat } : (chat || {})
    return engine.contextBlockFor({ chat: normChat, sessionId })
  }

  function nudge(delta, reason = '') {
    if (!engine) return 60
    const impulses = legacyNudgeToImpulses(delta)
    if (Object.keys(impulses).length > 0) {
      engine.applyExternalImpulse({
        chatId: 'legacy:nudge',
        isOwner: true,
        impulses,
        confidence: 0.85,
        reason: String(reason || '状态触发').slice(0, 60),
      }).catch(() => {})
    }
    return current()
  }

  // 兼容旧版外部模块可能直接调用的空桩（对话轮次评估已收口至 hub turn/end -> engine.recordTurnExchange）
  const observe = () => 0
  const judge = async () => null

  return {
    current,
    label,
    state,
    effects,
    contextLine,
    nudge,
    observe,
    judge,
  }
}
