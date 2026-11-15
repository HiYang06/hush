// Pure: what to compact and how to ask for it. Running it belongs to chat.ts, which gathers the context (D-087).
import { planFile } from '@shared/files'
import { effectiveThinkingLevel } from '@shared/thinking'
import { estimateTokens } from '@shared/tokens'
import type { ContextUsage, Message, Model, NothingReason } from '@shared/types'
import {
  activeCompaction,
  buildContext,
  conversationMessages,
  expandAttachment,
  type ActiveCompaction,
  type ContextInput
} from './context'
import type { ChatRequest, ContentPart } from './types'

export const KEEP_RECENT_TOKENS = 20_000
export const SUMMARY_MAX_OUTPUT = 8000
// No provider says what an image costs before it's sent; this is in the range they bill a page-sized one.
export const IMAGE_TOKENS = 1500

export const COMPACT_PROMPT = `这段对话太长了，请把上面的全部内容写成一份摘要，之后的对话会用这份摘要代替上面的原文继续。不要回答对话里的问题，也不要调用工具，只输出摘要本身，用中文，按下面几节写：

## 主题和目标
在讨论什么，用户想弄明白什么。

## 用户的水平和要求
用户的背景、已经掌握到什么程度，对回答方式提过的要求（详略、语气、格式）。

## 已经讲清楚的内容
结论、定义、推导的关键步骤、举过的例子。公式、代码、数字照原样保留，不要改写。

## 还没解决的问题
用户还在困惑的地方，说过「之后再聊」的话题，最后一轮停在哪里。

## 提到过的材料
附过的文件（写文件名和用到的部分）、引用过的 note 和会话、给过的链接。

如果对话开头已经有一份「前面对话的摘要」，把它并进来：里面的要点不要删，也不要改写，只补充之后的新内容。`

function estimateParts(parts: ContentPart[]): number {
  return parts.reduce((sum, p) => sum + (p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKENS), 0)
}

export function estimateRequest(req: Pick<ChatRequest, 'system' | 'messages'>): number {
  return estimateTokens(req.system) + req.messages.reduce((sum, m) => sum + estimateParts(m.content), 0)
}

// One round: a question and everything up to the next question. tokens counts what it sends; text leaves out
// its files, which a compaction keeps, so text is what compacting the round can free.
export type Round = { lastId: string; tokens: number; text: number }

function messageTokens(m: Message, input: Pick<ContextInput, 'files' | 'model'>): { text: number; files: number } {
  let text = estimateTokens(m.content)
  let files = 0
  for (const a of m.attachments) {
    if (a.type !== 'file') {
      text += estimateTokens(expandAttachment(a))
      continue
    }
    const record = input.files.get(a.fileId)?.record
    if (!record) throw new Error(`File ${a.fileId} was not loaded`)
    for (const p of planFile(record, input.model).parts) files += p.type === 'text' ? estimateTokens(p.text) : IMAGE_TOKENS
  }
  return { text, files }
}

// A run of messages that doesn't start with a question (a fork thread's history after a compacted part, or a
// failed first reply) counts as part of the first round.
export function roundsOf(messages: Message[], input: Pick<ContextInput, 'files' | 'model'>): Round[] {
  const rounds: Round[] = []
  for (const m of messages) {
    const { text, files } = messageTokens(m, input)
    const last = rounds[rounds.length - 1]
    if (m.role === 'user' || !last) rounds.push({ lastId: m.id, tokens: text + files, text })
    else Object.assign(last, { lastId: m.id, tokens: last.tokens + text + files, text: last.text + text })
  }
  return rounds
}

// The last message to summarize. The newest rounds stay as they are, about KEEP_RECENT_TOKENS of them and always
// the last one. Of the rounds before those, only as many as fit in budget (from the oldest); null when none does.
export function chooseCut(rounds: Round[], budget: number): string | null {
  if (rounds.length === 0) return null
  let kept = rounds.length - 1
  let recent = rounds[kept].tokens
  while (kept > 0 && recent + rounds[kept - 1].tokens <= KEEP_RECENT_TOKENS) {
    kept--
    recent += rounds[kept].tokens
  }
  let cut: string | null = null
  let used = 0
  for (const round of rounds.slice(0, kept)) {
    used += round.tokens
    if (used > budget) break
    cut = round.lastId
  }
  return cut
}

