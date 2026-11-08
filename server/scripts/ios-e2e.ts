// A local Hush server for the iOS UI test (ios/HushUITests): in-memory Postgres, seeded with a copy of a
// desktop database under the account ios-e2e@example.com. Codes are served at GET /dev/code?email=, and
// attachments at /dev/objects/ in place of R2. Given the desktop's attachments folder, its files go up too.
//   cd server && node scripts/ios-e2e.ts <copy of hush.db> [~/Library/Application Support/hush/attachments]
// Never point it at the live database: the desktop may be writing to it (make a copy with sqlite3 .backup).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { serve } from '@hono/node-server'
import { startTestServer } from '../tests/harness.ts'

const EMAIL = 'ios-e2e@example.com'
const TABLES = ['projects', 'sessions', 'messages', 'marks', 'mark_categories', 'notes', 'note_revisions', 'files', 'providers', 'models', 'settings']
const LOCAL_ONLY = ['rowid', 'api_key_enc']

const [dbPath, attachmentsDir] = process.argv.slice(2)
const sql = (q: string): any[] => JSON.parse(execFileSync('sqlite3', ['-json', dbPath, q], { maxBuffer: 1 << 30 }).toString() || '[]')

const server = await startTestServer()
const token = await server.login(EMAIL)
const counts: Record<string, number> = {}
const changes: any[] = []
for (const tbl of TABLES) {
  const cols = sql(`PRAGMA table_info(${tbl})`).map((c) => c.name).filter((c) => !LOCAL_ONLY.includes(c))
  const rows = sql(`SELECT ${cols.join(', ')} FROM ${tbl}${tbl === 'settings' ? ` WHERE key = 'system_prompt'` : ''}`)
  counts[tbl] = rows.length
  for (const data of rows) changes.push({ tbl, rowId: String(tbl === 'settings' ? data.key : data.id), deleted: false, data })
}

// A session of known text for the reading test: blocks join with '\n' and a formula counts as its LaTeX
// (renderer/lib/anchors.ts), so the marks' positions can be written out here.
const at = Date.now()
const reply = '这一段有 mark，点一下会弹出卡片。\n\n公式 $a^2+b^2=c^2$ 也能 mark。\n\n这一段挂着一次追问。'
const replyText = '这一段有 mark，点一下会弹出卡片。\n公式 a^2+b^2=c^2 也能 mark。\n这一段挂着一次追问。'
const threadText = '追问里的回答，这一句被 mark 了。'
const anchor = (text: string, quote: string) => {
  const start = text.indexOf(quote)
  const end = start + quote.length
  return { quote, start, end, prefix: text.slice(Math.max(0, start - 30), start), suffix: text.slice(end, end + 30) }
}
const mark = (id: string, messageId: string, text: string, quote: string, categoryId: string, comment: string | null) => {
  const a = anchor(text, quote)
  return { id, session_id: 'e2e-read', message_id: messageId, quote, start_offset: a.start, end_offset: a.end, prefix: a.prefix, suffix: a.suffix, comment, category_id: categoryId, created_at: at }
}
const thread = anchor(replyText, '这一段挂着一次追问。')

