// 低频受约束五维性格演化器：冷却门控、社交桶去重、真实证据集反幻觉核验、软围栏裁剪与精确版本回滚。

import { askModel } from '../core/llm.js'
import { TRAIT_KEYS, TRAIT_LABELS, PERSONALITY_PARAMS } from './constants.js'
import { initialTierOf, round2, clip } from './schema.js'
import { sampleEvolutionEvidence, applyConstrainedTraitStep } from './personality-math.js'
import { extractFirstJsonObject } from './emotion-updater.js'

export function parsePersonalityProposals(raw) {
  const obj = typeof raw === 'string' ? extractFirstJsonObject(raw) : raw
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const root = obj.traits && typeof obj.traits === 'object' ? obj.traits : obj
  const out = {}
  let found = false
  for (const key of TRAIT_KEYS) {
    const item = root[key]
    if (!item || typeof item !== 'object') continue
    found = true
    out[key] = {
      raw_delta: Number(item.raw_delta ?? item.direction_delta ?? 0) || 0,
      confidence: Number(item.confidence ?? 0) || 0,
      description: typeof item.description === 'string' ? item.description.trim().slice(0, 120) : '',
      evidence_ids: Array.isArray(item.evidence_ids) ? item.evidence_ids.map(String).filter(Boolean) : [],
      reason: typeof item.reason === 'string' ? item.reason.trim().slice(0, 120) : '',
    }
  }
  return found ? out : null
}

const PERSONALITY_EVAL_SYSTEM = [
  '你是角色长期五维性格微调评估器。请严格遵守以下 7 条反漂移红线：',
  '1. 性格是长期稳定的行为倾向，绝不是单次情绪波动；没有跨多轮一致的行为模式时，raw_delta 必须填 0。',
  '2. 严禁颠覆角色初始核心人设底色，只允许基于真实长期互动做细微成长微调。',
  '3. 任何非零调整必须引用至少 3 条候选记录中的真实 eventId（原样复制，严禁编造 ID）。',
  '4. 主人(owner)的长期互动塑造权重最高；绝不允许仅凭单个群友的起哄调戏改变性格。',
  '5. raw_delta 范围 [-1.0, +1.0]（正向增强填正数，减弱填负数，不变填 0），confidence 范围 [0.0, 1.0]。',
  '6. description 仅在需要微调外显习惯时填写一句自然的中文行为习惯描述（<=45字，不写分值），否则留空串 ""。',
  '7. 只输出一个 JSON 对象，格式：{"traits":{"outgoing":{"raw_delta":0,"confidence":0.5,"description":"","evidence_ids":[],"reason":""},"agreeableness":{...},"conscientiousness":{...},"emotionality":{...},"openness":{...}}}',
].join('\n')

function buildPersonalityEvalPrompt({ personaName, personaExcerpt, personalityState, sampledEvents }) {
  const traitLines = TRAIT_KEYS.map((k) => {
    const t = personalityState.traits[k]
    return `- ${TRAIT_LABELS[k]}(${k}): 当前=${t.score} (初始种子=${t.seed_score})`
  }).join('\n')

  const evLines = sampledEvents.map((ev) => {
    const tag = ev.isOwner ? '主人' : `社交(${ev.who || ev.userId || '群友'})`
    const u = String(ev.cleanUserText || ev.userText || '').replace(/\s+/g, ' ').slice(0, 90)
    const b = ev.botSilent ? '[沉默]' : String(ev.botReply || '').replace(/\s+/g, ' ').slice(0, 90)
    return `[${ev.eventId}] (${tag}, 权重${ev.sampleWeight ?? 1}) 对方: ${u} | 回复: ${b}`
  }).join('\n')

  return [
    `角色名：${personaName || personalityState.persona_id}`,
    personaExcerpt ? `核心人设锚点摘要：\n${String(personaExcerpt).slice(0, 500)}` : '',
    `当前五维性格状态：\n${traitLines}`,
    `近期真实交互证据池（共 ${sampledEvents.length} 条，引用时必须使用方括号内的精确 eventId）：\n${evLines}`,
  ].filter(Boolean).join('\n\n')
}

