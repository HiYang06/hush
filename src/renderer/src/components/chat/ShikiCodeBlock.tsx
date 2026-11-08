import React, { useEffect, useState } from 'react'
import { bundledLanguages, codeToHtml } from 'shiki'

interface ShikiCodeBlockProps {
  language: string
  code: string
  highlight: boolean
}

const htmlCache = new Map<string, string>()

export const ShikiCodeBlock: React.FC<ShikiCodeBlockProps> = ({ language, code, highlight }) => {
  const normalizedLang = language || 'text'
  const cacheKey = `${normalizedLang}::${code}`
  const [html, setHtml] = useState<string | null>(() => htmlCache.get(cacheKey) ?? null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!highlight) return
    let cancelled = false
    const cached = htmlCache.get(cacheKey)
    if (cached) {
      setHtml(cached)
      return
    }

    const timer = setTimeout(() => {
      codeToHtml(code, {
        lang: normalizedLang in bundledLanguages ? normalizedLang : 'plaintext',
        themes: {
          light: 'github-light',
          dark: 'github-dark'
        },
        defaultColor: false
      })
        .then((rendered) => {
          if (cancelled) return
          htmlCache.set(cacheKey, rendered)
          setHtml(rendered)
        })
    }, 16)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cacheKey, code, normalizedLang, highlight])

  const handleCopy = (): void => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="code-block-wrapper" data-language={normalizedLang}>
      <div className="code-block-header" data-anchor-skip>
        <span>{normalizedLang}</span>
        <button type="button" className="code-copy-btn" onClick={handleCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <div className="code-block-scroll">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  )
}
