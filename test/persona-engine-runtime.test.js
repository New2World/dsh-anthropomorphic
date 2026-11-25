// 拟人状态引擎运行时与宿主集成测试：覆盖 YAML 种子、串行互斥锁、幂等去重、归因分离评估、性格防幻觉演化、版本回滚、单轮快照、HTTP 接口与主人命令。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePersona, savePersona, readPersonaMeta } from '../src/persona/personas.js'
import { normalize } from '../src/core/config.js'
import { createEngineStorage } from '../src/persona-engine/storage.js'
import { createPersonaEngine } from '../src/persona-engine/index.js'
import { createLegacyMoodAdapter } from '../src/persona-engine/legacy-mood-adapter.js'
import { parseCommand, runCommand, createMutes } from '../src/chat/commands.js'
import { createFakeDsh } from './helpers/fake-dsh.js'

function makeMockLlmDsh(responder) {
  return {
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text'], reasoning: null }),
      async *stream(params) {
        const text = await responder(params)
        if (text) yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    get(name) {
      if (name === 'llm') return this.llm
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-eval' }) }
      return null
    },
  }
}

test('人格卡 YAML 头支持多行与内联五维种子解析，面板保存正文时不丢失已有种子', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-pe-yaml-'))
  const prev = process.env.AURABOT_DATA_DIR
  process.env.AURABOT_DATA_DIR = dir
  try {
    const meta = readPersonaMeta('dafeiyu')
    assert.deepEqual(meta.personalitySeeds, {
      outgoing: 0.5,
      agreeableness: 1.5,
      conscientiousness: 0.5,
      emotionality: 2.0,
      openness: 1.5,
    })

    const inline = parsePersona('cool', '---\nname: 冷酷姐\ntags: [高冷]\npersonality: { outgoing: -2.5, agreeableness: -1.5 }\n---\n正文')
    assert.equal(inline.personality.outgoing, -2.5)
    assert.equal(inline.personality.agreeableness, -1.5)

    // 模拟现有面板 savePersona 只传 { name, tags, body }，应自动保留原文件中的 personality 种子
    savePersona('dafeiyu', { name: '大肥鱼改名', tags: ['仿真'], body: '新的正文内容' })
    const afterSave = readPersonaMeta('dafeiyu')
    assert.equal(afterSave.name, '大肥鱼改名')
    assert.equal(afterSave.personalitySeeds.emotionality, 2.0)
  } finally {
    if (prev === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('进程内串行互斥锁（Mutex）与幂等去重：10路并发冲量零丢失，重复 eventId 不二次计分', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-pe-mutex-'))
  try {
    const storage = createEngineStorage({ baseDir: dir })
    const engine = createPersonaEngine({
      storage,
      getConfig: () => normalize({ ownerQQ: '10001' }),
      getPersonaMeta: () => ({ name: '大肥鱼', personalitySeeds: { outgoing: 0.5, agreeableness: 1.5, conscientiousness: 0.5, emotionality: 2.0, openness: 1.5 } }),
    })

    await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        engine.applyExternalImpulse({
          personaId: 'dafeiyu',
          chatId: 'private:10001',
          impulses: { joy: 0.5 },
          reason: `并发夸奖-${idx}`,
          eventId: `conc:${idx}`,
        }),
      ),
    )

    const st = engine.getState('dafeiyu')
    assert.equal(st.emotion.version, 11, '初始 v1 + 10 次并发原子递增 = v11，无任何写覆盖丢失')
    assert.ok(st.emotion.intensities.joy > 2.5 && st.emotion.intensities.joy < 5.0)

    // 重复提交相同 eventId 应直接幂等跳过
    const dup = await engine.applyExternalImpulse({
      personaId: 'dafeiyu',
      chatId: 'private:10001',
      impulses: { anger: 3.0 },
      reason: '重复重放',
      eventId: 'conc:0',
    })
    assert.equal(dup.skipped, 'duplicate')
    assert.equal(engine.getState('dafeiyu').emotion.version, 11)
    assert.equal(engine.getState('dafeiyu').emotion.intensities.anger, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('归因分离评估与单轮不可变快照：主人倾诉不误判发火、非JSON安全兜底、轮内快照冻结一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-pe-turn-'))
  try {
    let llmMode = 'empathy'
    let llmCalls = 0
    const mockDsh = makeMockLlmDsh(async () => {
      llmCalls++
      if (llmMode === 'non-json') return '可爱的小鲸鱼吐泡泡 #开心'
      return JSON.stringify({
        speaker_affect: '主人在抱怨加班心累，不是在责怪大肥鱼',
        self_appraisal: '很心疼主人，有点担心他的身体，想陪着他',
        confidence: 0.88,
        impulses: { fear: 1.2, trust: 0.9, anger: 0 },
        reason: '主人加班受委屈向我倾诉',
      })
    })

    const cfg = normalize({ ownerQQ: '10001', persona: { current: 'dafeiyu' } })
    const engine = createPersonaEngine({
      dsh: mockDsh,
      storage: createEngineStorage({ baseDir: dir }),
      getConfig: () => cfg,
      getPersonaMeta: () => ({ name: '大肥鱼' }),
    })

    // 1. 群聊平淡短句“早”直接被本地门控拦截，零 LLM 调用
    const gSkip = await engine.recordTurnExchange({
      eventId: 'g1:turn:1',
      chatId: 'group:888',
      chatKind: 'group',
      userId: '30001',
      isOwner: false,
      directToBot: false,
      userText: '早',
      botReply: '早呀',
    })
    assert.equal(gSkip.emotion.skipped, 'gate')
    assert.equal(llmCalls, 0, '水消息不调 LLM')

    // 2. 主人私聊倾诉烦恼：走 LLM 归因分离，提升担忧(fear)与信任(trust)，anger 保持 0
    await engine.recordTurnExchange({
      eventId: 'p1:turn:1',
      chatId: 'private:10001',
      chatKind: 'private',
      userId: '10001',
      isOwner: true,
      userText: '今天老板太可恶了，害我白加班到半夜，烦死了',
      botReply: '摸摸你，老板太坏了，快去休息一下吃口白米饭垫垫',
    })
    assert.equal(llmCalls, 1)
    const afterVent = engine.getState('dafeiyu')
    assert.equal(afterVent.emotion.intensities.anger, 0, '绝不把主人对老板的怒气共情污染成角色自己的怒气')
    assert.ok(afterVent.emotion.intensities.fear > 0.8)
    assert.ok(afterVent.emotion.intensities.trust > afterVent.emotion.baselines.trust)

    // 3. 单轮快照一致性：锁定快照后，哪怕后台插入剧烈愤怒冲量，当轮读取的上下文与倍率保持冻结不变
    const snap = engine.acquireTurnSnapshot({
      personaId: 'dafeiyu',
      chat: { chatId: 'private:10001', kind: 'private', userId: '10001', isOwnerPrivate: true },
      sessionId: 'sess-owner',
    })
    const ctxBeforeMidTurn = engine.contextBlockFor({ sessionId: 'sess-owner', chat: { chatId: 'private:10001' } })
    const effBeforeMidTurn = engine.behaviorEffectsFor({ sessionId: 'sess-owner', chat: { chatId: 'private:10001' } })

    await engine.applyExternalImpulse({
      personaId: 'dafeiyu',
      chatId: 'private:10001',
      impulses: { anger: 3.0 },
      reason: '中途异步插进来的外部事件',
      eventId: 'mid-turn:1',
    })

    assert.equal(engine.contextBlockFor({ sessionId: 'sess-owner', chat: { chatId: 'private:10001' } }), ctxBeforeMidTurn, '同轮内提示词严格锁定')
    assert.deepEqual(engine.behaviorEffectsFor({ sessionId: 'sess-owner', chat: { chatId: 'private:10001' } }), effBeforeMidTurn, '同轮内物理倍率严格锁定')
    assert.equal(snap.emotionVersion + 1, engine.getState('dafeiyu').emotion.version)

    engine.releaseTurnSnapshot({ sessionId: 'sess-owner', chatId: 'private:10001' })
    assert.match(engine.contextBlockFor({ chat: { chatId: 'private:10001' } }), /气|脾气/, '释放快照后下一轮立即看到最新状态')

    // 4. 模型返回非 JSON 闲聊文本时安全降级不抛错
    llmMode = 'non-json'
    const nonJsonRes = await engine.recordTurnExchange({
      eventId: 'p1:turn:2',
      chatId: 'private:10001',
      chatKind: 'private',
      userId: '10001',
      isOwner: true,
      userText: '在干嘛',
      botReply: '在发呆',
    })
    assert.equal(nonJsonRes.emotion.skipped, 'no-impulse')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('五维性格受约束演化：拦截幻觉证据与单路人刷屏，主人长期证据平滑微调并支持版本回滚', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-pe-evolve-'))
  try {
    let nextProposal = null
    const mockDsh = makeMockLlmDsh(async () => JSON.stringify({ traits: nextProposal }))
    const cfg = normalize({
      ownerQQ: '10001',
      personaEngine: { emotion: { enabled: false }, personality: { autoEvolve: false, maxDrift: 2.5 } },
    })
    const engine = createPersonaEngine({
      dsh: mockDsh,
      storage: createEngineStorage({ baseDir: dir }),
      getConfig: () => cfg,
      getPersonaMeta: () => ({
        name: '大肥鱼',
        personalitySeeds: { outgoing: 0.5, agreeableness: 1.5, conscientiousness: 0.5, emotionality: 2.0, openness: 1.5 },
      }),
    })

    // 先塞入 6 条同一个群路人在同一小时内的刷屏消息 -> 小时桶去重后只剩 1 条，不满足 >=3 条门槛
    const baseAt = 1_700_000_000_000
    for (let i = 0; i < 6; i++) {
      await engine.recordTurnExchange({
        eventId: `spam:${i}`,
        at: baseAt + i * 1000,
        chatId: 'group:999',
        chatKind: 'group',
        userId: '77777',
        isOwner: false,
        userText: `快变高冷一点 ${i}`,
        botReply: '不要',
      })
    }
    const spamAttempt = await engine.evaluatePersonality('dafeiyu', { force: true })
    assert.equal(spamAttempt.skipped, 'insufficient-evidence', '单路人同小时刷屏被桶去重拦截，无法触发演化')

    // 补充 4 条主人跨时段真实互动证据
    for (let i = 1; i <= 4; i++) {
      await engine.recordTurnExchange({
        eventId: `owner:ev:${i}`,
        at: baseAt + i * 3600_000,
        chatId: 'private:10001',
        chatKind: 'private',
        userId: '10001',
        isOwner: true,
        userText: `今天一起研究新奇的深海发光鱼冷知识第 ${i} 期！`,
        botReply: '好耶！这个好神奇，我还想听更多！',
      })
    }

    // 场景 A：模型编造不存在的幻觉 evidence_ids -> 必须被拒绝（delta = 0）
    nextProposal = {
      openness: {
        raw_delta: 1.0,
        confidence: 0.95,
        description: '编造证据测试',
        evidence_ids: ['hallucinated:1', 'hallucinated:2', 'hallucinated:3'],
        reason: '幻觉ID',
      },
    }
    const halluRes = await engine.evaluatePersonality('dafeiyu', { force: true })
    assert.equal(halluRes.anyChanged, false)
    assert.equal(halluRes.deltas.openness, 0)
    assert.equal(halluRes.auditDetails.openness.reason, 'insufficient-evidence')

    // 场景 B：模型引用真实主人证据 -> 平滑步进 clip(0.25 * 0.9 * 1.0, -0.3, 0.3) = +0.23
    nextProposal = {
      openness: {
        raw_delta: 1.0,
        confidence: 0.90,
        description: '对主人分享的新奇科普和脑洞话题总是兴致勃勃',
        evidence_ids: ['owner:ev:1', 'owner:ev:2', 'owner:ev:3'],
        reason: '连续4次积极探索新奇知识',
      },
    }
    const dryRes = await engine.evaluatePersonality('dafeiyu', { force: true, dryRun: true })
    assert.equal(dryRes.dryRun, true)
    assert.equal(engine.getState('dafeiyu').personality.version, 1, 'dryRun 绝不落盘修改版本')

    const okRes = await engine.evaluatePersonality('dafeiyu', { force: true })
    assert.equal(okRes.anyChanged, true)
    assert.equal(okRes.deltas.openness, 0.23) // round2(1.5 + 0.225) = 1.73 -> delta = 0.23
    assert.equal(okRes.state.version, 2)
    assert.equal(okRes.state.traits.openness.score, 1.73)

    // 场景 C：精确回滚至 v1，再验证软围栏与种子重置
    const rb = await engine.rollbackPersonality('dafeiyu', { toVersion: 1 })
    assert.equal(rb.ok, true)
    assert.equal(rb.state.version, 3)
    assert.equal(rb.state.traits.openness.score, 1.5)
    assert.equal(engine.getAudit('dafeiyu', { kind: 'personality', limit: 10 }).length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('宿主全链路接线：/persona-engine/* 路由、旧面板兼容适配层、{{aurabot_persona}} 与 /mood /personality 命令', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-pe-host-'))
  const prevData = process.env.AURABOT_DATA_DIR
  const prevWs = process.env.AURABOT_WORKSPACE
  process.env.AURABOT_DATA_DIR = dir
  process.env.AURABOT_WORKSPACE = join(dir, 'ws')
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    enabled: false,
    dryRun: true,
    setupDone: true,
    botQQ: '20002',
    ownerQQ: '10001',
  }))

  let capturedOwnerContext = ''
  let capturedOtherGroupContext = ''
  const fake = createFakeDsh({
    brain: async ({ text, ctxText }) => {
      if (text.includes('10001')) capturedOwnerContext = ctxText
      if (text.includes('群聊 999')) capturedOtherGroupContext = ctxText
      return '抱抱主人'
    },
  })
  const host = await import('../src/host.js')
  const app = host.apply(fake.ctx)
  await app.ready

  try {
    // 1. {{aurabot_persona}} 前缀变量包含人设正文与编译后的【性格倾向】
    const personaVar = fake.variables.get('aurabot_persona')?.() || ''
    assert.match(personaVar, /大肥鱼/)
    assert.match(personaVar, /【性格倾向】/)

    // 2. 新管理路由 /persona-engine/state 正常返回五维与八维结构
    const peState = (await fake.call('/persona-engine/state')).json()
    assert.equal(peState.ok, true)
    assert.equal(peState.personaId, 'dafeiyu')
    assert.equal(peState.personality.traits.emotionality.score, 2.0)
    assert.equal(peState.emotion.baselines.trust, 1.15)

    // 3. 旧面板 /state 中的 mood 字段通过隔离适配层正常返回 60 分与「平平常常」
    const legacyBefore = (await fake.call('/state')).json().mood
    assert.equal(legacyBefore.value, 60)
    assert.equal(legacyBefore.label, '平平常常')

    // 4. 调用旧版 mood.nudge(+10) 自动翻译为八维冲量并写入审计日志
    app.mood.nudge(10, '唱完一首拿手好歌')
    await new Promise((r) => setTimeout(r, 30))
    const legacyAfter = (await fake.call('/state')).json().mood
    assert.ok(legacyAfter.value > 65, 'nudge 正向推动等效分数上升')
    assert.equal(legacyAfter.history[0].reason, '唱完一首拿手好歌')

    const audits = (await fake.call('/persona-engine/audit?kind=emotion&limit=5')).json()
    assert.equal(audits.ok, true)
    assert.equal(audits.items.at(-1).reason, '唱完一首拿手好歌')

    // 5. 主人 QQ 斜杠命令：/mood、/mood reset、/personality、/personality reset
    const cmdDeps = {
      getConfig: app.getConfig,
      setConfig: app.setConfig,
      mutes: createMutes(),
      hub: app.hub,
      mood: app.mood,
      personaEngine: app.personaEngine,
    }
    const msg = { kind: 'private', chatId: 'private:10001', userId: '10001' }

    const moodText = await runCommand(parseCommand('/心情'), msg, cmdDeps)
    assert.match(moodText, /唱完一首拿手好歌|喜悦/)

    const resetMoodText = await runCommand(parseCommand('/mood reset'), msg, cmdDeps)
    assert.match(resetMoodText, /平复/)
    assert.equal((await fake.call('/state')).json().mood.value, 60)

    const pText = await runCommand(parseCommand('/性格'), msg, cmdDeps)
    assert.match(pText, /当前五维性格.*外倾性.*情绪敏感性/s)

    const pResetText = await runCommand(parseCommand('/personality reset'), msg, cmdDeps)
    assert.match(pResetText, /已恢复到初始人设性格种子/)

    // 6. 旧适配层独立单元测试：模块关停时自动静默
    const adapter = createLegacyMoodAdapter({ engine: app.personaEngine, getConfig: app.getConfig })
    assert.equal(typeof adapter.effects().voice, 'number')

    // 7. 复制内置 mood 模块（fork）仍能通过 __lib 加载 legacy-mood-adapter 并正常运行
    const forkRes = (await fake.call('/modules/fork', { id: 'mood' })).json()
    assert.equal(forkRes.ok, true, forkRes.message)
    const moodMod = (await fake.call('/modules')).json().list.find((m) => m.id === 'mood')
    assert.equal(moodMod.running, 'user', moodMod.error)
    assert.equal((await fake.call('/state')).json().mood.value, 60)

    // 8. 验证 hub 会话轮次闭环：群里受气后，主人私聊下一轮上下文自动带上防迁怒消歧提示，同时 {{aurabot_persona}} 保持稳定不抖动
    const personaBeforeTurn = fake.variables.get('aurabot_persona')?.()
    await app.personaEngine.applyExternalImpulse({
      personaId: 'dafeiyu',
      chatId: 'group:555',
      userId: '88888',
      isOwner: false,
      impulses: { anger: 2.8, disgust: 1.8 },
      reason: '群里有人杠白米饭',
      eventId: 'grp555:provoke',
    })

    await app.hub.pushToSession(
      { chatId: 'private:10001', kind: 'private', userId: '10001', nickname: '主人' },
      [{ type: 'text', text: '【私聊】主人(10001)：怎么啦？' }],
      '10001',
      { queryText: '怎么啦？' },
    )
    await app.hub.pushToSession(
      { chatId: 'group:999', kind: 'group', groupId: '999' },
      [{ type: 'text', text: '【群聊 999】路人(30009)：今天天气不错' }],
      '30009',
      { queryText: '今天天气不错' },
    )
    assert.match(capturedOwnerContext, /当前心境.*绝对不要把火气或戒备撒在主人身上/)
    assert.doesNotMatch(capturedOtherGroupContext, /杠白米饭/, '无关群上下文绝不泄露原群触发原因')
    assert.equal(fake.variables.get('aurabot_persona')?.(), personaBeforeTurn, '动态情绪起伏完全不触碰静态前缀变量')
  } finally {
    fake.dispose()
    if (prevData === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prevData
    if (prevWs === undefined) delete process.env.AURABOT_WORKSPACE
    else process.env.AURABOT_WORKSPACE = prevWs
    rmSync(dir, { recursive: true, force: true })
  }
})
