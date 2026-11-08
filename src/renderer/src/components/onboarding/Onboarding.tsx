import React, { useState } from 'react'
import type { ProviderInput, RemoteModel } from '@shared/types'
import { lookupModel, needsReview } from '@shared/modelCatalog'
import { useAppStore } from '@renderer/stores/appStore'
import { errorText } from '@renderer/lib/errors'
import { formatTokens } from '@renderer/lib/tokens'
import { Check, Group, TokenInput, manualModel } from '@renderer/components/settings/SettingsView'
import { ProviderConnect } from '@renderer/components/settings/ProviderConnect'
import { SERVICES, ServiceRow } from '@renderer/components/settings/SearchSettings'
import { MODEL_HINTS, NO_CAPABILITIES } from '@renderer/components/settings/providerSetup'

const STEPS = ['连接服务商', '选模型', '联网搜索']

// First run, no provider yet: connect one, pick models, optionally set up search (D-080).
export const Onboarding: React.FC = () => {
  const setOnboardingOpen = useAppStore((s) => s.setOnboardingOpen)
  const [step, setStep] = useState(0)
  const [remote, setRemote] = useState<RemoteModel[]>([])
  const [providerId, setProviderId] = useState<string | null>(null)

  return (
    <main className="center-column onboarding">
      <div className="onboarding-head drag-region">
        <ol className="onboarding-steps">
          {STEPS.map((label, i) => (
            <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''}>
              <span className="onboarding-step-no">{i < step ? '✓' : i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
        <button type="button" className="settings-link onboarding-skip no-drag" onClick={() => setOnboardingOpen(false)}>
          先跳过
        </button>
      </div>
      <div className="settings-scroll">
        <div className="settings-page onboarding-page">
          {step === 0 && (
            <ConnectStep
              providerId={providerId}
              onConnected={(id, models) => {
                setProviderId(id)
                setRemote(models)
                setStep(1)
              }}
            />
          )}
          {step === 1 && providerId && (
            <ModelsStep providerId={providerId} remote={remote} onBack={() => setStep(0)} onDone={() => setStep(2)} />
          )}
          {step === 2 && <SearchStep onDone={() => setOnboardingOpen(false)} />}
        </div>
      </div>
    </main>
  )
}

const ConnectStep: React.FC<{
  providerId: string | null
  onConnected: (providerId: string, models: RemoteModel[]) => void
}> = ({ providerId, onConnected }) => {
  const reloadProviders = useAppStore((s) => s.reloadProviders)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Created but its model list didn't load: the key may be fine and the list unsupported.
  const [unlisted, setUnlisted] = useState<string | null>(null)

  const connect = async (input: ProviderInput): Promise<void> => {
    setBusy(true)
    setError(null)
    setUnlisted(null)
    try {
      // The protocol can't change on an existing provider, so a retry replaces it.
      const previous = unlisted ?? providerId
      if (previous) await window.api.invoke('providers:delete', previous)
      const provider = await window.api.invoke('providers:create', input)
      await reloadProviders()
      try {
        onConnected(provider.id, await window.api.invoke('providers:fetchModels', provider.id))
      } catch (err) {
        setUnlisted(provider.id)
        setError(errorText(err))
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">欢迎使用 Hush</h1>
          <p className="settings-subtitle">
            先接上一个模型服务商。Hush 用你自己的 API key 直接连服务商，key 只存在这台电脑上。
          </p>
        </div>
      </header>
      <ProviderConnect
        busy={busy}
        error={error}
        submitLabel="连接"
        onPresetChange={() => setError(null)}
        onSubmit={connect}
        extraAction={
          // A rejected key won't work for chat either; only a missing list is worth going around.
          unlisted &&
          !/（40[13]）/.test(error ?? '') && (
            <button type="button" className="settings-link" onClick={() => onConnected(unlisted, [])}>
              不用列表，手动输入模型
            </button>
          )
        }
      />
    </>
  )
}

type Edit = Partial<Pick<RemoteModel, 'maxOutputTokens'>> & { supportsVision?: boolean; supportsThinking?: boolean }

// Known models first: they're the ones most people came for.
function sortModels(models: RemoteModel[]): RemoteModel[] {
  const known = (m: RemoteModel): number => (m.capabilities || lookupModel(m.modelName) ? 0 : 1)
  return [...models].sort((a, b) => known(a) - known(b) || a.modelName.localeCompare(b.modelName))
}

const ModelsStep: React.FC<{
  providerId: string
  remote: RemoteModel[]
  onBack: () => void
  onDone: () => void
}> = ({ providerId, remote, onBack, onDone }) => {
  const reloadProviders = useAppStore((s) => s.reloadProviders)
  const [models, setModels] = useState(() => sortModels(remote))
  const [checked, setChecked] = useState<string[]>([])
  const [edits, setEdits] = useState<Record<string, Edit>>({})
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (name: string, on: boolean): void =>
    setChecked((prev) => (on ? [...prev, name] : prev.filter((n) => n !== name)))
  const edit = (name: string, patch: Edit): void =>
    setEdits((prev) => ({ ...prev, [name]: { ...prev[name], ...patch } }))

  const effective = (m: RemoteModel): RemoteModel => {
    const e = edits[m.modelName] ?? {}
    const caps = m.capabilities ?? NO_CAPABILITIES
    return {
      ...m,
      maxOutputTokens: e.maxOutputTokens !== undefined ? e.maxOutputTokens : m.maxOutputTokens,
      capabilities: {
        ...caps,
        supportsVision: e.supportsVision ?? caps.supportsVision,
        supportsThinking: e.supportsThinking ?? caps.supportsThinking
      }
    }
  }

  const addManual = (): void => {
    const id = manual.trim()
    if (!id) return
    if (!models.some((m) => m.modelName === id)) setModels((prev) => [manualModel(id), ...prev])
    if (!checked.includes(id)) toggle(id, true)
    setManual('')
  }

  const add = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      let first: string | null = null
      for (const name of checked) {
        const m = effective(models.find((x) => x.modelName === name)!)
        const added = await window.api.invoke('models:add', providerId, {
          modelName: m.modelName,
          displayName: m.displayName,
          ...m.capabilities!,
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens
        })
        first ??= added.id
      }
      await reloadProviders()
      if (first) useAppStore.setState({ selectedModelId: first })
      onDone()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const q = query.trim().toLowerCase()
  const shown = q ? models.filter((m) => m.modelName.toLowerCase().includes(q)) : models

  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">选几个模型</h1>
          <p className="settings-subtitle">
            认得的模型已经填好参数。标着「待确认」的，勾上后补一下最大输出和能力；拿不准可以先不填，以后在设置里改。
          </p>
        </div>
      </header>

      {models.length > 12 && (
        <input
          className="settings-input onboarding-search"
          value={query}
          placeholder={`在 ${models.length} 个模型里搜索`}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      <Group title={checked.length > 0 ? `已选 ${checked.length} 个` : '模型'}>
        {shown.length === 0 && (
          <div className="settings-empty">{models.length === 0 ? '在下面输入模型 id 添加。' : '没有匹配的模型。'}</div>
        )}
        {shown.map((original) => {
          const m = effective(original)
          const on = checked.includes(m.modelName)
          const review = needsReview(m)
          const caps = m.capabilities!
          return (
            <div key={m.modelName} className={`onboarding-model ${on ? 'checked' : ''}`}>
              <div className="onboarding-model-row">
                <Check checked={on} label={m.modelName} onChange={(next) => toggle(m.modelName, next)} />
                <span className="settings-tags">
                  {review ? (
                    <span className="settings-tag review">待确认</span>
                  ) : (
                    <>
                      {caps.supportsVision && <span className="settings-tag">视觉</span>}
                      {caps.supportsThinking && <span className="settings-tag">思考</span>}
                      {m.maxOutputTokens !== null && (
                        <span className="settings-muted">输出 {formatTokens(m.maxOutputTokens)}</span>
                      )}
                    </>
                  )}
                </span>
              </div>
              {on && needsReview(original) && (
                <div className="settings-detail-grid onboarding-model-edit">
                  <span className="settings-row-label">最大输出</span>
                  <div className="settings-field">
                    <TokenInput
                      value={m.maxOutputTokens}
                      placeholder="未知，使用默认值"
                      onSave={(maxOutputTokens) => edit(m.modelName, { maxOutputTokens })}
                    />
                    <span className="settings-field-hint">{MODEL_HINTS.maxOutputTokens}</span>
                  </div>
                  <span className="settings-row-label">能力</span>
                  <div className="settings-checks with-hints">
                    <Check
                      checked={caps.supportsVision}
                      label="视觉"
                      hint={MODEL_HINTS.supportsVision}
                      onChange={(v) => edit(m.modelName, { supportsVision: v })}
                    />
                    <Check
                      checked={caps.supportsThinking}
                      label="思考"
                      hint={MODEL_HINTS.supportsThinking}
                      onChange={(v) => edit(m.modelName, { supportsThinking: v })}
                    />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </Group>

      <div className="onboarding-manual">
        <input
          className="settings-input"
          value={manual}
          spellCheck={false}
          placeholder="列表里没有？输入模型 id，例如 deepseek-v4-pro"
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && addManual()}
        />
        <button type="button" className="settings-link" disabled={!manual.trim()} onClick={addManual}>
          添加
        </button>
      </div>

      <div className="settings-footer-actions">
        {error && <span className="settings-message error">{error}</span>}
        <button type="button" className="settings-link" onClick={onBack}>
          上一步
        </button>
        <button type="button" className="settings-btn primary" disabled={busy || checked.length === 0} onClick={add}>
          {checked.length > 0 ? `添加 ${checked.length} 个模型，下一步` : '至少选一个模型'}
        </button>
      </div>
    </>
  )
}

const SearchStep: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const services = useAppStore((s) => s.searchServices)
  const [showExa, setShowExa] = useState(false)
  const hasSearch = services.some((s) => s.hasApiKey)
  const [tavily, exa] = SERVICES

  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">联网搜索</h1>
          <p className="settings-subtitle">
            打开后，问到新闻、版本、价格这类会变的事，模型会先搜一下再回答。需要一个搜索服务的 key，可以以后再填。
          </p>
        </div>
      </header>
      <Group title="搜索服务">
        <ServiceRow info={tavily} service={services.find((s) => s.id === tavily.id) ?? { id: tavily.id, hasApiKey: false }} />
        {showExa && (
          <ServiceRow info={exa} service={services.find((s) => s.id === exa.id) ?? { id: exa.id, hasApiKey: false }} />
        )}
      </Group>
      {!showExa && (
        <button type="button" className="settings-link onboarding-more" onClick={() => setShowExa(true)}>
          也可以用 Exa
        </button>
      )}
      <div className="settings-footer-actions">
        <button type="button" className="settings-btn primary" onClick={onDone}>
          {hasSearch ? '完成，开始对话' : '跳过，开始对话'}
        </button>
      </div>
    </>
  )
}