export function compactLimit(model: Pick<Model, 'contextWindow'>): number | null {
  return model.contextWindow === null ? null : model.contextWindow - SUMMARY_MAX_OUTPUT
}

// throughId null exactly when there is a reason nothing can be compacted.
export type CompactionPlan =
  | { throughId: string; compressible: number; nothingReason: null }
  | { throughId: null; compressible: 0; nothingReason: NothingReason }

export function nothingToCompact(nothingReason: NothingReason): CompactionPlan {
  return { throughId: null, compressible: 0, nothingReason }
}

// limit: how many tokens the compaction request may take, or null when the window is unknown. compressible is
// the text of the rounds compacting would summarize over all its passes, so it can tell whether compacting is worth
// it. Rounds that are only attachments free nothing, since attachments stay after compacting.
export function planCompaction(input: ContextInput, limit: number | null): CompactionPlan {
  const conversation = conversationMessages(input)
  const compaction = activeCompaction(input)
  const rounds = roundsOf(conversation.slice(compaction ? compaction.throughIndex + 1 : 0), input)
  const unlimited = chooseCut(rounds, Infinity)
  const upTo = unlimited === null ? 0 : rounds.findIndex((r) => r.lastId === unlimited) + 1
  const compressible = rounds.slice(0, upTo).reduce((sum, r) => sum + r.text, 0)
  if (unlimited === null) return nothingToCompact('recent')
  if (compressible === 0) return nothingToCompact('files_only')
  if (limit === null) return { throughId: unlimited, compressible, nothingReason: null }
  const prefix = compaction
    ? estimateRequest(buildContext({ ...input, through: conversation[compaction.throughIndex].id }))
    : estimateTokens(buildContext(input).system)
  const throughId = chooseCut(rounds, limit - prefix - estimateTokens(COMPACT_PROMPT))
  if (throughId === null) return nothingToCompact('too_large')
  return { throughId, compressible, nothingReason: null }
}

export function compactRequest(
  context: Omit<ChatRequest, 'signal' | 'tools'>,
  model: Pick<Model, 'supportsThinking' | 'thinkingCanDisable' | 'maxOutputTokens'>
): Omit<ChatRequest, 'signal'> {
  const prompt: ContentPart = { type: 'text', text: COMPACT_PROMPT }
  const last = context.messages.at(-1)
  // The cut can end on a question whose reply failed; providers expect roles to alternate.
  const messages =
    last?.role === 'user'
      ? [...context.messages.slice(0, -1), { ...last, content: [...last.content, prompt] }]
      : [...context.messages, { role: 'user' as const, content: [prompt] }]
  return {
    ...context,
    messages,
    thinking: model.supportsThinking ? effectiveThinkingLevel(model, 'off') : null,
    maxOutputTokens: Math.min(model.maxOutputTokens ?? SUMMARY_MAX_OUTPUT, SUMMARY_MAX_OUTPUT)
  }
}

// The provider's count when the last reply has one and was given the current summary (a reply that started before
// the compaction landed was sent the long context); otherwise an estimate of what the next request sends.
export function contextUsage(
  conversation: Message[],
  compaction: ActiveCompaction | null,
  built: Pick<ChatRequest, 'system' | 'messages'>,
  window: number | null,
  { compressible, nothingReason }: Pick<CompactionPlan, 'compressible' | 'nothingReason'>
): ContextUsage {
  const last = [...conversation].reverse().find((m) => m.role === 'assistant')
  const exact =
    last?.status === 'done' && last.contextTokens !== null && last.createdAt > (compaction?.compactedAt ?? 0)
      ? last.contextTokens + estimateTokens(last.content)
      : null
  return { tokens: exact ?? estimateRequest(built), window, compressible, summary: compaction?.summary ?? null, nothingReason }
}
