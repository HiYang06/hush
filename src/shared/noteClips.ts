// A clip's source link, [《title》](hush://message/<id>#<start>-<end>) (main/notes.ts clipBlock). The
// range is the passage's position in the reply (renderer/lib/anchors.ts); links written before it was
// added have none. The label may contain escaped brackets.
export const HUSH_LINK = /\[(?:\\.|[^\]\\])*\]\(hush:\/\/message\/([\w-]+)(?:#(\d+)-(\d+))?\)/g

// `at` is where the link starts in the note.
export type NoteClip = { messageId: string; start: number; end: number; at: number }

// The clips a note still holds: deleting one from the note takes its highlight away with it.
export function noteClips(markdown: string): NoteClip[] {
  return [...markdown.matchAll(HUSH_LINK)].flatMap((m) =>
    m[2] === undefined ? [] : [{ messageId: m[1], start: Number(m[2]), end: Number(m[3]), at: m.index }]
  )
}

export function hushLinkMessageId(href: string): string {
  return href.replace('hush://message/', '').replace(/#.*$/, '')
}

// How many of `before`'s source links `after` no longer holds; each one takes a reply's underline with it.
export function lostClipLinks(before: string, after: string): number {
  const remaining = [...after.matchAll(HUSH_LINK)].map((m) => m[0])
  let lost = 0
  for (const [link] of before.matchAll(HUSH_LINK)) {
    const i = remaining.indexOf(link)
    if (i === -1) lost++
    else remaining.splice(i, 1)
  }
  return lost
}
