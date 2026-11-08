import type Database from 'better-sqlite3'
import type { MarkCategory } from '@shared/types'

export function listMarkCategories(db: Database.Database): MarkCategory[] {
  return db
    .prepare('SELECT id, name, color, sort_order AS sortOrder FROM mark_categories ORDER BY sort_order')
    .all() as MarkCategory[]
}
