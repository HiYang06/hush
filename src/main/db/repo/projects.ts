import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type { Project, ProjectPatch } from '@shared/types'

const PROJECT_COLUMNS = `id, name, system_prompt AS systemPrompt, sort_order AS sortOrder,
  created_at AS createdAt, updated_at AS updatedAt`

export function listProjects(db: Database.Database): Project[] {
  return db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY sort_order, created_at`).all() as Project[]
}

export function getProject(db: Database.Database, id: string): Project {
  const row = db.prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`).get(id)
  if (!row) throw new Error(`Project ${id} not found`)
  return row as Project
}

// New projects go to the end of the list.
export function createProject(db: Database.Database, name: string): Project {
  const id = randomUUID()
  const now = Date.now()
  const last = db.prepare('SELECT MAX(sort_order) FROM projects').pluck().get() as number | null
  db.prepare(
    `INSERT INTO projects (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(id, name, (last ?? -1) + 1, now, now)
  return getProject(db, id)
}

export function updateProject(db: Database.Database, id: string, patch: ProjectPatch): Project {
  const current = getProject(db, id)
  // An empty prompt is stored as NULL, which means "use the global prompt" (D-019).
  const systemPrompt =
    patch.systemPrompt === undefined ? current.systemPrompt : patch.systemPrompt.trim() || null
  db.prepare('UPDATE projects SET name = ?, system_prompt = ?, updated_at = ? WHERE id = ?').run(
    patch.name ?? current.name,
    systemPrompt,
    Date.now(),
    id
  )
  return getProject(db, id)
}

// Its sessions (and their messages, marks, threads) go through ON DELETE CASCADE. Sessions inside a
// project have no notes of their own, so only the project's note is removed by hand.
export function deleteProject(db: Database.Database, id: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM notes WHERE scope = 'project' AND scope_id = ?").run(id)
    db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  })()
}

export function getProjectPrompt(db: Database.Database, projectId: string | null): string | null {
  if (projectId === null) return null
  return (db.prepare('SELECT system_prompt FROM projects WHERE id = ?').pluck().get(projectId) ??
    null) as string | null
}