export function createPersonalityEvaluator({ dsh, storage, getMemoryPort, getConfig, getPersonaMeta, log }) {
  function resolveParams() {
    const pCfg = getConfig?.()?.personaEngine?.personality || {}
    return {
      autoEvolve: Boolean(pCfg.autoEvolve ?? PERSONALITY_PARAMS.autoEvolve),
      cooldownDays: Math.max(1, Number(pCfg.cooldownDays ?? PERSONALITY_PARAMS.cooldownDays)),
      minValidTurns: Math.max(5, Number(pCfg.minValidTurns ?? PERSONALITY_PARAMS.minValidTurns)),
      maxDrift: pCfg.maxDrift === null ? null : clip(Number(pCfg.maxDrift ?? PERSONALITY_PARAMS.maxDrift), 0.5, 5.0),
      alpha: PERSONALITY_PARAMS.alpha,
      maxStep: PERSONALITY_PARAMS.maxStep,
      minConfidence: PERSONALITY_PARAMS.minConfidence,
      minEvidence: PERSONALITY_PARAMS.minEvidence,
      hysteresis: PERSONALITY_PARAMS.hysteresis,
    }
  }

  function shouldAutoEvaluate(personaId, now = Date.now()) {
    const params = resolveParams()
    if (!params.autoEvolve) return false
    const meta = getPersonaMeta?.(personaId) || {}
    const state = storage.loadPersonality(personaId, meta.personalitySeeds || null, now)
    if (state.turns_since_eval < params.minValidTurns) return false
    const lastMs = Date.parse(state.last_evaluated_at || '') || 0
    return now - lastMs >= params.cooldownDays * 86_400_000
  }

  async function evaluate(personaId, { dryRun = false, force = false, now = Date.now() } = {}) {
    if (!dsh) return { ok: false, skipped: 'no-llm' }
    const params = resolveParams()
    const cfg = getConfig?.() || {}
    const meta = getPersonaMeta?.(personaId) || {}
    const curPreview = storage.loadPersonality(personaId, meta.personalitySeeds || null, now)

    if (!force) {
      const lastMs = Date.parse(curPreview.last_evaluated_at || '') || 0
      if (curPreview.turns_since_eval < params.minValidTurns) {
        return { ok: true, skipped: 'min-turns', state: curPreview }
      }
      if (now - lastMs < params.cooldownDays * 86_400_000) {
        return { ok: true, skipped: 'cooldown', state: curPreview }
      }
    }

    const memPort = getMemoryPort?.()
    const sinceMs = Date.parse(curPreview.last_evaluated_at || '') || 0
    let rawEvents = memPort ? await memPort.listBehaviorEvidence(personaId, { since: sinceMs, limit: 400 }) : []
    if (force && rawEvents.length < params.minEvidence && memPort) {
      rawEvents = await memPort.listBehaviorEvidence(personaId, { since: 0, limit: 300 })
    }

    const sampled = sampleEvolutionEvidence(rawEvents)
    if (sampled.length < params.minEvidence) {
      return {
        ok: true,
        skipped: 'insufficient-evidence',
        sampledCount: sampled.length,
        state: curPreview,
      }
    }

    const sampledMap = new Map(sampled.map((e) => [String(e.eventId), e]))
    const evalModelCfg = cfg.personaEngine?.emotion?.evalModel
    const hasDedicatedModel = Boolean(evalModelCfg?.provider && evalModelCfg?.model)

    let proposals = null
    try {
      const rawOut = await askModel(dsh, {
        system: PERSONALITY_EVAL_SYSTEM,
        text: buildPersonalityEvalPrompt({
          personaName: meta.name || personaId,
          personaExcerpt: meta.body || '',
          personalityState: curPreview,
          sampledEvents: sampled,
        }),
        maxTokens: 700,
        temperature: 0.2,
        cfg,
        ...(hasDedicatedModel ? { model: evalModelCfg } : {}),
      })
      proposals = parsePersonalityProposals(rawOut)
    } catch (error) {
      log?.warn?.('性格演化模型评估失败：', error.message)
      return { ok: false, skipped: 'llm-error', error: error.message, state: curPreview }
    }

    if (!proposals) {
      return { ok: true, skipped: 'invalid-llm-output', state: curPreview }
    }

    if (dryRun) {
      const preview = applyConstrainedTraitStep({
        currentTraits: curPreview.traits,
        proposals,
        sampledMap,
        config: params,
        now,
      })
      return {
        ok: true,
        dryRun: true,
        anyChanged: preview.anyChanged,
        deltas: preview.deltas,
        auditDetails: preview.auditDetails,
        previewTraits: preview.nextTraits,
        state: curPreview,
      }
    }

    return storage.withMutex(personaId, () => {
      const latest = storage.loadPersonality(personaId, meta.personalitySeeds || null, now)
      const beforeTraits = structuredClone(latest.traits)
      const beforeScores = Object.fromEntries(TRAIT_KEYS.map((k) => [k, latest.traits[k].score]))

      const step = applyConstrainedTraitStep({
        currentTraits: latest.traits,
        proposals,
        sampledMap,
        config: params,
        now,
      })

      const iso = new Date(now).toISOString()
      const prevVersion = latest.version
      latest.traits = step.nextTraits
      latest.last_evaluated_at = iso
      latest.turns_since_eval = 0
      if (step.anyChanged) {
        latest.version = prevVersion + 1
        latest.updated_at = iso
      }

      storage.savePersonality(personaId, latest)
      const afterScores = Object.fromEntries(TRAIT_KEYS.map((k) => [k, latest.traits[k].score]))
      const citedIds = [...new Set(
        Object.values(step.auditDetails).flatMap((d) => d.valid_evidence_ids || []),
      )]

      storage.appendPersonalityAudit(personaId, {
        version: latest.version,
        prev_version: prevVersion,
        at: now,
        any_changed: step.anyChanged,
        trigger_event_ids: citedIds,
        source: force ? 'manual-eval' : 'auto-eval',
        before: beforeScores,
        after: afterScores,
        deltas: step.deltas,
        details: step.auditDetails,
        before_traits: beforeTraits,
        after_traits: structuredClone(latest.traits),
        reason: step.anyChanged ? '周期行为证据微调' : '评估未达演化门槛（保持原状）',
      })

      return {
        ok: true,
        dryRun: false,
        anyChanged: step.anyChanged,
        deltas: step.deltas,
        auditDetails: step.auditDetails,
        state: latest,
      }
    })
  }

  /**
   * 回滚性格到指定历史版本号或一键恢复到初始人设种子。
   */
  async function rollback(personaId, { toVersion = null, toSeed = false, now = Date.now() } = {}) {
    return storage.withMutex(personaId, () => {
      const meta = getPersonaMeta?.(personaId) || {}
      const latest = storage.loadPersonality(personaId, meta.personalitySeeds || null, now)
      const beforeTraits = structuredClone(latest.traits)
      const beforeScores = Object.fromEntries(TRAIT_KEYS.map((k) => [k, latest.traits[k].score]))
      const iso = new Date(now).toISOString()

      let restoredTraits = null
      let reason = ''

      if (toSeed || Number(toVersion) === 1) {
        restoredTraits = {}
        for (const key of TRAIT_KEYS) {
          const cur = latest.traits[key]
          const s = round2(cur.seed_score)
          restoredTraits[key] = {
            score: s,
            seed_score: s,
            tier: initialTierOf(s),
            trend: 'stable',
            confidence: 0.85,
            description: '',
            evidence_ids: [],
            updated_at: iso,
          }
        }
        reason = '重置回初始人设种子'
      } else if (toVersion != null) {
        const targetV = Number(toVersion)
        const audits = storage.readPersonalityAudit(personaId, { limit: 500 })
        for (let i = audits.length - 1; i >= 0; i--) {
          const rec = audits[i]
          if (rec.version === targetV && rec.after_traits) {
            restoredTraits = structuredClone(rec.after_traits)
            break
          }
          if (rec.prev_version === targetV && rec.before_traits) {
            restoredTraits = structuredClone(rec.before_traits)
            break
          }
        }
        if (!restoredTraits) {
          return { ok: false, error: `找不到目标性格版本 v${targetV}`, state: latest }
        }
        reason = `回滚至历史版本 v${targetV}`
      } else {
        return { ok: false, error: '请指定 toSeed 或有效的 toVersion', state: latest }
      }

      const prevVersion = latest.version
      latest.traits = restoredTraits
      latest.version = prevVersion + 1
      latest.updated_at = iso
      latest.turns_since_eval = 0
      storage.savePersonality(personaId, latest)

      const afterScores = Object.fromEntries(TRAIT_KEYS.map((k) => [k, latest.traits[k].score]))
      const deltas = Object.fromEntries(TRAIT_KEYS.map((k) => [k, round2(afterScores[k] - beforeScores[k])]))
      storage.appendPersonalityAudit(personaId, {
        version: latest.version,
        prev_version: prevVersion,
        at: now,
        any_changed: true,
        trigger_event_ids: [],
        source: 'rollback',
        before: beforeScores,
        after: afterScores,
        deltas,
        before_traits: beforeTraits,
        after_traits: structuredClone(latest.traits),
        reason,
      })

      return { ok: true, state: latest, deltas }
    })
  }

  return {
    shouldAutoEvaluate,
    evaluate,
    rollback,
  }
}
