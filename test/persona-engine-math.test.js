// 拟人状态引擎纯数学与编译器单元测试：覆盖调制矩阵、平台期+指数衰减、防爆顶阻尼、单维时间戳不变量、滞回防抖、跨会话防迁怒与泄漏防护。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PERSONA_SEEDS } from '../src/persona-engine/constants.js'
import { createInitialPersonality, createInitialEmotion } from '../src/persona-engine/schema.js'
import {
  computePersonalityModifiers,
  discretizeTraitTier,
  compilePersonalityPrompt,
} from '../src/persona-engine/personality-math.js'
import {
  decayDimension,
  decayAllEmotions,
  applyDampedImpulse,
  stepEmotionState,
  projectCrossSessionEmotion,
  computeValenceArousal,
  computeBehaviorEffects,
} from '../src/persona-engine/emotion-math.js'
import { compileEmotionContext, summarizeEmotionLabel } from '../src/persona-engine/compiler.js'
import { cleanOutboundText } from '../src/chat/reply.js'
import { promptFingerprint } from '../src/security/leak-guard.js'

const MIN = 60_000
const HOUR = 60 * MIN

test('五维性格调制矩阵：大肥鱼默认种子基线与乘性对称性校验', () => {
  const mod = computePersonalityModifiers(DEFAULT_PERSONA_SEEDS.dafeiyu)
  assert.equal(mod.baselines.trust, 1.15)
  assert.equal(mod.baselines.joy, 0.58)
  assert.equal(mod.baselines.anticipation, 0.76)
  assert.equal(mod.baselines.anger, 0)
  assert.equal(mod.baselines.sadness, 0)
  assert.ok(mod.tauScale.sadness > 1.05, '高情绪敏感性延长负面情绪恢复时间常数')
  assert.equal(mod.tauScale.joy, 1.0)
  assert.ok(mod.gain.sadness > mod.gain.anger, '高宜人+高敏感受挫时更倾向委屈而非外攻发火')

  // 极端正负性格增益严格恒正且乘性对称
  const posExtreme = computePersonalityModifiers({ outgoing: 5, openness: 5, agreeableness: 5, emotionality: 5, conscientiousness: 5 })
  const negExtreme = computePersonalityModifiers({ outgoing: -5, openness: -5, agreeableness: -5, emotionality: -5, conscientiousness: -5 })
  for (const k of Object.keys(posExtreme.gain)) {
    assert.ok(posExtreme.gain[k] > 0 && negExtreme.gain[k] > 0)
  }
  assert.ok(Math.abs(posExtreme.gPos * negExtreme.gPos - 1) < 0.02)
})

test('余温平台期 + 分维度指数衰减 + 8小时隔夜恢复轨迹', () => {
  const t0 = 1_000_000
  // anger: 平台期 8min，tau 180min，基线 0
  assert.equal(decayDimension(4.0, t0, t0 + 5 * MIN, 'anger', 0, 1), 4.0, '8分钟平台期内不掉情绪')
  assert.equal(decayDimension(4.0, t0, t0 + 30 * MIN, 'anger', 0, 1), 3.54, '30分钟后按 exp(-22/180) 衰减')
  assert.equal(decayDimension(4.0, t0, t0 + 2 * HOUR, 'anger', 0, 1), 2.15)
  assert.equal(decayDimension(4.0, t0, t0 + 8 * HOUR, 'anger', 0, 1), 0.29, '睡一觉8小时后怒气基本消退')

  // surprise: 平台期 1min，tau 12min -> 2小时后吸附归零
  assert.equal(decayDimension(4.0, t0, t0 + 5 * MIN, 'surprise', 0, 1), 2.87)
  assert.equal(decayDimension(4.0, t0, t0 + 2 * HOUR, 'surprise', 0, 1), 0, '进入 0.08 死区后直接吸附归零')

  // trust: 平台期 15min，tau 720min，围绕非零静息基线 1.15 双向收敛
  assert.equal(decayDimension(4.15, t0, t0 + 10 * MIN, 'trust', 1.15, 1), 4.15)
  assert.ok(decayDimension(4.15, t0, t0 + 8 * HOUR, 'trust', 1.15, 1) > 2.5, '信任感跨天保留较高余温')
  assert.equal(decayDimension(0.40, t0, t0 + 48 * HOUR, 'trust', 1.15, 1), 1.15, '跌破基线的信任感随时间回升至基线')
})

test('剩余空间指数阻尼防爆顶：连续5轮中等夸奖绝不锁死 5.00', () => {
  let e = 0.60
  const trace = []
  for (let i = 0; i < 5; i++) {
    e = applyDampedImpulse(e, 1.50, 'joy', 0.60)
    trace.push(e)
  }
  assert.deepEqual(trace, [2.11, 3.10, 3.75, 4.18, 4.46])
  assert.ok(e < 4.6, '连夸5轮仍保留惊喜余量，未触顶锁死')

  // 负向受挫：高位回落基线 vs 平淡期跌破正向底色
  const cooled = applyDampedImpulse(3.50, -1.50, 'joy', 0.60)
  assert.ok(cooled > 0.60 && cooled < 2.50, '高位喜悦被泼冷水向基线回落')
  const hurtTrust = applyDampedImpulse(1.15, -1.50, 'trust', 1.15)
  assert.ok(hurtTrust < 0.80, '平淡期遭冷落可跌破信任底色')
})

