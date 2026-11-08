// A session's link, [《title》](hush://session/<id>): copied from the sidebar, pasted into the input box
// as a session_ref card, or into a note to open the session from there.
export function sessionLink(id: string, title: string): string {
  return `[《${title.replace(/[[\]\\]/g, '\\$&')}》](hush://session/${id})`
}

export function hushLinkSessionId(href: string): string | null {
  return /^hush:\/\/session\/([\w-]+)$/.exec(href)?.[1] ?? null
}

// Only a paste that is the link and nothing else becomes a card; inside other text it stays text.
export function pastedSessionId(text: string): string | null {
  const t = text.trim()
  const md = /^\[(?:\\.|[^\]\\])*\]\((hush:\/\/session\/[\w-]+)\)$/.exec(t)
  return hushLinkSessionId(md ? md[1] : t)
}
