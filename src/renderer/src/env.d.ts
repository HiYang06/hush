/// <reference types="vite/client" />

// Shipped in Chromium 140 but not yet in TypeScript's DOM types.
interface HighlightHitResult {
  highlight: Highlight
  ranges: AbstractRange[]
}

interface HighlightRegistry {
  highlightsFromPoint(x: number, y: number): HighlightHitResult[]
}

interface Window {
  api: import('@shared/types').Api
}
