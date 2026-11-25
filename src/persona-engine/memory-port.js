// 记忆窄端口（MemoryPort）契约与过渡期归档桩实现（ArchiveMemoryStub）。
// 将状态引擎与当前旧记忆模块解耦，后续接入新 Memory 模块只需调用 engine.setMemoryPort(port) 即可无缝替换。

/**
 * 基于引擎自身 `events.jsonl` 的轻量归档记忆桩。
 */
export function createArchiveMemoryPort(storage) {
  return {
    /**
     * 供单轮情绪评估检索最近同会话/同说话人背景摘要（最多返回最近 3 条）。
     */
    async recallForEmotion(personaId, event = {}) {
      const rows = storage.readEvents(personaId, { limit: 60 })
      const matched = rows.filter((r) => {
        if (!r || r.eventId === event.eventId) return false
        if (event.chatId && r.chatId === event.chatId) return true
        if (event.userId && r.userId && String(r.userId) === String(event.userId)) return true
        return false
      })
      return matched.slice(-3).map((r) => ({
        eventId: r.eventId,
        at: r.at,
        who: r.who || (r.isOwner ? '主人' : '对方'),
        userText: String(r.cleanUserText || r.userText || '').slice(0, 100),
        botReply: String(r.botReply || '').slice(0, 100),
      }))
    },

    /**
     * 供低频性格演化器拉取带真实 eventId 的历史交互证据池。
     */
    async listBehaviorEvidence(personaId, { since = 0, limit = 400 } = {}) {
      return storage.readEvents(personaId, { since, limit })
    },
  }
}
