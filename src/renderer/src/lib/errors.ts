import type { ErrorKind } from '@shared/types'

// Electron wraps errors thrown in the main process as "Error invoking remote method 'x': Error: <message>".
export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

// What a failed reply says first; the provider's own words go below it (product.md §2).
export const ERROR_LEADS: Record<ErrorKind, string> = {
  auth: 'API key 无效，或者没有权限',
  rate_limit: '请求太频繁，或者额度用完了',
  context_length: '对话超出了模型的上下文长度',
  network: '连不上服务商',
  other: '出错了'
}