// A plain 240×160 picture for the attachment, written out as PNG by hand.
const png = (() => {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const [w, h] = [240, 160]
  const header = Buffer.alloc(13)
  header.writeUInt32BE(w, 0)
  header.writeUInt32BE(h, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([0x4e, 0x94, 0xe6]))])
  const pixels = deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
})()
const pngSha = createHash('sha256').update(png).digest('hex')
const clipped = anchor(replyText, '公式 a^2+b^2=c^2 也能 mark。')
const note = [
  '> 公式 $a^2+b^2=c^2$ 也能 mark。',
  '>',
  `> —— [《阅读测试》](hush://message/e2e-a#${clipped.start}-${clipped.end})`,
  '',
  '## 第二节',
  '',
  '笔记引用指向这一节。'
].join('\n')
const fixture = {
  sessions: [
    { id: 'e2e-read', kind: 'main', title: '阅读测试', created_at: at, updated_at: at },
    { id: 'e2e-thread', kind: 'thread', parent_session_id: 'e2e-read', anchor_message_id: 'e2e-a', anchor_quote: thread.quote, anchor_start: thread.start, anchor_end: thread.end, anchor_prefix: thread.prefix, anchor_suffix: thread.suffix, context_mode: 'fork', title: '测试追问', created_at: at, updated_at: at }
  ],
  messages: [
    {
      id: 'e2e-q', session_id: 'e2e-read', seq: 1, role: 'user', content: '问题', status: 'done', created_at: at,
      attachments: JSON.stringify([
        { type: 'file', fileId: 'e2e-img' },
        { type: 'note_ref', noteId: 'e2e-note', sectionTitle: '第二节', label: '会话 Note · 第二节', text: '笔记引用指向这一节。' }
      ])
    },
    { id: 'e2e-a', session_id: 'e2e-read', seq: 2, role: 'assistant', content: reply, attachments: '[]', status: 'done', created_at: at },
    { id: 'e2e-tq', session_id: 'e2e-thread', seq: 1, role: 'user', content: '这段是什么意思？', attachments: '[]', status: 'done', created_at: at },
    { id: 'e2e-ta', session_id: 'e2e-thread', seq: 2, role: 'assistant', content: threadText, attachments: '[]', status: 'done', created_at: at }
  ],
  marks: [
    mark('e2e-m1', 'e2e-a', replyText, '这一段有 mark，点一下会弹出卡片。', 'cat-question', '卡片里的批注'),
    mark('e2e-m2', 'e2e-a', replyText, '公式 a^2+b^2=c^2', 'cat-knowledge', null),
    mark('e2e-m3', 'e2e-ta', threadText, '这一句被 mark 了', 'cat-quote', null)
  ],
  files: [{ id: 'e2e-img', sha256: pngSha, name: '测试图.png', mime: 'image/png', size: png.length, path: `${pngSha}.png`, created_at: at }],
  notes: [{ id: 'e2e-note', scope: 'session', scope_id: 'e2e-read', content: note, updated_at: at }]
}
for (const [tbl, rows] of Object.entries(fixture)) {
  for (const data of rows) changes.push({ tbl, rowId: data.id, deleted: false, data })
}

let since = 0
for (let i = 0; i < changes.length; i += 500) {
  const res = await server.call('POST', '/sync/push', { changes: changes.slice(i, i + 500), since }, token)
  if (res.status !== 200) throw new Error(`push ${res.status} ${JSON.stringify(res.json)}`)
  since = res.json.cursor
}

const upload = async (sha256: string, bytes: Buffer) => {
  const res = await server.call('POST', `/files/${sha256}/upload`, { size: bytes.length }, token)
  if (res.json.exists) return
  await server.objectFetch('PUT', res.json.url, bytes)
  await server.call('POST', `/files/${sha256}/done`, {}, token)
}
await upload(pngSha, png)
let uploaded = 0
for (const { sha256, path } of attachmentsDir ? sql('SELECT sha256, path FROM files') : []) {
  if (!existsSync(join(attachmentsDir, path))) continue
  await upload(sha256, readFileSync(join(attachmentsDir, path)))
  uploaded++
}
console.log('seeded', JSON.stringify(counts), 'uploaded', uploaded)

// Seeding sent this email a code; the server allows one a minute, so the test's own would be refused.
await new Promise((resolve) => setTimeout(resolve, 61_000))
serve({
  port: 8787,
  fetch: async (req) => {
    const url = new URL(req.url)
    if (url.pathname === '/dev/code') return Response.json({ code: server.mail.get(url.searchParams.get('email') ?? '') ?? null })
    if (url.pathname.startsWith('/dev/objects/')) {
      const res = await server.objectFetch('GET', `memory://objects/${url.pathname.slice('/dev/objects/'.length)}`)
      return new Response(res.status === 200 ? new Uint8Array(res.body) : null, { status: res.status })
    }
    const res = await server.app.fetch(req)
    // The fake storage's signed URLs are memory:// addresses; the app gets them here instead.
    if (!/^\/files\/\w+\/download$/.test(url.pathname) || res.status !== 200) return res
    const { url: signed } = (await res.json()) as { url: string }
    return Response.json({ url: signed.replace('memory://objects/', `${url.origin}/dev/objects/`) })
  }
})
console.log('ready on http://localhost:8787')
