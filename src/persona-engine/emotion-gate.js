// 毫秒级本地情绪信号门控与启发式降级评估器（用于过滤群聊水消息、支撑峰时省钱模式）。
// 算法基准见 .agent/algorithm.md §7。

import { EMOTION_DIMS } from './constants.js'
import { clip, round2 } from './schema.js'

const POSITIVE_RE = /喜欢|爱你|最棒|真棒|厉害|夸夸|抱抱|摸摸|贴贴|可爱|真好|谢谢|太好了|开心|哈哈+|嘿嘿+|期待|请客|好吃|奖励|想你|乖/
const APOLOGY_SOOTHE_RE = /对不起|抱歉|别生气|哄你|哄哄|不气了|我的错|委屈你|心疼|没事了|乖乖|安慰/
const ANGER_OFFENSE_RE = /闭嘴|滚|傻逼|笨蛋|废物|垃圾|烦死|有病|弱智|讨厌你|吵死|莫名其妙|神经病|爬/
const SAD_NEGLECT_RE = /算了|不想理你|走开|别烦我|没意思|难过|伤心|委屈|哭了|失望|冷淡|无聊透顶/
const FEAR_WORRY_RE = /害怕|担心|救命|怎么办|完蛋|出事|糟糕|焦虑|慌了|吓死|生病|发烧/
const SURPRISE_RE = /卧槽|天哪|真的假的|居然|竟然|不会吧|震惊|吓一跳|离谱/
const DISGUST_RE = /恶心|嫌弃|无语|下头|油腻|呕|yue|烦人/

const AFFECT_LEXICON_RE = new RegExp(
  [
    POSITIVE_RE.source,
    APOLOGY_SOOTHE_RE.source,
    ANGER_OFFENSE_RE.source,
    SAD_NEGLECT_RE.source,
    FEAR_WORRY_RE.source,
    SURPRISE_RE.source,
    DISGUST_RE.source,
  ].join('|'),
  'i',
)

/**
 * 去掉群聊消息前缀 `[昵称(QQ号)]` 等装饰，提取用于门控统计的纯文本。
 */
export function cleanMessageText(text = '') {
  return String(text || '')
    .replace(/^\[[^\]\n]{1,40}\]\s*/gm, '')
    .replace(/\[图片:[^\]]*\]/g, '')
    .trim()
}

/**
 * 判断本轮交互是否值得调用 LLM 做细粒度归因情绪评估。
 */
export function shouldInvokeLLM(event = {}, decayedEmotions = {}, baselines = {}) {
  // 1. 主人私聊或主动搭话回合：100% 走 LLM 精细评估
  if ((event.isOwner && event.chatKind === 'private') || event.origin === 'proactive') {
    return true
  }

  // 2. 当前处于显著非静息情绪期（存在维度偏离基线 >= 0.80）：需判断对方是在哄她还是火上浇油
  for (const dim of EMOTION_DIMS) {
    const cur = Number(decayedEmotions[dim] ?? 0)
    const base = Number(baselines[dim] ?? 0)
    if (Math.abs(cur - base) >= 0.80) return true
  }

  // 3. 角色主动选择 [沉默] 拒答（通常遇到冒犯、刷屏或不想搭理的场景）
  if (event.botSilent) return true

  const combined = `${event.cleanUserText || event.userText || ''}\n${event.botReply || ''}`
  // 4. 命中情感/冲突/安抚词表或连续情绪标点
  if (AFFECT_LEXICON_RE.test(combined)) return true
  if (/[!！?？~～]{2,}/.test(combined)) return true

  // 5. 较长实质性交流（纯用户文本 >= 18 字）
  const cleanUser = event.cleanUserText ?? cleanMessageText(event.userText)
  if (cleanUser.length >= 18) return true

  return false
}

/**
 * 本地增强启发式情绪评估（仅用于峰时 offPeak 降级或显式关闭 LLM 情绪评估时）。
 * 置信度封顶 0.65，保持温和保守。
 */
export function heuristicAssess(event = {}, decayedEmotions = {}, baselines = {}) {
  const userText = String(event.cleanUserText || cleanMessageText(event.userText) || '')
  const botText = String(event.botReply || '')
  const impulses = {}
  const reasons = []

  if (ANGER_OFFENSE_RE.test(userText)) {
    impulses.anger = 1.1
    impulses.disgust = 0.8
    impulses.joy = -0.6
    reasons.push('对方言语冒犯不客气')
  }
  if (DISGUST_RE.test(userText) && !impulses.disgust) {
    impulses.disgust = 0.7
    reasons.push('气氛有些让人嫌弃无语')
  }
  if (SAD_NEGLECT_RE.test(userText)) {
    impulses.sadness = 0.9
    impulses.joy = -0.5
    reasons.push('被冷淡对待或聊到伤心事')
  }
  if (FEAR_WORRY_RE.test(userText)) {
    impulses.fear = 0.8
    reasons.push('听到让人担心的消息')
  }
  if (SURPRISE_RE.test(userText) || SURPRISE_RE.test(botText)) {
    impulses.surprise = 0.9
    reasons.push('遇到出乎意料的事')
  }
  if (APOLOGY_SOOTHE_RE.test(userText)) {
    if ((decayedEmotions.anger || 0) > (baselines.anger || 0) + 0.3) impulses.anger = -1.2
    if ((decayedEmotions.sadness || 0) > (baselines.sadness || 0) + 0.3) impulses.sadness = -1.0
    impulses.trust = 0.6
    impulses.joy = (impulses.joy || 0) + 0.6
    reasons.push('被温柔道歉安抚')
  }
  if (POSITIVE_RE.test(userText)) {
    impulses.joy = clip((impulses.joy || 0) + 0.9, -3, 3)
    impulses.trust = clip((impulses.trust || 0) + (event.isOwner ? 0.6 : 0.3), -3, 3)
    if (/期待|请客|明天|下次|带你/.test(userText)) impulses.anticipation = 0.8
    reasons.push('收到夸奖或友好互动')
  }
  if (event.botSilent && Object.keys(impulses).length === 0) {
    impulses.disgust = 0.4
    reasons.push('不想搭理当下的话题')
  }

  const keys = Object.keys(impulses)
  if (!keys.length) return null

  for (const k of keys) impulses[k] = round2(impulses[k])
  return {
    speaker_affect: '本地启发式信号识别',
    self_appraisal: reasons.join('；'),
    confidence: 0.62,
    impulses,
    reason: reasons[0] || '对话情绪波动',
    via: 'heuristic',
  }
}
