// Providers mix decimal (128,000 → 128K) and binary (65,536 → 64K) limits; show each the way it was meant.
// Decimal wins when both divide evenly: 128,000 is also 125 × 1024, but nobody means "125K".
export function formatTokens(n: number | null): string {
  if (n === null) return '—'
  const base = n % 1000 !== 0 && n % 1024 === 0 ? 1024 : 1000
  if (n >= base * base) return `${+(n / (base * base)).toFixed(1)}M`
  if (n >= base) return `${+(n / base).toFixed(1)}K`
  return String(n)
}

// Accepts "200000", "200,000", "200k", "1m", "1.5M". Empty means "unknown"; anything else is invalid.
export function parseTokens(input: string): number | null | 'invalid' {
  const text = input.trim().replace(/,/g, '').toLowerCase()
  if (text === '') return null
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text)
  if (!match) return 'invalid'
  const scale = match[2] === 'k' ? 1000 : match[2] === 'm' ? 1_000_000 : 1
  const value = Math.round(Number(match[1]) * scale)
  return value > 0 ? value : 'invalid'
}

// Shown on note reference cards as "约 N tokens"; no tokenizer is shipped, and providers count differently
// anyway. Roughly one token per CJK character and four characters per token for the rest.
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}
