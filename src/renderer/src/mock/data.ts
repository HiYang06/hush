import type { Settings } from '@shared/types'

export const mockSettings: Settings = {
  systemPrompt: '你是一个耐心的学习伙伴，回答准确、清楚，先给结论再解释。',
  lastModel: {
    providerId: 'prov-anthropic',
    modelId: 'model-claude-sonnet'
  }
}
