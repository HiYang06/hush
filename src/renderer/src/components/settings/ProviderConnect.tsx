import React, { useState } from 'react'
import type { ProviderInput, ProviderProtocol } from '@shared/types'
import { Group, Row } from './SettingsView'
import { OFFICIAL_PRESETS, PRESETS, PROTOCOLS, protocolInfo, type Preset } from './providerSetup'

const CUSTOM = 'custom'

// Pick a provider, paste a key. The caller decides what "connect" does: the wizard also fetches
// the model list, the settings page opens the new provider.
export const ProviderConnect: React.FC<{
  busy: boolean
  error: string | null
  submitLabel: string
  onPresetChange?: () => void
  onSubmit: (input: ProviderInput) => void
  extraAction?: React.ReactNode
}> = ({ busy, error, submitLabel, onPresetChange, onSubmit, extraAction }) => {
  const [presetId, setPresetId] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai_chat')
  const [baseUrl, setBaseUrl] = useState('')
  const [name, setName] = useState('')

  const preset: Preset | undefined = [...PRESETS, ...OFFICIAL_PRESETS].find((p) => p.id === presetId)
  const custom = presetId === CUSTOM

  const choose = (id: string): void => {
    if (id === presetId) return
    setPresetId(id)
    onPresetChange?.()
  }

  const submit = (): void => {
    if (preset) {
      onSubmit({ name: preset.name, protocol: preset.protocol, baseUrl: preset.baseUrl, apiKey: apiKey.trim() })
    } else if (custom) {
      onSubmit({
        name: name.trim() || protocolInfo(protocol).defaultName,
        protocol,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim()
      })
    }
  }

  const ready = !busy && apiKey.trim() !== '' && (preset !== undefined || (custom && baseUrl.trim() !== ''))

  return (
    <>
      <div className="connect-presets" role="radiogroup" aria-label="服务商">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === presetId}
            className={`connect-preset ${p.id === presetId ? 'selected' : ''}`}
            onClick={() => choose(p.id)}
          >
            {p.name}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          className={`connect-preset ${custom ? 'selected' : ''}`}
          onClick={() => choose(CUSTOM)}
        >
          其他兼容服务
          <span className="connect-preset-note">中转站、自己部署的</span>
        </button>
      </div>
      <div className="connect-official">
        <span>官方 API：</span>
        {OFFICIAL_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`settings-link ${p.id === presetId ? 'selected' : ''}`}
            aria-pressed={p.id === presetId}
            onClick={() => choose(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>

      {(preset || custom) && (
        <Group title={preset ? preset.name : '其他兼容服务'}>
          {custom && (
            <>
              <Row label="接口格式">
                <select
                  className="settings-inline-input"
                  value={protocol}
                  onChange={(e) => setProtocol(e.target.value as ProviderProtocol)}
                >
                  {PROTOCOLS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="地址">
                <input
                  className="settings-inline-input"
                  value={baseUrl}
                  spellCheck={false}
                  placeholder="服务商给的 base URL，例如 https://example.com/v1"
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </Row>
              <Row label="名称">
                <input
                  className="settings-inline-input"
                  value={name}
                  placeholder={protocolInfo(protocol).defaultName}
                  onChange={(e) => setName(e.target.value)}
                />
              </Row>
            </>
          )}
          <Row label="API key">
            <div className="settings-key-edit">
              <input
                className="settings-inline-input"
                type="password"
                value={apiKey}
                autoFocus
                placeholder="粘贴服务商提供的 key"
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && ready && submit()}
              />
              {preset && (
                <button
                  type="button"
                  className="settings-link"
                  onClick={() => window.api.invoke('links:open', preset.keyUrl)}
                >
                  去哪里拿 key ↗
                </button>
              )}
            </div>
          </Row>
        </Group>
      )}

      {(preset || custom) && (
        <div className="settings-footer-actions">
          {error && <span className="settings-message error">{error}</span>}
          {extraAction}
          <button type="button" className="settings-btn primary" disabled={!ready} onClick={submit}>
            {busy ? '正在连接…' : submitLabel}
          </button>
        </div>
      )}
    </>
  )
}
