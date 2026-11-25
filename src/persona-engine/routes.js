// 拟人状态引擎 HTTP 管理接口（统一挂载于 `/aurabot/api/persona-engine/*`，自动继承 host.js 本机回环闸、DNS rebinding 防护与 CSRF 校验）。

export function registerPersonaEngineRoutes({ route, query, readBody, personaEngine }) {
  route('/persona-engine/state', async (req) => {
    const q = query(req)
    const chat = q.chatId ? { chatId: String(q.chatId) } : {}
    return {
      ok: true,
      ...personaEngine.getState(q.persona || undefined, { chat }),
    }
  })

  route('/persona-engine/audit', async (req) => {
    const q = query(req)
    const kind = q.kind === 'personality' ? 'personality' : 'emotion'
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))
    const since = Math.max(0, Number(q.since) || 0)
    return {
      ok: true,
      kind,
      items: personaEngine.getAudit(q.persona || undefined, { kind, limit, since }),
    }
  })

  route('/persona-engine/personality/evaluate', async (req) => {
    const b = await readBody(req)
    const res = await personaEngine.evaluatePersonality(b.persona || undefined, {
      dryRun: Boolean(b.dryRun),
      force: b.force !== false,
    })
    return { ...res, ok: res.ok !== false }
  })

  route('/persona-engine/personality/rollback', async (req) => {
    const b = await readBody(req)
    const res = await personaEngine.rollbackPersonality(b.persona || undefined, {
      toVersion: b.toVersion ?? null,
      toSeed: Boolean(b.toSeed),
    })
    return res
  })

  route('/persona-engine/emotion/reset', async (req) => {
    const b = await readBody(req)
    const res = await personaEngine.resetEmotion(b.persona || undefined, {
      reason: String(b.reason || '面板手动平复情绪').slice(0, 60),
    })
    return res
  })
}
