// WebKit draws ::highlight() but has no highlightsFromPoint, which the desktop's decorationsAt
// (lib/highlights.ts) asks for a tap's mark or thread. This answers it from the ranges' boxes instead.
// A finger is less exact than a pointer, so a box counts a few pixels past its edge.
const SLOP = 4

const registry: Partial<HighlightRegistry> = HighlightRegistry.prototype

if (!registry.highlightsFromPoint) {
  registry.highlightsFromPoint = function (this: HighlightRegistry, x: number, y: number): HighlightHitResult[] {
    const hits: HighlightHitResult[] = []
    this.forEach((highlight) => {
      const ranges = [...highlight].filter((range) =>
        [...(range as Range).getClientRects()].some(
          (r) => x >= r.left - SLOP && x <= r.right + SLOP && y >= r.top - SLOP && y <= r.bottom + SLOP
        )
      )
      if (ranges.length > 0) hits.push({ highlight, ranges })
    })
    return hits.sort((a, b) => b.highlight.priority - a.highlight.priority)
  }
}
