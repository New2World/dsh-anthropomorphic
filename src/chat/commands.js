// QQ 里的主人命令：/silent /active 之类，直接在 QQ 上管她。只认主人；在总开关关着时也能用（所以 /on 才有用）。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { TRAIT_KEYS, TRAIT_LABELS, EMOTION_DIMS, EMOTION_LABELS } from '../persona-engine/constants.js'

/**
 * 解析命令：「/silent 30」→ { name: 'silent', arg: '30' }。不是命令返回 null。支持全角斜杠和中文别名。
 * extra：扩展模块加的命令 [{ name, aliases, desc, run }]，命中时返回 { name, arg, ext }；和内置同名时扩展的优先。
 */
export function parseCommand(text, extra = []) {
  const m = String(text || '').trim().match(/^[/／]\s*([A-Za-z0-9一-龥_-]+)\s*([\s\S]*)$/)
  if (!m) return null
  const word = m[1].toLowerCase()
  for (const c of extra) {
    const names = [c.name, ...(c.aliases || [])].map((x) => String(x).toLowerCase())
    if (names.includes(word)) return { name: c.name, arg: m[2].trim(), ext: c }
    // 中文命令后面直接跟内容：「/天气北京」
    const pre = names.filter((k) => /[一-龥]/.test(k) && word.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    if (pre) return { name: c.name, arg: (m[1].slice(pre.length) + ' ' + m[2]).trim(), ext: c }
  }
  const name = ALIASES[word] || word
  if (COMMANDS[name]) return { name, arg: m[2].trim() }
  // 中文命令后面不加空格直接跟内容：「/记住我不吃香菜」
  const pre = Object.keys(ALIASES).filter((k) => /[一-龥]/.test(k) && word.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return pre ? { name: ALIASES[pre], arg: (m[1].slice(pre.length) + ' ' + m[2]).trim() } : null
}

const ALIASES = {
  闭嘴: 'silent', 安静: 'silent', 静音: 'silent', shutup: 'silent', mute: 'silent',
  说话: 'active', 醒醒: 'active', 解除静音: 'active', unmute: 'active',
  少说: 'quiet', 话少: 'quiet',
  多说: 'chatty', 话多: 'chatty',
  正常: 'normal',
  模型: 'model', 换模型: 'model',
  唱: 'sing', 点歌: 'sing', 翻唱: 'sing',
  状态: 'status', 心情: 'mood', 性格: 'personality', 日记: 'diary', 记住: 'remember', 记一下: 'remember',
  搭话: 'speak', 主动搭话: 'speak',
  重开: 'reset', 开机: 'on', 关机: 'off', 帮助: 'help', 命令: 'help', h: 'help',
}

const COMMANDS = {
  help: '看这份命令列表',
  silent: '在这里闭嘴（可带分钟数，如 /silent 30；不带就一直到 /active）',
  active: '解除闭嘴；在群里还会接着参与话题一会儿',
  quiet: '这个群里只在被叫到时说话，不插话',
  chatty: '这个群里话多一点，更爱插话',
  normal: '这个群恢复默认的插话频率',
  model: '看或换她用的模型：/model 看列表，/model 2 或 /model 名字 换，/model 默认 跟随 DSH',
  sing: '让她翻唱一首：/sing 小幸运 田馥甄；后面加 +12 / -3 之类可以变调（原唱是男声一般 +12）',
  status: '看她现在的状态',
  mood: '看或平复她现在的心情（/mood reset 平复回日常）',
  personality: '看或管理她的五维性格（/personality eval 评估，/personality reset 恢复初始）',
  diary: '马上写一篇空间日记',
  remember: '让她记住一件事，如 /remember 我不吃香菜',
  speak: '管主动搭话白名单：/speak 看名单，/speak add QQ 号 加人，/speak del QQ 号 移除',
  reset: '这个聊天重新开始（旧的对话在 DSH 侧栏里还能找回）',
  on: '打开总开关',
  off: '关掉总开关（之后除了命令什么都不回）',
}

export const commandList = (extra = []) => [
  ...Object.entries(COMMANDS).map(([name, desc]) => ({ name, desc, aliases: Object.keys(ALIASES).filter((k) => ALIASES[k] === name && /[一-龥]/.test(k)) })),
  ...extra.map((c) => ({ name: c.name, desc: c.desc || '', aliases: c.aliases || [], module: c.module || '' })),
]

export function helpText(extra = []) {
  return '主人命令（也可以用中文，如 /闭嘴 /说话）：\n' + Object.entries(COMMANDS).map(([k, v]) => `/${k}  ${v}`).join('\n')
    + (extra.length ? '\n扩展模块加的：\n' + extra.map((c) => `/${c.name}  ${c.desc || ''}`).join('\n') : '')
}

/** 每个聊天的闭嘴状态：chatId → 到什么时候（毫秒，Infinity 写成 0 表示一直）。 */
export function createMutes() {
  const file = () => dataDir('mutes.json')
  const load = () => readJson(file(), {})
  return {
    muted(chatId, now = Date.now()) {
      const m = load()
      if (!(chatId in m)) return false
      if (m[chatId] === 0 || m[chatId] > now) return true
      delete m[chatId]
      writeJson(file(), m)
      return false
    },
    set(chatId, minutes) {
      const m = load()
      m[chatId] = minutes > 0 ? Date.now() + minutes * 60_000 : 0
      writeJson(file(), m)
    },
    clear(chatId) {
      const m = load()
      delete m[chatId]
      writeJson(file(), m)
    },
    until: (chatId) => load()[chatId],
  }
}

/**
 * 执行命令，返回要回给主人的话。
 * @param {object} deps { getConfig, setConfig, mutes, hub, mood, memory, qzone, onebot }
 */
export async function runCommand(cmd, msg, deps) {
  const { getConfig, setConfig, mutes, hub, mood, memory, qzone } = deps
  const cfg = getConfig()
  const inGroup = msg.kind === 'group'
  const here = inGroup ? '这个群' : '这里'
  const setGroup = (patch) => {
    const overrides = { ...(cfg.group.overrides || {}) }
    if (patch === null) delete overrides[msg.groupId]
    else overrides[msg.groupId] = { ...(overrides[msg.groupId] || {}), ...patch }
    setConfig({ ...cfg, group: { ...cfg.group, overrides } })
  }
  switch (cmd.name) {
    case 'help':
      return helpText(deps.extraCommands || [])
    case 'silent': {
      const min = Math.max(0, Math.min(7 * 24 * 60, Number.parseInt(cmd.arg, 10) || 0))
      mutes.set(msg.chatId, min)
      mood?.nudge?.(-6, '主人让她闭嘴') // 有点委屈
      if (inGroup) hub.leaveTopic?.(msg.groupId)
      return min ? `好，我在${here}安静 ${min} 分钟` : `好，我在${here}先不说话了，想我了发 /active`
    }
    case 'active':
      mutes.clear(msg.chatId)
      mood?.nudge?.(4, '主人让她回来说话')
      if (inGroup) hub.joinTopic?.(msg.groupId)
      return inGroup ? '我回来啦' : '在呢'
    case 'quiet':
      if (!inGroup) return '这个命令要在群里用'
      setGroup({ interjectChance: 0 })
      return '好，这个群里没人叫我我就不插话'
    case 'speak': {
      const c = getConfig()
      const [verb = '', target = ''] = String(cmd.arg || '').split(/\s+/)
      const list = c.speakUp.allow || []
      if (!verb) return list.length ? `主动搭话白名单：${list.join('、')}` : '主动搭话白名单是空的，用 /speak add QQ 号 加人'
      const qq = target.replace(/\D/g, '')
      if (!/^\d{5,}$/.test(qq) || !/^(add|加|添加|del|rm|删|删除|移除)$/.test(verb)) return '用法：/speak add QQ 号，或 /speak del QQ 号'
      if (/^(add|加|添加)$/.test(verb)) {
        if (list.includes(qq)) return `${qq} 已经在白名单里了`
        // 要能聊得上：顺手加进私聊白名单
        setConfig({ ...c, speakUp: { ...c.speakUp, allow: [...list, qq] }, allow: { ...c.allow, private: [...new Set([...c.allow.private, qq])] } })
        return `好，以后也会主动找 ${qq}（对方要是她的好友才发得出去）`
      }
      if (!list.includes(qq)) return `${qq} 不在白名单里`
      setConfig({ ...c, speakUp: { ...c.speakUp, allow: list.filter((x) => x !== qq) } })
      return `好，不再主动找 ${qq} 了`
    }
    case 'chatty':
      if (!inGroup) return '这个命令要在群里用'
      setGroup({ interjectChance: 0.4, minRelevance: 0.1 })
      return '好耶，那我在这个群多说两句'
    case 'normal':
      if (!inGroup) return '这个命令要在群里用'
      setGroup(null)
      return '好，按平常的样子来'
    case 'status': {
      const st = hub.stats()
      const mu = mutes.until(msg.chatId)
      const lines = [
        `总开关：${cfg.enabled ? '开' : '关'}${cfg.dryRun ? '（试运行，不真发）' : ''}`,
        ...(mood ? [`心情：${mood.label()}`] : []),
        `今天：收到 ${st.received} 条，发出 ${st.sent} 条`,
        `${here}：${mu === undefined ? '正常说话' : mu === 0 ? '闭嘴中' : '闭嘴到 ' + new Date(mu).toLocaleTimeString().slice(0, 5)}`,
      ]
      if (inGroup) {
        const o = (cfg.group.overrides || {})[msg.groupId] || {}
        lines.push(`插话：${o.interjectChance === 0 ? '不插话' : o.interjectChance >= 0.4 ? '话多' : '默认'}`)
      }
      return lines.join('\n')
    }
    case 'model': {
      const list = deps.listModels ? await deps.listModels() : []
      const cur = cfg.model.provider && cfg.model.model ? cfg.model : null
      const label = (m) => (m.name && m.name !== m.model ? `${m.name}（${m.model}）` : m.model)
      if (!cmd.arg) {
        const def = deps.defaultModel?.()
        const head = cur ? `现在用的：${cur.model}` : `现在跟随 DSH 默认${def ? '：' + def.model : ''}`
        if (!list.length) return head + '\n（拿不到模型列表）'
        return head + '\n' + list.slice(0, 20).map((m, i) => `${i + 1}. ${label(m)}${cur && m.provider === cur.provider && m.model === cur.model ? '  ← 当前' : ''}`).join('\n') + '\n发 /model 序号 换，/model 默认 跟随 DSH'
      }
      if (/^(默认|default|auto|跟随)$/i.test(cmd.arg)) {
        setConfig({ ...cfg, model: { ...cfg.model, provider: '', model: '' } })
        return '好，换回跟随 DSH 的默认模型，下一句起生效'
      }
      const n = Number.parseInt(cmd.arg, 10)
      const q = cmd.arg.toLowerCase()
      const hit = String(n) === cmd.arg ? list[n - 1]
        : list.find((m) => m.model.toLowerCase() === q || String(m.name).toLowerCase() === q) || list.find((m) => m.model.toLowerCase().includes(q) || String(m.name).toLowerCase().includes(q))
      if (!hit) return `没找到「${cmd.arg}」这个模型，发 /model 看列表`
      setConfig({ ...cfg, model: { ...cfg.model, provider: hit.provider, model: hit.model } })
      return `好，换成 ${label(hit)} 了，下一句起生效`
    }
    case 'sing': {
      if (!deps.song) return '翻唱功能不可用'
      // 末尾的 +12 / -3 是变调
      const m = cmd.arg.match(/^(.*?)\s+([+-]\d{1,2})$/)
      const name = (m ? m[1] : cmd.arg).trim()
      if (!name) return '唱哪首？比如 /sing 小幸运 田馥甄'
      return deps.song.request({ song: name, pitch: m ? Number(m[2]) : undefined, chatId: msg.chatId }).message
    }
    case 'mood': {
      const sub = String(cmd.arg || '').trim().toLowerCase()
      if (/^(reset|平复|重置)$/.test(sub)) {
        if (!deps.personaEngine) return '状态引擎未启用'
        await deps.personaEngine.resetEmotion(undefined, { reason: '主人命令平复情绪' })
        return '好啦，深呼吸一下，心情平复回平常状态了'
      }
      if (!mood) return '心情模块关着'
      if (!deps.personaEngine) return `现在${mood.label()}`
      const st = deps.personaEngine.getState(undefined, { chat: msg })
      const dimParts = EMOTION_DIMS
        .map((d) => ({ d, v: st.emotion.intensities[d] ?? 0, b: st.emotion.baselines[d] ?? 0 }))
        .filter((x) => Math.abs(x.v - x.b) >= 0.25 || x.v >= 0.8)
        .map((x) => `${EMOTION_LABELS[x.d]} ${x.v.toFixed(2)}${x.b > 0 ? `(底色${x.b.toFixed(2)})` : ''}`)
      const srcReasons = Object.values(st.emotion.focal_sources || {}).filter((s) => s?.reason)
      const lines = [
        `现在${st.emotion.label}（v${st.emotion.version}）`,
        dimParts.length ? `活跃维度：${dimParts.join(' · ')}` : '八维状态：处于平静日常底色',
        ...(srcReasons.length ? [`最近缘由：${srcReasons[0].reason}`] : []),
      ]
      return lines.join('\n')
    }
    case 'personality': {
      if (!deps.personaEngine) return '性格引擎未启用'
      const sub = String(cmd.arg || '').trim().toLowerCase()
      if (/^(reset|重置|初始)$/.test(sub)) {
        const r = await deps.personaEngine.rollbackPersonality(undefined, { toSeed: true })
        if (!r.ok) return '重置失败：' + (r.error || '未知原因')
        const summary = TRAIT_KEYS.map((k) => `${TRAIT_LABELS[k]} ${r.state.traits[k].score}`).join(' · ')
        return `已恢复到初始人设性格种子（v${r.state.version}）：\n${summary}`
      }
      if (/^(eval|evaluate|评估)$/.test(sub)) {
        const r = await deps.personaEngine.evaluatePersonality(undefined, { force: true })
        if (r.skipped === 'insufficient-evidence') return `最近积累的有效对话还不够（当前 ${r.sampledCount || 0} 条，至少需要 3 条），多聊几句再来评估吧`
        if (!r.ok) return '性格评估未完成：' + (r.error || r.skipped || '未知原因')
        if (!r.anyChanged) return `性格评估完成（v${r.state.version}）：近期表现与现有人格底色一致，无需微调`
        const changed = TRAIT_KEYS
          .filter((k) => r.deltas?.[k])
          .map((k) => `${TRAIT_LABELS[k]} ${r.deltas[k] > 0 ? '+' : ''}${r.deltas[k]}`)
          .join('，')
        return `性格微调完成（v${r.state.version}）：${changed || '描述已更新'}`
      }
      const st = deps.personaEngine.getState()
      const p = st.personality
      const trendMap = { up: '↑', down: '↓', stable: '→', uncertain: '?' }
      const lines = [
        `当前五维性格（${st.personaName} · v${p.version}，距上次评估 ${p.turns_since_eval} 轮）：`,
        ...TRAIT_KEYS.map((k) => {
          const t = p.traits[k]
          return `- ${TRAIT_LABELS[k]}：${t.score.toFixed(2)} ${trendMap[t.trend] || '→'}（初始 ${t.seed_score.toFixed(2)}，档位 ${t.tier >= 0 ? '+' + t.tier : t.tier}）`
        }),
      ]
      return lines.join('\n')
    }
    case 'diary': {
      if (!qzone) return '空间日记没开'
      const r = await qzone.writeDiary()
      return r.ok ? (r.dryRun ? '写好了，不过现在是试运行，没真发' : '写好发出去啦，去空间看看') : '没写成：' + (r.message || '不知道为啥')
    }
    case 'remember': {
      if (!memory) return '记忆模块关着'
      if (!cmd.arg) return '要我记住什么呀？比如 /remember 我不吃香菜'
      const r = memory.add({ text: cmd.arg, aboutName: cfg.ownerName || '主人', about: cfg.ownerQQ, importance: 0.8, source: 'panel', chatId: msg.chatId })
      return r.ok ? '记住了' : '没记上：' + (r.message || '')
    }
    case 'reset':
      hub.resetChat(msg.chatId)
      return '好，我们重新开始'
    case 'on':
      setConfig({ ...cfg, enabled: true })
      return cfg.dryRun ? '总开关打开了（现在是试运行，我说的话只进日志）' : '我上线啦'
    case 'off':
      setConfig({ ...cfg, enabled: false })
      return '好，我先下线了。发 /on 叫我回来'
    default:
      return null
  }
}
