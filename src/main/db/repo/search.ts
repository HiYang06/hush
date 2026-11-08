import type Database from 'better-sqlite3'
import type { NoteScope, SearchResults } from '@shared/types'
import { searchTerms, snippet } from '@shared/search'

const GROUP_LIMIT = 20

// Every term must appear. trigram needs 3 characters per term, so a shorter one sends the whole
// query to LIKE (D-020). Both search the plain text (D-049); the database only picks rows and snippets
// are cut here (D-048).
export function search(db: Database.Database, query: string): SearchResults {
  const terms = searchTerms(query)
  if (terms.length === 0) return { terms, sessions: [], messages: [], notes: [] }

  const likeParams = terms.map((t) => `%${t.replace(/[\\%_]/g, '\\$&')}%`)
  const like = (column: string): string => terms.map(() => `${column} LIKE ? ESCAPE '\\'`).join(' AND ')
  const useFts = terms.every((t) => [...t].length >= 3)
  const ftsQuery = terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' ')
  const contentMatch = (table: 'messages' | 'notes', alias: string): { sql: string; params: string[] } =>
    useFts
      ? { sql: `${alias}.rowid IN (SELECT rowid FROM ${table}_fts WHERE ${table}_fts MATCH ?)`, params: [ftsQuery] }
      : { sql: like(`${alias}.plain`), params: likeParams }

  const sessions = db
    .prepare(
      `SELECT id, title, updated_at AS updatedAt FROM sessions
       WHERE kind = 'main' AND ${like('title')} ORDER BY updated_at DESC LIMIT ${GROUP_LIMIT}`
    )
    .all(...likeParams) as SearchResults['sessions']

  const inMessages = contentMatch('messages', 'm')
  const messageRows = db
    .prepare(
      `SELECT m.id, COALESCE(p.title, s.title) AS sessionTitle, m.created_at AS createdAt, m.plain
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       LEFT JOIN sessions p ON p.id = s.parent_session_id
       WHERE ${inMessages.sql} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ${GROUP_LIMIT}`
    )
    .all(...inMessages.params) as { id: string; sessionTitle: string; createdAt: number; plain: string }[]

  const inNotes = contentMatch('notes', 'n')
  const noteRows = db
    .prepare(
      `SELECT n.scope, n.scope_id AS scopeId, n.plain, n.updated_at AS updatedAt,
         CASE n.scope WHEN 'session' THEN s.title WHEN 'project' THEN pr.name END AS ownerName
       FROM notes n
       LEFT JOIN sessions s ON n.scope = 'session' AND s.id = n.scope_id
       LEFT JOIN projects pr ON n.scope = 'project' AND pr.id = n.scope_id
       WHERE ${inNotes.sql} ORDER BY n.updated_at DESC LIMIT ${GROUP_LIMIT}`
    )
    .all(...inNotes.params) as {
    scope: NoteScope
    scopeId: string
    plain: string
    updatedAt: number
    ownerName: string | null
  }[]

  return {
    terms,
    sessions,
    messages: messageRows.map(({ plain, ...m }) => ({ ...m, snippet: snippet(plain, terms) })),
    notes: noteRows.map(({ scope, scopeId, plain, updatedAt, ownerName }) => ({
      target: { scope, scopeId },
      ownerName,
      updatedAt,
      snippet: snippet(plain, terms)
    }))
  }
}
