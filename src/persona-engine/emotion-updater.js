// 异步情绪评估与串行提交器：分离「说话人情绪」与「角色自身立场感受」，杜绝共情污染与并发写覆盖。

import { askModel } from '../core/llm.js'
import { shouldDeferBackground } from '../core/offpeak.js'
import { EMOTION_DIMS, EMOTION_LABELS, EMOTION_PARAMS } from './constants.js'
import { clip, round2 } from './schema.js'
import { computePersonalityModifiers } from './personality-math.js'
import {
  decayAllEmotions,
  cleanImpulse,
  stepEmotionState,
} from './emotion-math.js'
import {
  cleanMessageText,
  shouldInvokeLLM,
  heuristicAssess,
} from './emotion-gate.js'

/**
 * 从模型输出中稳健提取第一个顶层平衡 JSON 对象；非 JSON 文本安全返回 null。
 */
export function extractFirstJsonObject(raw = '') {
  const s = String(raw || '').trim()
  if (!s) return null
  const start = s.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inStr = false
      }
      continue
    }
    if (ch === '"') {
      inStr = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * 校验并清洗情绪评估 JSON，剔除未知键与低幅噪声。
 */
export function parseEmotionAssessment(raw) {
  const obj = typeof raw === 'string' ? extractFirstJsonObject(raw) : raw
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  const confidence = round2(clip(Number(obj.confidence ?? 0.75), 0, 1))
  const srcImp = obj.impulses && typeof obj.impulses === 'object' ? obj.impulses : {}
  const impulses = {}
  for (const dim of EMOTION_DIMS) {
    if (srcImp[dim] === undefined) continue
    const v = cleanImpulse(srcImp[dim])
    if (v !== 0) impulses[dim] = v
  }

  return {
    speaker_affect: String(obj.speaker_affect || '').trim().slice(0, 120),
    self_appraisal: String(obj.self_appraisal || '').trim().slice(0, 120),
    confidence,
    impulses,
    reason: String(obj.reason || obj.self_appraisal || '').trim().slice(0, 60),
    via: 'llm',
  }
}

const EMOTION_EVAL_SYSTEM = [
  '你是角色内在情绪评估器。请严格区分【对方说话带有的情绪】与【角色自身立场产生的情绪反应】：',
  '1. 如果信任的主人在向角色倾诉烦恼或骂工作糟心事，角色产生的是心疼/担忧(fear)或陪伴信任(trust)，绝不是角色自己对主人发火(anger)！',
  '2. 如果对方直接冒犯、敷衍、冤枉角色，角色才会产生生气(anger)、委屈难过(sadness)或嫌弃(disgust)。',
  '3. 如果对方在诚心道歉、哄角色或夸奖角色，正在气头上/难过时会对 anger/sadness 给出负向平复冲量（如 -1.2），并增加 joy/trust。',
  '4. 平淡日常闲聊无需强行加戏，impulses 留空对象 {}。',
  '只输出一个 JSON 对象，不要解释，字段固定如下：',
  '{"speaker_affect":"对方情绪与意图简述","self_appraisal":"角色自身感受简述","confidence":0.0到1.0,"impulses":{"joy":0,"sadness":0,"anger":0,"fear":0,"trust":0,"disgust":0,"surprise":0,"anticipation":0},"reason":"15字以内起因"}',
  '其中 impulses 只填有明显变化的维度，范围 [-3.0, +3.0]，轻微波动填 ±0.4~0.9，明显刺激填 ±1.0~1.8，重大冲击填 ±2.0~3.0。',
].join('\n')

function buildEmotionEvalUserPrompt({ personaName, event, currentEmotions, baselines, recentContext }) {
  const activeLines = []
  for (const dim of EMOTION_DIMS) {
    const v = Number(currentEmotions[dim] ?? 0)
    const b = Number(baselines[dim] ?? 0)
    if (Math.abs(v - b) >= 0.35 || v >= 1.0) {
      activeLines.push(`${EMOTION_LABELS[dim]}(${dim})=${v.toFixed(2)}(基线${b.toFixed(2)})`)
    }
  }
  const historyLines = (recentContext || [])
    .map((r) => `- ${r.who}: ${r.userText} → ${personaName}: ${r.botReply}`)
    .join('\n')

  const scene = event.isOwner
    ? (event.chatKind === 'private' ? '主人私聊' : '群聊（说话人是主人）')
    : (event.chatKind === 'private' ? '好友私聊' : '群聊互动')

  return [
    `角色名：${personaName || '大肥鱼'}`,
    `场景：${scene}${event.origin === 'proactive' ? '（角色主动搭话回合）' : ''}`,
    `角色当前活跃情绪：${activeLines.length ? activeLines.join('，') : '平静日常基线'}`,
    historyLines ? `近期上下文：\n${historyLines}` : '',
    `本轮对方（${event.who || (event.isOwner ? '主人' : '群友')}）说：\n${String(event.userText || '').slice(0, 500)}`,
    `本轮${personaName || '角色'}回复：\n${event.botSilent ? '[选择沉默未回复]' : String(event.botReply || '').slice(0, 500)}`,
  ].filter(Boolean).join('\n\n')
}

export function createEmotionUpdater({ dsh, storage, getMemoryPort, getConfig, getPersonaMeta, log }) {
  /**
   * 在角色专属互斥锁内原子提交一次情绪冲量评估。
   */
  async function commitAssessment({ personaId, event = {}, assessment, now = Date.now() }) {
    return storage.withMutex(personaId, () => {
      const meta = getPersonaMeta?.(personaId) || {}
      const personality = storage.loadPersonality(personaId, meta.personalitySeeds || null, now)
      const modifiers = computePersonalityModifiers(personality.traits)
      const state = storage.loadEmotion(personaId, modifiers.baselines, now)

      if (event.eventId && state.processed_event_ids.includes(event.eventId)) {
        return { skipped: 'duplicate', state, affectShift: 0 }
      }

      const { nextEmotions, nextFocal, before, after, deltas, valid } = stepEmotionState({
        state,
        assessment,
        event,
        modifiers,
        now,
      })

      const affectShift = round2(
        EMOTION_DIMS.reduce((acc, d) => acc + Math.abs(deltas[d] || 0), 0),
      )

      // 若本次无任何实质变化且无幂等记录需求，仅登记 eventId 防重，不虚增审计噪音
      const prevVersion = state.version
      const iso = new Date(now).toISOString()
      state.emotions = nextEmotions
      state.focal_sources = nextFocal
      state.version = prevVersion + 1
      state.updated_at = iso
      state.confidence = valid ? round2(clip(assessment.confidence, 0, 1)) : state.confidence
      if (event.eventId) {
        state.processed_event_ids = [...state.processed_event_ids, String(event.eventId)].slice(-500)
        state.trigger_event_ids = [String(event.eventId)]
      }

      storage.saveEmotion(personaId, state)
      storage.appendEmotionAudit(personaId, {
        version: state.version,
        prev_version: prevVersion,
        at: now,
        trigger_event_ids: event.eventId ? [String(event.eventId)] : [],
        source: String(event.chatId || 'internal'),
        speaker_affect: assessment?.speaker_affect || '',
        appraisal: assessment?.self_appraisal || '',
        confidence: round2(clip(assessment?.confidence ?? 1, 0, 1)),
        via: assessment?.via || 'direct',
        before,
        after,
        deltas,
        reason: String(assessment?.reason || event.reason || '').slice(0, 80),
      })

      return { skipped: null, state, deltas, affectShift }
    })
  }

  /**
   * 评估一整轮对话交互并在有显著冲量时落盘。
   */
  async function evaluateTurn(personaId, rawEvent = {}, { now = Date.now() } = {}) {
    const cfg = getConfig?.() || {}
    const moodModOff = cfg.modules?.mood === false || cfg.modules?.mood?.enabled === false
    if (moodModOff || cfg.personaEngine?.emotion?.enabled === false) {
      return { skipped: 'disabled', affectShift: 0 }
    }

    const event = {
      ...rawEvent,
      cleanUserText: rawEvent.cleanUserText ?? cleanMessageText(rawEvent.userText),
    }

    const meta = getPersonaMeta?.(personaId) || {}
    const personality = storage.loadPersonality(personaId, meta.personalitySeeds || null, now)
    const modifiers = computePersonalityModifiers(personality.traits)
    const curState = storage.loadEmotion(personaId, modifiers.baselines, now)

    if (event.eventId && curState.processed_event_ids.includes(event.eventId)) {
      return { skipped: 'duplicate', affectShift: 0 }
    }

    const decayed = decayAllEmotions(curState, modifiers.baselines, modifiers.tauScale, now)
    if (!shouldInvokeLLM(event, decayed.intensities, modifiers.baselines)) {
      return { skipped: 'gate', affectShift: 0 }
    }

    const evalModelCfg = cfg.personaEngine?.emotion?.evalModel
    const hasDedicatedModel = Boolean(evalModelCfg?.provider && evalModelCfg?.model)
    const llmEnabled = cfg.personaEngine?.emotion?.llm !== false && Boolean(dsh)
    const deferPeak = !event.isOwner && !hasDedicatedModel && shouldDeferBackground(cfg, new Date(now))

    let assessment = null
    if (llmEnabled && !deferPeak) {
      try {
        const memPort = getMemoryPort?.()
        const recentContext = memPort ? await memPort.recallForEmotion(personaId, event) : []
        const rawOut = await askModel(dsh, {
          system: EMOTION_EVAL_SYSTEM,
          text: buildEmotionEvalUserPrompt({
            personaName: meta.name || personaId,
            event,
            currentEmotions: decayed.intensities,
            baselines: modifiers.baselines,
            recentContext,
          }),
          maxTokens: 320,
          temperature: 0.2,
          cfg,
          ...(hasDedicatedModel ? { model: evalModelCfg } : {}),
        })
        assessment = parseEmotionAssessment(rawOut)
      } catch (error) {
        log?.debug?.('情绪评估模型调用失败，跳过本轮：', error.message)
        return { skipped: 'llm-error', affectShift: 0 }
      }
    } else {
      assessment = heuristicAssess(event, decayed.intensities, modifiers.baselines)
    }

    if (!assessment || assessment.confidence < EMOTION_PARAMS.minConfidence || !Object.keys(assessment.impulses || {}).length) {
      return { skipped: 'no-impulse', affectShift: 0 }
    }

    return commitAssessment({ personaId, event, assessment, now })
  }

  return {
    commitAssessment,
    evaluateTurn,
  }
}
