// 内置模块：心情（由拟人状态引擎八维情绪驱动，经隔离兼容适配层导出旧版接口）。
// 导出 nudge(变化, 原因)、label()、state()、effects()、contextLine()、observe()、judge()。

import { createLegacyMoodAdapter } from '../../persona-engine/legacy-mood-adapter.js'

export default {
  id: 'mood',
  name: '心情',
  version: '2.0.0',
  description: '她的心境与八维情绪：随互动自然起伏与衰减，影响语气、表情/语音频率和回复快慢',
  tab: 'mood',
  setup(api) {
    const mood = createLegacyMoodAdapter({
      engine: api.core.personaEngine,
      getConfig: api.config,
    })
    api.context(({ chat, sessionId }) => (chat.kind === 'system' ? '' : mood.contextLine(chat, sessionId)))
    return mood
  },
}
