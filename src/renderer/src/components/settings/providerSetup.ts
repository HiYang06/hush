import type { ModelCapabilities, ProviderProtocol } from '@shared/types'

export const PROTOCOLS: {
  value: ProviderProtocol
  label: string
  defaultName: string
  baseUrl: string
}[] = [
  {
    value: 'anthropic',
    label: 'Anthropic Messages',
    defaultName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com'
  },
  {
    value: 'openai_responses',
    label: 'OpenAI Responses',
    defaultName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1'
  },
  {
    value: 'openai_chat',
    label: 'OpenAI Chat Completions 兼容',
    defaultName: 'OpenAI 兼容',
    baseUrl: 'https://api.openai.com/v1'
  },
  {
    value: 'gemini',
    label: 'Gemini',
    defaultName: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com'
  }
]

export function protocolInfo(protocol: ProviderProtocol): (typeof PROTOCOLS)[number] {
  return PROTOCOLS.find((p) => p.value === protocol)!
}

export type Preset = {
  id: string
  name: string
  protocol: ProviderProtocol
  baseUrl: string
  keyUrl: string
}

// Addresses and key pages checked against each provider's docs (2026-11).
export const PRESETS: Preset[] = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai_chat', baseUrl: 'https://api.deepseek.com', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi', name: 'Kimi', protocol: 'openai_chat', baseUrl: 'https://api.moonshot.cn/v1', keyUrl: 'https://platform.kimi.com/console/api-keys' },
  { id: 'qwen', name: '通义千问', protocol: 'openai_chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyUrl: 'https://bailian.console.aliyun.com/model/settings/api-key' },
  { id: 'glm', name: '智谱 GLM', protocol: 'openai_chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai_chat', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' }
]

export const OFFICIAL_PRESETS: Preset[] = [
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai_responses', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini', name: 'Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', keyUrl: 'https://aistudio.google.com/apikey' }
]

export const NO_CAPABILITIES: ModelCapabilities = {
  supportsVision: false,
  supportsThinking: false,
  thinkingCanDisable: true,
  // Nearly every current model takes function tools; the ones that don't get it unchecked by hand.
  supportsTools: true
}

export const MODEL_HINTS = {
  contextWindow: '只用来显示，不影响使用。',
  maxOutputTokens: '一条回答最多多长。不填就用服务商的默认值，有的只有几千，长回答会被截断。模型文档里一般叫 max tokens 或最大输出。',
  supportsVision: '能看图片。拿不准就先不勾，发图时会提醒你。',
  supportsThinking: '会先想一会儿再回答。勾上后，输入框旁边才有思考强度。',
  thinkingCanDisable: '思考强度里有没有「关」。选「关」时报错，就取消这一项。',
  supportsTools: '联网搜索、翻阅 PDF 和课件需要。模型不支持时会报错，那时再取消。'
}
