// 拟人状态引擎统一门面（PersonaEngine）：
// 聚合存储层、五维性格编译、八维情绪动力学、单轮不可变快照、异步更新总线与记忆窄端口。

import { EMOTION_DIMS } from './constants.js'
import { safePersonaId, createInitialEmotion, round2 } from './schema.js'
import { createEngineStorage } from './storage.js'
import { computePersonalityModifiers, compilePersonalityPrompt } from './personality-math.js'
import { cleanMessageText } from './emotion-gate.js'
import { createArchiveMemoryPort } from './memory-port.js'
import { createEmotionUpdater } from './emotion-updater.js'
import { createPersonalityEvaluator } from './personality-evaluator.js'
import { buildReadOnlySnapshot, createSnapshotRegistry } from './snapshot.js'

export function createPersonaEngine({
  dsh = null,
  storage: externalStorage = null,
  memoryPort: externalMemoryPort = null,
  getConfig = () => ({}),
  getPersonaMeta = () => ({}),
  log = null,
} = {}) {
  const storage = externalStorage || createEngineStorage({ log })
  let activeMemoryPort = externalMemoryPort || createArchiveMemoryPort(storage)
  const snapshots = createSnapshotRegistry()

  const resolvePersonaId = (explicitId) => {
    if (explicitId) return safePersonaId(explicitId)
    const cfg = getConfig?.() || {}
    return safePersonaId(cfg?.persona?.current || 'dafeiyu')
  }

  const normalizeChatTarget = (chat = {}) => {
    const cfg = getConfig?.() || {}
    const owners = new Set([cfg.ownerQQ, ...(cfg.owners || [])].filter(Boolean).map(String))
    const chatId = String(chat.chatId || '')
    const kind = chat.kind || (chatId.startsWith('private:') ? 'private' : chatId ? 'group' : '')
    const userId = String(
      chat.userId || (chatId.startsWith('private:') ? chatId.slice('private:'.length) : ''),
    )
    const isOwnerPrivate = chat.isOwnerPrivate !== undefined
      ? Boolean(chat.isOwnerPrivate)
      : Boolean(kind === 'private' && userId && owners.has(userId))
    return { chatId, kind, userId, isOwnerPrivate }
  }

  const emotionUpdater = createEmotionUpdater({
    dsh,
    storage,
    getMemoryPort: () => activeMemoryPort,
    getConfig,
    getPersonaMeta,
    log,
  })

  const personalityEvaluator = createPersonalityEvaluator({
    dsh,
    storage,
    getMemoryPort: () => activeMemoryPort,
    getConfig,
    getPersonaMeta,
    log,
  })

  function computeSnapshot({ personaId, chat = {}, now = Date.now() } = {}) {
    const pid = resolvePersonaId(personaId)
    const meta = getPersonaMeta?.(pid) || {}
    const personalityState = storage.loadPersonality(pid, meta.personalitySeeds || null, now)
    const modifiers = computePersonalityModifiers(personalityState.traits)
    const emotionState = storage.loadEmotion(pid, modifiers.baselines, now)
    const normChat = normalizeChatTarget(chat)
    const cfg = getConfig?.() || {}
    return buildReadOnlySnapshot({
      personaId: pid,
      chat: normChat,
      personalityState,
      emotionState,
      ownerTitle: cfg.ownerName || '主人',
      now,
    })
  }

  /**
   * 在新一轮对话发往模型前锁定只读快照（同轮 `steer` 追发时直接复用已有快照保持轮内一致性）。
   */
  function acquireTurnSnapshot({ personaId, chat = {}, sessionId = '', reuseExisting = false, now = Date.now() } = {}) {
    const normChat = normalizeChatTarget(chat)
    if (reuseExisting) {
      const hit = snapshots.get({ sessionId, chatId: normChat.chatId })
      if (hit) return hit
    }
    const snap = computeSnapshot({ personaId, chat: normChat, now })
    return snapshots.store({ sessionId, chatId: normChat.chatId }, snap)
  }

  function getTurnSnapshot({ sessionId = '', chatId = '' } = {}) {
    return snapshots.get({ sessionId, chatId })
  }

  function releaseTurnSnapshot({ sessionId = '', chatId = '' } = {}) {
    snapshots.release({ sessionId, chatId })
  }

  /**
   * 供 `{{aurabot_persona}}` 前缀拼接稳定的五维性格自然语言块（5 档滞回防抖，保护 Prefix Cache）。
   */
  function personaPrefixBlock(personaId, now = Date.now()) {
    const pid = resolvePersonaId(personaId)
    const meta = getPersonaMeta?.(pid) || {}
    const state = storage.loadPersonality(pid, meta.personalitySeeds || null, now)
    return compilePersonalityPrompt(state)
  }

  const isEmotionDisabled = () => {
    const cfg = getConfig?.() || {}
    return cfg.modules?.mood === false || cfg.modules?.mood?.enabled === false || cfg.personaEngine?.emotion?.enabled === false
  }

  /**
   * 供 `systemPrompt.context` 获取会话尾部动态心境提示词（优先读当轮锁定的不可变快照）。
   */
  function contextBlockFor({ personaId, chat = {}, sessionId = '', now = Date.now() } = {}) {
    if (isEmotionDisabled()) return ''
    const normChat = normalizeChatTarget(chat)
    const frozen = snapshots.get({ sessionId, chatId: normChat.chatId })
    if (frozen) return frozen.emotionContext
    return computeSnapshot({ personaId, chat: normChat, now }).emotionContext
  }

  /**
   * 供 `hub.js` 获取表情概率、语音概率、打字延迟、群聊插话欲四项倍率。
   */
  function behaviorEffectsFor({ personaId, chat = {}, sessionId = '', now = Date.now() } = {}) {
    if (isEmotionDisabled()) {
      return { sticker: 1, voice: 1, delay: 1, chatty: 1 }
    }
    const normChat = normalizeChatTarget(chat)
    const frozen = snapshots.get({ sessionId, chatId: normChat.chatId })
    if (frozen) return frozen.behaviorEffects
    return computeSnapshot({ personaId, chat: normChat, now }).behaviorEffects
  }

  /**
   * 在整轮对话完结（turn/end）后归档交互事件，并异步推进情绪评估与周期性格演化检查。
   */
  async function recordTurnExchange(rawTurn = {}) {
    const now = Number(rawTurn.at) || Date.now()
    const pid = resolvePersonaId(rawTurn.personaId)
    const normChat = normalizeChatTarget({
      chatId: rawTurn.chatId,
      kind: rawTurn.chatKind,
      userId: rawTurn.userId,
      isOwnerPrivate: rawTurn.isOwner && rawTurn.chatKind === 'private',
    })
    const cleanUser = cleanMessageText(rawTurn.userText || '')
    const event = {
      eventId: String(rawTurn.eventId || `${normChat.chatId || 'turn'}:${now}`),
      at: now,
      personaId: pid,
      chatId: normChat.chatId,
      chatKind: normChat.kind || 'private',
      userId: normChat.userId || String(rawTurn.userId || ''),
      who: String(rawTurn.who || (rawTurn.isOwner ? '主人' : '群友')).slice(0, 40),
      isOwner: Boolean(rawTurn.isOwner),
      directToBot: rawTurn.directToBot !== undefined ? Boolean(rawTurn.directToBot) : normChat.kind === 'private',
      origin: rawTurn.origin || 'user',
      userText: String(rawTurn.userText || '').slice(0, 800),
      cleanUserText: cleanUser.slice(0, 600),
      botReply: String(rawTurn.botReply || '').slice(0, 800),
      botSilent: Boolean(rawTurn.botSilent),
      affectShift: 0,
    }

    const emoResult = await emotionUpdater.evaluateTurn(pid, event, { now })
    event.affectShift = Number(emoResult?.affectShift || 0)

    // 写入交互证据归档并递增性格待评估轮次计数
    await storage.withMutex(pid, () => {
      storage.appendEvent(pid, event)
      if (cleanUser.length >= 2 || event.origin === 'proactive') {
        const meta = getPersonaMeta?.(pid) || {}
        const pState = storage.loadPersonality(pid, meta.personalitySeeds || null, now)
        pState.turns_since_eval = (pState.turns_since_eval || 0) + 1
        storage.savePersonality(pid, pState)
      }
    })

    let personalityResult = null
    if (personalityEvaluator.shouldAutoEvaluate(pid, now)) {
      personalityResult = await personalityEvaluator.evaluate(pid, { force: false, now })
    }

    return { emotion: emoResult, personality: personalityResult, event }
  }

  /**
   * 承接外部模块显式注入的标准情绪冲量（例如翻唱完成、命令触发或兼容适配层翻译后的冲量）。
   */
  async function applyExternalImpulse({
    personaId,
    chatId = 'internal',
    userId = '',
    isOwner = true,
    impulses = {},
    confidence = 0.85,
    reason = '',
    eventId = '',
    now = Date.now(),
  } = {}) {
    const pid = resolvePersonaId(personaId)
    return emotionUpdater.commitAssessment({
      personaId: pid,
      event: {
        eventId: eventId || `ext:${now}:${Math.random().toString(36).slice(2, 7)}`,
        chatId,
        chatKind: String(chatId).startsWith('group:') ? 'group' : 'private',
        userId,
        isOwner,
        weightOverride: 1.0,
        reason,
      },
      assessment: {
        speaker_affect: '',
        self_appraisal: reason,
        confidence,
        impulses,
        reason,
        via: 'external',
      },
      now,
    })
  }

  /**
   * 将当前角色八维情绪一键平复回性格静息基线（保留历史审计并递增版本号）。
   */
  async function resetEmotion(personaId, { reason = '手动平复情绪', now = Date.now() } = {}) {
    const pid = resolvePersonaId(personaId)
    return storage.withMutex(pid, () => {
      const meta = getPersonaMeta?.(pid) || {}
      const personality = storage.loadPersonality(pid, meta.personalitySeeds || null, now)
      const modifiers = computePersonalityModifiers(personality.traits)
      const cur = storage.loadEmotion(pid, modifiers.baselines, now)
      const before = Object.fromEntries(EMOTION_DIMS.map((d) => [d, cur.emotions[d]?.intensity ?? 0]))

      const reset = createInitialEmotion(pid, modifiers.baselines, now)
      reset.version = cur.version + 1
      reset.processed_event_ids = cur.processed_event_ids || []
      storage.saveEmotion(pid, reset)

      const after = Object.fromEntries(EMOTION_DIMS.map((d) => [d, reset.emotions[d].intensity]))
      const deltas = Object.fromEntries(EMOTION_DIMS.map((d) => [d, round2(after[d] - before[d])]))
      storage.appendEmotionAudit(pid, {
        version: reset.version,
        prev_version: cur.version,
        at: now,
        trigger_event_ids: [],
        source: 'reset',
        speaker_affect: '',
        appraisal: reason,
        confidence: 1,
        via: 'reset',
        before,
        after,
        deltas,
        reason,
      })

      return { ok: true, state: reset }
    })
  }

  /**
   * 读取完整实时状态视图（供管理 API、QQ 命令与兼容适配层消费，不触发写盘）。
   */
  function getState(personaId, { chat = {}, now = Date.now() } = {}) {
    const pid = resolvePersonaId(personaId)
    const meta = getPersonaMeta?.(pid) || {}
    const personality = storage.loadPersonality(pid, meta.personalitySeeds || null, now)
    const modifiers = computePersonalityModifiers(personality.traits)
    const rawEmotion = storage.loadEmotion(pid, modifiers.baselines, now)
    const snap = buildReadOnlySnapshot({
      personaId: pid,
      chat: normalizeChatTarget(chat),
      personalityState: personality,
      emotionState: rawEmotion,
      now,
    })

    return {
      personaId: pid,
      personaName: meta.name || pid,
      personality,
      emotion: {
        version: rawEmotion.version,
        updated_at: rawEmotion.updated_at,
        confidence: rawEmotion.confidence,
        intensities: snap.rawDecayedEmotions,
        effective: snap.effectiveEmotions,
        baselines: snap.baselines,
        axes: snap.axes,
        label: snap.emotionLabel,
        valenceArousal: snap.valenceArousal,
        behaviorEffects: snap.behaviorEffects,
        focal_sources: snap.activeFocalSources,
        raw_emotions: rawEmotion.emotions,
      },
      modifiers,
      prompts: {
        personalityBlock: snap.personalityPrompt,
        emotionContext: snap.emotionContext,
      },
    }
  }

  function getAudit(personaId, { kind = 'emotion', limit = 50, since = 0 } = {}) {
    const pid = resolvePersonaId(personaId)
    if (kind === 'personality') return storage.readPersonalityAudit(pid, { limit, since })
    return storage.readEmotionAudit(pid, { limit, since })
  }

  return {
    storage,
    setMemoryPort: (port) => { if (port) activeMemoryPort = port },
    getMemoryPort: () => activeMemoryPort,
    personaPrefixBlock,
    acquireTurnSnapshot,
    getTurnSnapshot,
    releaseTurnSnapshot,
    contextBlockFor,
    behaviorEffectsFor,
    recordTurnExchange,
    applyExternalImpulse,
    resetEmotion,
    getState,
    getAudit,
    evaluatePersonality: (personaId, opts) => personalityEvaluator.evaluate(resolvePersonaId(personaId), opts),
    rollbackPersonality: (personaId, opts) => personalityEvaluator.rollback(resolvePersonaId(personaId), opts),
  }
}