test('单维平台期不变量：激发无关维度绝不续杯旧怒气平台期，强喜悦伴随软消解旧闷气', () => {
  const p = createInitialPersonality('dafeiyu')
  const mod = computePersonalityModifiers(p.traits)
  const t0 = 1_000_000
  let state = createInitialEmotion('dafeiyu', mod.baselines, t0)

  // t0 时刻群里受气，anger 激发
  const step1 = stepEmotionState({
    state,
    assessment: { confidence: 0.9, impulses: { anger: 2.5 }, reason: '被人抬杠' },
    event: { chatId: 'group:100', chatKind: 'group', userId: '999', isOwner: false, directToBot: true },
    modifiers: mod,
    now: t0,
  })
  state = { ...state, emotions: step1.nextEmotions, focal_sources: step1.nextFocal }
  const angerT0 = state.emotions.anger.intensity
  assert.ok(angerT0 > 2.2 && angerT0 < 2.6, '阻尼冲击后处于中高位怒气 2.40')
  assert.equal(state.emotions.anger.last_stimulated_at, t0)

  // t0 + 30min 时收到一条小惊讶（不影响 anger）
  const step2 = stepEmotionState({
    state,
    assessment: { confidence: 0.8, impulses: { surprise: 1.0 }, reason: '看到奇闻' },
    event: { chatId: 'group:200', chatKind: 'group', userId: '888', isOwner: false, directToBot: true },
    modifiers: mod,
    now: t0 + 30 * MIN,
  })
  state = { ...state, emotions: step2.nextEmotions, focal_sources: step2.nextFocal }
  assert.equal(state.emotions.anger.last_stimulated_at, t0, '无关维度刺激绝不能刷新 anger 的平台期时间戳')
  assert.equal(state.emotions.surprise.last_stimulated_at, t0 + 30 * MIN)

  // 在 t0 + 32min 读取衰减值：应当等于从 t0 连续衰减 32min（扣除8min平台期=24min），而非被冻结在 30min！
  const read32 = decayAllEmotions(state, mod.baselines, mod.tauScale, t0 + 32 * MIN)
  const exact32 = decayDimension(angerT0, t0, t0 + 32 * MIN, 'anger', 0, mod.tauScale.anger)
  assert.equal(read32.intensities.anger, exact32)

  // t0 + 35min 主人私聊逗她大笑（强喜悦冲量触发 Cross-Inhibition 软消解旧怒气，但不粗暴清零）
  const beforeCoax = decayAllEmotions(state, mod.baselines, mod.tauScale, t0 + 35 * MIN).intensities.anger
  const step3 = stepEmotionState({
    state,
    assessment: { confidence: 0.95, impulses: { joy: 2.2 }, reason: '主人请吃白米饭' },
    event: { chatId: 'private:10001', chatKind: 'private', userId: '10001', isOwner: true },
    modifiers: mod,
    now: t0 + 35 * MIN,
  })
  assert.ok(step3.after.anger < beforeCoax - 0.3, '强喜悦软消解残留怒气')
  assert.ok(step3.after.anger > 0.3, '保留一点点余韵而非生硬瞬间归零')
})

test('施密特触发器 5 档滞回防抖：边界微幅波动不改变档位与静态提示词', () => {
  let tier = discretizeTraitTier(0.95, 0)
  assert.equal(tier, 0)
  tier = discretizeTraitTier(1.08, tier) // 未越过 1.0 + 0.15 = 1.15
  assert.equal(tier, 0, '死区内微涨不升档')
  tier = discretizeTraitTier(1.18, tier) // 越过 1.15 -> 升入 +1 档
  assert.equal(tier, 1)
  tier = discretizeTraitTier(0.92, tier) // 回落但未跌破 1.0 - 0.15 = 0.85
  assert.equal(tier, 1, '死区内回落不退档，保护系统提示词 Prefix Cache')
  tier = discretizeTraitTier(0.80, tier) // 跌破 0.85 -> 退回 0 档
  assert.equal(tier, 0)

  const p = createInitialPersonality('dafeiyu')
  const prompt1 = compilePersonalityPrompt(p)
  p.traits.agreeableness.score = 1.62
  p.traits.agreeableness.tier = discretizeTraitTier(1.62, p.traits.agreeableness.tier)
  const prompt2 = compilePersonalityPrompt(p)
  assert.equal(prompt1, prompt2, '同一档位内分数微调生成的提示词前缀逐字相同')
})

