import type { Model, ThinkingLevel } from './types'

// The chosen level is kept across model switches; a model that can't turn thinking off runs "off" as "low" (D-029).
// Shared so the switch shows exactly what the main process sends.
export function effectiveThinkingLevel(
  model: Pick<Model, 'thinkingCanDisable'>,
  level: ThinkingLevel
): ThinkingLevel {
  return level === 'off' && !model.thinkingCanDisable ? 'low' : level
}
