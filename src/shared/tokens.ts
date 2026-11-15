// Reference cards show it as "约 N tokens"; context usage falls back to it when the provider gave no count.
// No tokenizer is shipped, and providers count differently anyway. Roughly one token per CJK character and four characters per token for the rest.
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g

export function estimateTokens(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}
