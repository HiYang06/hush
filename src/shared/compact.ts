import type { ContextUsage, NothingReason } from './types'

// When a reply ends at this share of the window, compaction starts by itself (D-087).
const COMPACT_TRIGGER = 0.85
// Below this share of the window, a compaction can't free enough to be worth a call: the rest is attachments,
// which stay after compacting.
const MIN_COMPRESSIBLE = 0.1

export const NOTHING_REASONS: Record<NothingReason, string> = {
  recent: '没有可以压缩的内容：最近的几轮会原样保留。',
  files_only: '前面几轮只有附件，压缩后附件照样保留，没有可以压缩的文字。',
  too_large: '最前面一轮太长，一次压缩请求放不下，没法压缩。',
  model_deleted: '这个会话用的模型已被删除，没法压缩。'
}

export function isFull(u: ContextUsage): boolean {
  return u.window !== null && u.tokens >= u.window * COMPACT_TRIGGER
}

export function shouldAutoCompact(u: ContextUsage): boolean {
  return isFull(u) && u.compressible >= u.window! * MIN_COMPRESSIBLE
}
