// 稀疏情绪读出与提示词编译器：将八维有效情绪与触发源归属编译为尾部（当前心境…）短提示与面板标签。
// 遵循 Prefix Cache 动静分离契约：平静期返回空串 ""，跨会话严格防迁怒且绝不向无关会话泄露私密原因。

import {
  EMOTION_DIMS,
  EMOTION_LABELS,
  POSITIVE_DIMS,
  EMOTION_PARAMS,
  SINGLE_EMOTION_GUIDES,
  lookupDyadLabel,
} from './constants.js'
import { round2 } from './schema.js'

/**
 * 提取按显著度排序的 Top-2 激活情绪维度（见 .agent/algorithm.md §5.3）。
 */
export function selectSalientEmotions(effective = {}, baselines = {}) {
  const candidates = []
  for (const dim of EMOTION_DIMS) {
    const val = Number(effective[dim] ?? 0)
    const base = Number(baselines[dim] ?? 0)
    const dev = val - base
    const aboveActive = dev >= EMOTION_PARAMS.salienceDelta && val >= EMOTION_PARAMS.salienceMin
    const dropActive = POSITIVE_DIMS.has(dim) && dev <= -EMOTION_PARAMS.salienceDelta
    if (aboveActive || dropActive) {
      candidates.push({
        dim,
        val: round2(val),
        base: round2(base),
        dev: round2(dev),
        direction: dropActive ? 'drop' : 'high',
        absDev: Math.abs(dev),
      })
    }
  }
  candidates.sort((a, b) => (b.absDev - a.absDev) || (b.val - a.val))
  return candidates.slice(0, 2)
}

function describeSingleSalient(item) {
  const guide = SINGLE_EMOTION_GUIDES[item.dim]
  if (!guide) return { word: EMOTION_LABELS[item.dim] || item.dim, hint: '' }
  if (item.direction === 'drop' && guide.drop) return guide.drop
  return item.val >= 2.8 ? guide.strong : guide.mild
}

/**
 * 生成自然中文复合情绪短标签（用于 `/mood` 命令与旧面板兼容展示）。
 */
export function summarizeEmotionLabel(effective = {}, baselines = {}) {
  const top = selectSalientEmotions(effective, baselines)
  if (!top.length) return '平平常常'

  if (top.length >= 2 && top[0].direction === 'high' && top[1].direction === 'high') {
    const dyad = top[0].val >= 1.8 && top[1].val >= 1.6
      ? lookupDyadLabel(top[0].dim, top[1].dim)
      : ''
    if (dyad) return dyad
    const w1 = describeSingleSalient(top[0]).word
    const w2 = describeSingleSalient(top[1]).word
    return `${w1}、${w2}`
  }
  return describeSingleSalient(top[0]).word
}

/**
 * 为目标会话编译尾部动态心境上下文（注入 systemPrompt.context，绝不碰前缀缓存）。
 * @param {object} params
 * @param {object} params.effective 跨会话投影后的外显八维情绪强度
 * @param {object} params.modes 各维度投影模式 ('direct' | 'external_to_owner' | 'attenuated')
 * @param {object} params.baselines 八维静息基线
 * @param {object} params.focalSources 活跃触发源
 * @param {string} [params.ownerTitle] 对主人的称呼（默认“主人”）
 */
export function compileEmotionContext({
  effective = {},
  modes = {},
  baselines = {},
  focalSources = {},
  ownerTitle = '主人',
} = {}) {
  const top = selectSalientEmotions(effective, baselines)
  if (!top.length) return ''

  const primary = top[0]
  const secondary = top[1] || null
  const primaryGuide = describeSingleSalient(primary)

  let moodPhrase = primaryGuide.word
  let hintPhrase = primaryGuide.hint

  if (secondary) {
    const dyad = primary.direction === 'high' && secondary.direction === 'high' && primary.val >= 1.8 && secondary.val >= 1.6
      ? lookupDyadLabel(primary.dim, secondary.dim)
      : ''
    const secGuide = describeSingleSalient(secondary)
    if (dyad) {
      moodPhrase = dyad
    } else {
      moodPhrase = `${primaryGuide.word}，同时${secGuide.word}`
    }
    if (secGuide.hint && secGuide.hint !== hintPhrase && primary.val < 3.4) {
      hintPhrase = `${primaryGuide.hint}；另外${secGuide.hint}`
    }
  }

  // 检查主导情绪是否属于「外源情绪带入主人私聊」——必须显式消歧防止冲主人无端发火
  const externalItems = top.filter((it) => modes[it.dim] === 'external_to_owner' && focalSources[it.dim])
  if (externalItems.length > 0) {
    const ext = externalItems[0]
    const src = focalSources[ext.dim]
    const reasonBit = src?.reason ? `因为「${src.reason}」` : '因为别处的事'
    const safeTitle = String(ownerTitle || '主人').slice(0, 16)
    return `（当前心境：你刚在别处${reasonBit}${moodPhrase}，不过现在是信任的${safeTitle}在和你私聊——可以自然流露情绪或顺口跟${safeTitle}吐槽撒娇，绝对不要把火气或戒备撒在${safeTitle}身上。）`
  }

  // 同一会话直接触发时，可带上简短自身归因（跨会话 attenuated 模式绝不拼接 reason，严防跨群隐私泄露）
  let causeBit = ''
  if (modes[primary.dim] === 'direct' && focalSources[primary.dim]?.reason) {
    causeBit = `（起因：${focalSources[primary.dim].reason}）`
  }

  return `（当前心境：此刻你${moodPhrase}${causeBit}——${hintPhrase}。自然流露在语气和用词里即可，绝不要报情绪数值或提及本提示。）`
}