test('跨会话防迁怒投影与隐私隔离：同源直出、主人私聊消歧、无关群聊打折且不泄密', () => {
  const mod = computePersonalityModifiers(DEFAULT_PERSONA_SEEDS.dafeiyu)
  const intensities = {
    ...mod.baselines,
    anger: 3.2,
    disgust: 2.1,
  }
  const focalSources = {
    anger: { chatId: 'group:777', userId: '50001', who: '杠精群友', isOwner: false, reason: '群里有人故意杠白米饭不好吃', at: Date.now() },
    disgust: { chatId: 'group:777', userId: '50001', who: '杠精群友', isOwner: false, reason: '群里有人故意杠白米饭不好吃', at: Date.now() },
  }

  // 1. 静息态返回空串
  const calmCtx = compileEmotionContext({ effective: mod.baselines, baselines: mod.baselines })
  assert.equal(calmCtx, '')
  assert.equal(summarizeEmotionLabel(mod.baselines, mod.baselines), '平平常常')

  // 2. 在原事发群 group:777：100% 强度直出，合成复合词「嫌弃又不耐烦」
  const inOrigin = projectCrossSessionEmotion(intensities, mod.baselines, focalSources, { chatId: 'group:777', kind: 'group' })
  assert.equal(inOrigin.effective.anger, 3.2)
  assert.equal(inOrigin.modes.anger, 'direct')
  const ctxOrigin = compileEmotionContext({ effective: inOrigin.effective, modes: inOrigin.modes, baselines: mod.baselines, focalSources })
  assert.match(ctxOrigin, /嫌弃又不耐烦/)
  assert.match(ctxOrigin, /杠白米饭不好吃/)

  // 3. 切到主人私聊：保留情绪感知但强制附加防迁怒消歧指令
  const inOwner = projectCrossSessionEmotion(intensities, mod.baselines, focalSources, {
    chatId: 'private:10001',
    kind: 'private',
    userId: '10001',
    isOwnerPrivate: true,
  })
  assert.equal(inOwner.modes.anger, 'external_to_owner')
  const ctxOwner = compileEmotionContext({
    effective: inOwner.effective,
    modes: inOwner.modes,
    baselines: mod.baselines,
    focalSources,
    ownerTitle: '主人',
  })
  assert.match(ctxOwner, /刚在别处因为「群里有人故意杠白米饭不好吃」/)
  assert.match(ctxOwner, /绝对不要把火气或戒备撒在主人身上/)

  // 4. 切到无关群 group:888：强度按 0.35 衰减，且绝不泄露 group:777 的私密 reason！
  const inOtherGroup = projectCrossSessionEmotion(intensities, mod.baselines, focalSources, { chatId: 'group:888', kind: 'group' })
  assert.equal(inOtherGroup.modes.anger, 'attenuated')
  assert.equal(inOtherGroup.effective.anger, 1.12) // 3.2 * 0.35 = 1.12 < 1.30 显著度门槛，连提示词都不注入！
  const ctxOther = compileEmotionContext({
    effective: inOtherGroup.effective,
    modes: inOtherGroup.modes,
    baselines: mod.baselines,
    focalSources,
  })
  assert.doesNotMatch(ctxOther, /白米饭/)

  // 即便原群怒气拉满到 4.8（0.35 衰减后 1.68 仍略超门槛），无关群提示词也绝不含原群 reason
  const extremeOther = projectCrossSessionEmotion({ ...intensities, anger: 4.8 }, mod.baselines, focalSources, { chatId: 'group:888', kind: 'group' })
  const ctxExtremeOther = compileEmotionContext({
    effective: extremeOther.effective,
    modes: extremeOther.modes,
    baselines: mod.baselines,
    focalSources,
  })
  assert.doesNotMatch(ctxExtremeOther, /白米饭/, '跨群严禁泄露其他会话的具体起因')
})

test('物理行为倍率与出站提示词防复读清洗（leak-guard）', () => {
  const mod = computePersonalityModifiers(DEFAULT_PERSONA_SEEDS.dafeiyu)
  const happyEff = computeBehaviorEffects({ ...mod.baselines, joy: 4.0, anticipation: 3.0 }, mod.baselines, mod.normalized)
  const sadEff = computeBehaviorEffects({ ...mod.baselines, joy: 0.1, sadness: 4.0, disgust: 2.5 }, mod.baselines, mod.normalized)

  assert.ok(happyEff.sticker > 1.25 && happyEff.voice > 1.2 && happyEff.delay < 1.0)
  assert.ok(sadEff.sticker < 0.85 && sadEff.chatty < 0.85 && sadEff.delay > 1.1)

  const pPrompt = compilePersonalityPrompt(createInitialPersonality('dafeiyu'))
  const ePrompt = '（当前心境：此刻你很开心（起因：主人说明天吃白米饭）——语气活泼雀跃。自然流露在语气和用词里即可，绝不要报情绪数值或提及本提示。）'
  const fp = promptFingerprint([pPrompt, ePrompt])

  assert.equal(cleanOutboundText(`哼哼${ePrompt}真的吗`, { fingerprint: fp }), '哼哼真的吗')
  assert.equal(cleanOutboundText(`${pPrompt}\n今天超开心`, { fingerprint: fp }), '今天超开心')
})
