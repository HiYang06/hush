// A section runs from a heading to the next heading of the same or a higher level (product.md terms).
// Headings are ATX only (`## title`); `#` lines inside fenced code don't count.

export type NoteHeading = { level: number; title: string; line: number }

export type NoteSection = NoteHeading & {
  // The line after the section's last one: the next heading of the same or a higher level, or the end.
  endLine: number
  // The section's text without its heading line, sub-sections included.
  body: string
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/

export function noteHeadings(markdown: string): NoteHeading[] {
  const headings: NoteHeading[] = []
  let fence: string | null = null
  markdown.split('\n').forEach((text, line) => {
    const fenceMatch = FENCE.exec(text)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      // A fence closes only with the same character, at least as long as the opening one.
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return
    }
    if (fence !== null) return
    const match = HEADING.exec(text)
    if (match && match[2].trim()) headings.push({ level: match[1].length, title: match[2].trim(), line })
  })
  return headings
}

export function noteSections(markdown: string): NoteSection[] {
  const lines = markdown.split('\n')
  const headings = noteHeadings(markdown)
  return headings.map((heading, i) => {
    const next = headings.slice(i + 1).find((h) => h.level <= heading.level)
    const endLine = next ? next.line : lines.length
    const body = lines.slice(heading.line + 1, endLine).join('\n')
    return { ...heading, endLine, body: body.trim() }
  })
}
