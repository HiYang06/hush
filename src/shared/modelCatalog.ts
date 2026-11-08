import type { ModelCapabilities, ModelLimits } from './types'

// Parameters for models whose list API doesn't report them (OpenAI-compatible providers and relays).
// Only models checked against the provider's own docs (2026-11), plus conservative family values:
// a max output every model in the family accepts, and thinkingCanDisable only where 'none' is
// documented to work — a wrong "can't disable" just hides 关, a wrong "can" makes requests fail.
type CatalogEntry = { capabilities: ModelCapabilities } & ModelLimits

const thinkingModel = (supportsVision: boolean, thinkingCanDisable: boolean): ModelCapabilities => ({
  supportsVision,
  supportsThinking: true,
  thinkingCanDisable,
  supportsTools: true
})

// First match wins, so narrower patterns go first.
const CATALOG: [RegExp, CatalogEntry][] = [
  [/^deepseek-(flash|v4-flash)/, { capabilities: thinkingModel(true, true), contextWindow: 1_000_000, maxOutputTokens: 384_000 }],
  [/^deepseek-v4-pro/, { capabilities: thinkingModel(false, true), contextWindow: 1_000_000, maxOutputTokens: 384_000 }],
  [/^kimi-k3/, { capabilities: thinkingModel(true, false), contextWindow: 1_048_576, maxOutputTokens: null }],
  [/^qwen3\.[78]-(max|plus|flash)/, { capabilities: thinkingModel(true, false), contextWindow: 1_000_000, maxOutputTokens: 65_536 }],
  [/^glm-5\.3-flash/, { capabilities: thinkingModel(true, false), contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  [/^glm-5\.[23]/, { capabilities: thinkingModel(false, false), contextWindow: 1_000_000, maxOutputTokens: 128_000 }],
  [/^glm-4\.7-flash/, { capabilities: thinkingModel(false, false), contextWindow: 200_000, maxOutputTokens: 128_000 }],
  [/^claude-/, { capabilities: thinkingModel(true, true), contextWindow: 200_000, maxOutputTokens: 64_000 }],
  [/^gpt-5/, { capabilities: thinkingModel(true, false), contextWindow: 400_000, maxOutputTokens: 128_000 }],
  [/^gemini-(2\.5|[3-9])/, { capabilities: thinkingModel(true, false), contextWindow: 1_048_576, maxOutputTokens: 65_536 }]
]

// Relays prefix ids with a route ("deepseek/deepseek-flash", "google-vertex/gemini-4-argon").
export function lookupModel(modelName: string): CatalogEntry | null {
  const id = modelName.slice(modelName.lastIndexOf('/') + 1).toLowerCase()
  return CATALOG.find(([pattern]) => pattern.test(id))?.[1] ?? null
}

// Not stored: once the user fills in a max output, the model stops asking.
export function needsReview(model: { modelName: string; maxOutputTokens: number | null }): boolean {
  return model.maxOutputTokens === null && lookupModel(model.modelName) === null
}
