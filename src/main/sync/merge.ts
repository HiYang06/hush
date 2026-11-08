import { merge } from 'node-diff3'

// Line-based three-way merge of a note. null when both sides changed the same lines differently;
// edits that are identical on both sides are not a conflict.
export function mergeNote(base: string, local: string, server: string): string | null {
  const result = merge(local.split('\n'), base.split('\n'), server.split('\n'), { excludeFalseConflicts: true })
  return result.conflict ? null : result.result.join('\n')
}
