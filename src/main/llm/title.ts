import { effectiveThinkingLevel } from '@shared/thinking'
import type { Attachment, Model, StreamEvent } from '@shared/types'
import type { ChatRequest, Connection } from './types'

export const TITLE_PROMPT = `给这段对话起一个标题，格式是「分类 | 概括」。
- 分类：2～4 个字，说明这是哪一类话题，比如：日常、编程、网络、数学、历史、英语、健康、理财。
- 概括：不超过 12 个字，说清楚用户想做什么，比如：询问ACL概念、比较两种排序算法、翻译一段合同。
- 只输出标题这一行，不要引号、句号和解释。
例子：日常 | 询问ACL概念`

// The answer only helps pin down the topic; its opening is enough and keeps the call cheap.
const ANSWER_EXCERPT_LENGTH = 1_500
const MAX_TITLE_LENGTH = 20

// Attachments go by name only: enough to tell what "这里面" points at, and the call stays cheap.
export function titleQuestion(text: string, attachments: Attachment[], fileName: (fileId: string) => string): string {
  const names = attachments.map((a) => {
    switch (a.type) {
      case 'file':
        return `[附件：${fileName(a.fileId)}]`
      case 'note_ref':
        return `[笔记引用：${a.label}]`
      case 'session_ref':
        return `[会话引用：${a.label}]`
      case 'mark_quiz':
        return `[考考我：${a.label}]`
      case 'thread_result':
        return `[追问结论] 关于「${a.quote}」`
    }
  })
  return [...names, text].filter((p) => p.trim()).join('\n')
}

export function titleRequest(
  model: Model,
  question: string,
  answer: string,
  signal: AbortSignal
): ChatRequest {
  const excerpt = [...answer].slice(0, ANSWER_EXCERPT_LENGTH).join('')
  return {
    model: model.modelName,
    system: TITLE_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: `<提问>\n${question}\n</提问>\n\n<回答开头>\n${excerpt}\n</回答开头>` }] }],
    thinking: model.supportsThinking ? effectiveThinkingLevel(model, 'off') : null,
    maxOutputTokens: model.maxOutputTokens,
    signal
  }
}

// Models drift from the format: quotes, a trailing period, a full-width bar, an explanation on the next line.
// A line without the bar isn't a title at all (the model answered or summarized instead), so it fails.
export function cleanTitle(raw: string): string | null {
  const line = raw.trim().split('\n')[0] ?? ''
  const title = line
    .replace(/^(标题[:：]\s*)/, '')
    .replace(/^["'“”‘’「」《》【】]+|["'“”‘’「」《》【】。.]+$/g, '')
    .replace(/\s*[|｜]\s*/, ' | ')
    .trim()
  if (!/^\S.* \| \S/.test(title)) return null
  const chars = [...title]
  return chars.length > MAX_TITLE_LENGTH ? chars.slice(0, MAX_TITLE_LENGTH).join('') : title
}

export async function generateTitle(
  stream: (conn: Connection, req: ChatRequest) => AsyncIterable<StreamEvent>,
  conn: Connection,
  req: ChatRequest
): Promise<string | null> {
  let text = ''
  for await (const event of stream(conn, req)) {
    if (event.type === 'text') text += event.delta
    // A failed title call just leaves the placeholder; the conversation itself is unaffected.
    if (event.type === 'error') return null
  }
  return cleanTitle(text)
}
