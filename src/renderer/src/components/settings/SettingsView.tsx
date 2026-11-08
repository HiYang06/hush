import React, { useEffect, useState } from 'react'
import type {
  Model,
  ModelPatch,
  Provider,
  ProviderInput,
  RemoteModel
} from '@shared/types'
import { lookupModel, needsReview } from '@shared/modelCatalog'
import { syncNeedsLook, useAppStore } from '@renderer/stores/appStore'
import { ChevronRightIcon, PlusIcon } from '@renderer/components/common/Icons'
import { errorText } from '@renderer/lib/errors'
import { formatTokens, parseTokens } from '@renderer/lib/tokens'
import { isWindows } from '@renderer/lib/platform'
import { formatAccelerator } from '@renderer/lib/shortcut'
import { AccountSettings } from './AccountSettings'
import { SearchSettings } from './SearchSettings'
import { ReadingSettings } from './ReadingSettings'
import { MiniSettings } from './MiniSettings'
import { ProviderConnect } from './ProviderConnect'
import { MODEL_HINTS, NO_CAPABILITIES, protocolInfo } from './providerSetup'

const CAPABILITY_LABELS: { key: 'supportsVision' | 'supportsThinking'; label: string }[] = [
  { key: 'supportsVision', label: '视觉' },
  { key: 'supportsThinking', label: '思考' }
]

export const SettingsView: React.FC = () => {
  const closeSettings = useAppStore((s) => s.closeSettings)
  const providers = useAppStore((s) => s.providers)
  const models = useAppStore((s) => s.models)
  const searchServices = useAppStore((s) => s.searchServices)
  const syncStatus = useAppStore((s) => s.syncStatus)
  const fontSize = useAppStore((s) => s.fontSize)
  // Opened from the dot on the settings button: straight to what it's about.
  const [selected, setSelected] = useState<string | 'new' | 'account' | 'search' | 'prompt' | 'reading' | 'mini' | null>(() =>
    useAppStore.getState().settingsSection ?? (syncNeedsLook(useAppStore.getState().syncStatus) ? 'account' : null)
  )
  const [prompts, setPrompts] = useState<{ prompt: string } | null>(null)
  const [miniShortcut, setMiniShortcut] = useState<string | null>(null)

  const current = providers.find((p) => p.id === selected)
  const showNewForm =
    selected === 'new' ||
    (providers.length === 0 && !current && selected !== 'account' && selected !== 'search' && selected !== 'prompt' && selected !== 'reading' && selected !== 'mini')
  const searchCount = searchServices.filter((s) => s.hasApiKey).length

  useEffect(() => {
    void window.api.invoke('globalPrompt:get').then(setPrompts)
    void window.api.invoke('miniSettings:get').then((s) => setMiniShortcut(s.shortcut))
  }, [])

  useEffect(() => {
    if (selected === null && providers.length > 0) setSelected(providers[0].id)
  }, [providers, selected])

  return (
    <>
      <aside className="left-sidebar">
        <div className="sidebar-traffic-spacer drag-region" />
        <div className="sidebar-top-actions no-drag">
          <button type="button" className="sidebar-action-btn" onClick={closeSettings}>
            <span className="sidebar-action-left">
              <span className="sidebar-action-icon settings-back-icon">
                <ChevronRightIcon size={13} />
              </span>
              <span>返回对话</span>
            </span>
            <span className="sidebar-shortcut">Esc</span>
          </button>
        </div>

        <div className="sidebar-scroll no-drag">
          <div className="sidebar-group-label">账号</div>
          <button
            type="button"
            className={`session-item-btn settings-nav-item ${selected === 'account' ? 'active' : ''}`}
            onClick={() => setSelected('account')}
          >
            <span className="settings-nav-name">账号与同步</span>
            <span className="settings-nav-meta settings-truncate">{syncStatus?.email ?? '未登录'}</span>
          </button>

          <div className="sidebar-group-label">服务商</div>
          {providers.map((p) => {
            const count = models.filter((m) => m.providerId === p.id).length
            return (
              <button
                key={p.id}
                type="button"
                className={`session-item-btn settings-nav-item ${p.id === selected ? 'active' : ''}`}
                onClick={() => setSelected(p.id)}
              >
                <span className="settings-nav-name">{p.name}</span>
                <span className="settings-nav-meta">
                  {p.hasApiKey ? `${count} 个模型` : '未填 key'}
                </span>
              </button>
            )
          })}
          <button
            type="button"
            className={`session-item-btn settings-nav-add ${showNewForm ? 'active' : ''}`}
            onClick={() => setSelected('new')}
          >
            <PlusIcon size={11} />
            <span>添加服务商</span>
          </button>

          <div className="sidebar-group-label">联网</div>
          <button
            type="button"
            className={`session-item-btn settings-nav-item ${selected === 'search' ? 'active' : ''}`}
            onClick={() => setSelected('search')}
          >
            <span className="settings-nav-name">联网搜索</span>
            <span className="settings-nav-meta">{searchCount > 0 ? `${searchCount} 个服务` : '未设置'}</span>
          </button>

          <div className="sidebar-group-label">对话</div>
          <button
            type="button"
            className={`session-item-btn settings-nav-item ${selected === 'prompt' ? 'active' : ''}`}
            onClick={() => setSelected('prompt')}
          >
            <span className="settings-nav-name">全局提示词</span>
            <span className="settings-nav-meta">{prompts?.prompt.trim() ? '已设置' : '未设置'}</span>
          </button>

          <div className="sidebar-group-label">阅读</div>
          <button
            type="button"
            className={`session-item-btn settings-nav-item ${selected === 'reading' ? 'active' : ''}`}
            onClick={() => setSelected('reading')}
          >
            <span className="settings-nav-name">阅读排版</span>
            <span className="settings-nav-meta">{fontSize}px</span>
          </button>

          <div className="sidebar-group-label">通用</div>
          <button
            type="button"
            className={`session-item-btn settings-nav-item ${selected === 'mini' ? 'active' : ''}`}
            onClick={() => setSelected('mini')}
          >
            <span className="settings-nav-name">小窗提问</span>
            <span className="settings-nav-meta">{miniShortcut && formatAccelerator(miniShortcut, !isWindows)}</span>
          </button>
        </div>
      </aside>

      <main className="center-column">
        <div className="settings-drag drag-region" />
        <div className="settings-scroll">
          <div className="settings-page">
            {selected === 'account' ? (
              <AccountSettings />
            ) : selected === 'search' ? (
              <SearchSettings />
            ) : selected === 'prompt' ? (
              prompts && (
                <GlobalPromptSettings
                  {...prompts}
                  onSaved={(prompt) => setPrompts({ ...prompts, prompt })}
                />
              )
            ) : selected === 'reading' ? (
              <ReadingSettings />
            ) : selected === 'mini' ? (
              <MiniSettings onChanged={setMiniShortcut} />
            ) : showNewForm ? (
              <NewProviderForm onCreated={(id) => setSelected(id)} />
            ) : current ? (
              <ProviderDetail
                key={current.id}
                provider={current}
                onDeleted={() => setSelected(null)}
              />
            ) : null}
          </div>
        </div>
      </main>
    </>
  )
}

const GlobalPromptSettings: React.FC<{
  prompt: string
  onSaved: (prompt: string) => void
}> = ({ prompt: saved, onSaved }) => {
  const [prompt, setPrompt] = useState(saved)
  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">全局提示词</h1>
          <p className="settings-subtitle">所有对话和追问都用它；project 填了自己的提示词时，那个 project 改用自己的。</p>
        </div>
      </header>
      <Group title="提示词">
        <textarea
          className="project-prompt-input"
          value={prompt}
          placeholder="例如：你是一个耐心的学习伙伴，回答准确、清楚，先给结论再解释"
          aria-label="全局提示词"
          onChange={(e) => setPrompt(e.target.value)}
          onBlur={() => {
            if (prompt.trim() === saved.trim()) return
            void window.api.invoke('globalPrompt:set', prompt).then(() => onSaved(prompt.trim() ? prompt : ''))
          }}
        />
      </Group>
      <p className="settings-muted project-prompt-hint">留空时不带提示词。几份提示词只取一份，不会拼在一起。</p>
    </>
  )
}

export const Group: React.FC<{ title: string; actions?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  actions,
  children
}) => (
  <section className="settings-group">
    <div className="settings-group-head">
      <h2 className="settings-group-title">{title}</h2>
      {actions && <div className="settings-group-actions">{actions}</div>}
    </div>
    <div className="settings-group-body">{children}</div>
  </section>
)

export const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="settings-row">
    <span className="settings-row-label">{label}</span>
    <div className="settings-row-value">{children}</div>
  </div>
)

export const Check: React.FC<{
  checked: boolean
  label: string
  hint?: string
  onChange: (checked: boolean) => void
}> = ({ checked, label, hint, onChange }) => (
  <label className="settings-check">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>
      {label}
      {hint && <span className="settings-field-hint">{hint}</span>}
    </span>
  </label>
)

const NewProviderForm: React.FC<{ onCreated: (id: string) => void }> = ({ onCreated }) => {
  const reloadProviders = useAppStore((s) => s.reloadProviders)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (input: ProviderInput): Promise<void> => {
    setBusy(true)
    try {
      const provider = await window.api.invoke('providers:create', input)
      await reloadProviders()
      onCreated(provider.id)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">添加服务商</h1>
          <p className="settings-subtitle">选一家，贴上 key。中转站和别的兼容服务选「其他兼容服务」。</p>
        </div>
      </header>
      <ProviderConnect busy={busy} error={error} submitLabel="添加服务商" onSubmit={create} />
    </>
  )
}

type ConnectionState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'ok'; models: RemoteModel[] }
  | { status: 'error'; message: string }

const ProviderDetail: React.FC<{ provider: Provider; onDeleted: () => void }> = ({
  provider,
  onDeleted
}) => {
  const reloadProviders = useAppStore((s) => s.reloadProviders)
  const allModels = useAppStore((s) => s.models)
  const models = allModels.filter((m) => m.providerId === provider.id)
  const [name, setName] = useState(provider.name)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl)
  const [editingKey, setEditingKey] = useState(!provider.hasApiKey)
  const signedIn = useAppStore((s) => s.syncStatus?.email != null)
  const [apiKey, setApiKey] = useState('')
  const [connection, setConnection] = useState<ConnectionState>({ status: 'idle' })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      setError(null)
      await action()
      await reloadProviders()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const saveField = (patch: { name?: string; baseUrl?: string; apiKey?: string }): Promise<void> =>
    run(() => window.api.invoke('providers:update', provider.id, patch))

  const checkConnection = async (): Promise<RemoteModel[] | null> => {
    setConnection({ status: 'checking' })
    try {
      const remote = await window.api.invoke('providers:fetchModels', provider.id)
      setConnection({ status: 'ok', models: remote })
      return remote
    } catch (err) {
      setConnection({ status: 'error', message: errorText(err) })
      return null
    }
  }

  const saveKey = async (): Promise<void> => {
    if (!apiKey.trim()) return
    await saveField({ apiKey: apiKey.trim() })
    setApiKey('')
    setEditingKey(false)
    await checkConnection()
  }

  const openPicker = async (): Promise<void> => {
    setManualOpen(false)
    if (connection.status !== 'ok' && !(await checkConnection())) return
    setPickerOpen(true)
  }

  // Just added from the connect form: go straight to picking models.
  useEffect(() => {
    if (models.length === 0 && provider.hasApiKey) void openPicker()
  }, [])

  const addModels = (toAdd: RemoteModel[]): Promise<void> =>
    run(async () => {
      for (const m of toAdd) {
        await window.api.invoke('models:add', provider.id, {
          modelName: m.modelName,
          displayName: m.displayName,
          ...(m.capabilities ?? NO_CAPABILITIES),
          contextWindow: m.contextWindow,
          maxOutputTokens: m.maxOutputTokens
        })
      }
    })

  const setAllCapabilities = (on: boolean): Promise<void> =>
    run(async () => {
      for (const m of models) {
        await window.api.invoke('models:update', m.id, {
          supportsVision: on,
          supportsThinking: on
        })
      }
    })

  const deleteProvider = async (): Promise<void> => {
    if (!window.confirm(`删除「${provider.name}」和它下面的 ${models.length} 个模型？`)) return
    await run(() => window.api.invoke('providers:delete', provider.id))
    onDeleted()
  }

  const addedNames = new Set(models.map((m) => m.modelName))
  const notAdded =
    connection.status === 'ok'
      ? connection.models.filter((m) => !addedNames.has(m.modelName))
      : []

  return (
    <>
      <header className="settings-header">
        <div className="settings-header-text">
          <input
            className="settings-title settings-title-input"
            value={name}
            aria-label="服务商名称"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              if (name.trim() && name !== provider.name) saveField({ name: name.trim() })
              else setName(provider.name)
            }}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && e.currentTarget.blur()}
          />
          <p className="settings-subtitle">{protocolInfo(provider.protocol).label} 协议</p>
        </div>
        <ConnectionBadge
          state={connection}
          hasKey={provider.hasApiKey}
          onCheck={checkConnection}
        />
      </header>

      <Group title="连接">
        <Row label="地址">
          <input
            className="settings-inline-input"
            value={baseUrl}
            spellCheck={false}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() =>
              baseUrl.trim() &&
              baseUrl !== provider.baseUrl &&
              saveField({ baseUrl: baseUrl.trim() })
            }
          />
        </Row>
        <Row label="API key">
          {editingKey ? (
            <div className="settings-key-edit">
              <input
                className="settings-inline-input"
                type="password"
                value={apiKey}
                autoFocus={provider.hasApiKey}
                placeholder="粘贴服务商提供的 key"
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveKey()
                  if (e.key === 'Escape' && provider.hasApiKey) {
                    e.stopPropagation()
                    setEditingKey(false)
                  }
                }}
              />
              <button
                type="button"
                className="settings-link"
                disabled={!apiKey.trim()}
                onClick={saveKey}
              >
                保存
              </button>
              {provider.hasApiKey && (
                <button type="button" className="settings-link" onClick={() => setEditingKey(false)}>
                  取消
                </button>
              )}
            </div>
          ) : (
            <div className="settings-key-saved">
              <span className="settings-key-dots" aria-label="已保存">
                ••••••••••••
              </span>
              <span className="settings-muted">已加密保存在本机</span>
              <button type="button" className="settings-link" onClick={() => setEditingKey(true)}>
                更换
              </button>
            </div>
          )}
        </Row>
      </Group>
      {!provider.hasApiKey && signedIn && (
        <p className="settings-muted project-prompt-hint">key 不会同步，每台设备要各自填写。</p>
      )}
      {connection.status === 'error' && (
        <p className="settings-message error">{connection.message}</p>
      )}

      <Group
        title={models.length > 0 ? `模型 ${models.length}` : '模型'}
        actions={
          <>
            <button
              type="button"
              className="settings-link"
              disabled={connection.status === 'checking'}
              onClick={openPicker}
            >
              从服务商添加
            </button>
            <button
              type="button"
              className="settings-link"
              onClick={() => {
                setPickerOpen(false)
                setManualOpen(true)
              }}
            >
              手动添加
            </button>
          </>
        }
      >
        {pickerOpen && connection.status === 'ok' && (
          <RemoteModelPicker
            models={notAdded}
            onAdd={async (picked) => {
              await addModels(picked)
              setPickerOpen(false)
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}
        {manualOpen && (
          <ManualModelAdd
            isAdded={(id) => addedNames.has(id)}
            onAdd={async (id) => {
              await addModels([manualModel(id)])
              setManualOpen(false)
            }}
            onClose={() => setManualOpen(false)}
          />
        )}

        {models.length === 0 ? (
          !pickerOpen &&
          !manualOpen && (
            <div className="settings-empty">
              还没有模型。点「从服务商添加」挑选，服务商不提供列表时用「手动添加」。
            </div>
          )
        ) : (
          <>
            <div className="settings-model-grid settings-model-head" aria-hidden="true">
              <span>名称</span>
              <span>能力</span>
              <span className="num">上下文</span>
              <span className="num">最大输出</span>
              <span />
            </div>
            {models.map((m) => (
              <ModelRow
                key={m.id}
                model={m}
                expanded={expandedModelId === m.id}
                onToggle={() => setExpandedModelId((id) => (id === m.id ? null : m.id))}
                onChange={run}
              />
            ))}
          </>
        )}
      </Group>
      {models.length > 1 && (
        <div className="settings-under-group">
          <span className="settings-muted">能力</span>
          <button type="button" className="settings-link" onClick={() => setAllCapabilities(true)}>
            全部勾选
          </button>
          <button type="button" className="settings-link" onClick={() => setAllCapabilities(false)}>
            全部取消
          </button>
        </div>
      )}

      {error && <p className="settings-message error">{error}</p>}

      <div className="settings-danger">
        <button type="button" className="settings-delete" onClick={deleteProvider}>
          删除这个服务商
        </button>
      </div>
    </>
  )
}

const ConnectionBadge: React.FC<{
  state: ConnectionState
  hasKey: boolean
  onCheck: () => void
}> = ({ state, hasKey, onCheck }) => {
  const [tone, text] =
    state.status === 'checking'
      ? ['pending', '正在检查…']
      : state.status === 'ok'
        ? ['ok', '已连接']
        : state.status === 'error'
          ? ['error', '连接失败']
          : hasKey
            ? ['idle', '未检查']
            : ['idle', '未填 key']

  return (
    <div className="settings-connection">
      <span className={`settings-connection-state ${tone}`}>
        <span className="settings-dot" aria-hidden="true" />
        {text}
      </span>
      <button
        type="button"
        className="settings-btn"
        disabled={!hasKey || state.status === 'checking'}
        onClick={onCheck}
      >
        检查连接
      </button>
    </div>
  )
}

const RemoteModelPicker: React.FC<{
  models: RemoteModel[]
  onAdd: (models: RemoteModel[]) => Promise<void>
  onClose: () => void
}> = ({ models, onAdd, onClose }) => {
  const [checked, setChecked] = useState<Set<string>>(new Set())

  const toggle = (name: string, on: boolean): void => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(name)
      else next.delete(name)
      return next
    })
  }

  return (
    <div className="settings-inset">
      <div className="settings-inset-head">
        <span>
          {models.length > 0
            ? `服务商还有 ${models.length} 个模型没添加`
            : '服务商提供的模型都已经添加了'}
        </span>
        {models.length > 1 && (
          <button
            type="button"
            className="settings-link"
            onClick={() =>
              setChecked(
                checked.size === models.length ? new Set() : new Set(models.map((m) => m.modelName))
              )
            }
          >
            {checked.size === models.length ? '全不选' : '全选'}
          </button>
        )}
      </div>
      {models.length > 0 && (
        <ul className="settings-picker-list">
          {models.map((m) => (
            <li key={m.modelName} className="settings-model-grid settings-picker-row">
              <Check
                checked={checked.has(m.modelName)}
                label={m.displayName}
                onChange={(on) => toggle(m.modelName, on)}
              />
              <span className="settings-muted settings-truncate">
                {m.displayName !== m.modelName ? m.modelName : ''}
              </span>
              <span className="num settings-muted">{formatTokens(m.contextWindow)}</span>
              <span className="num settings-muted">{formatTokens(m.maxOutputTokens)}</span>
              <span />
            </li>
          ))}
        </ul>
      )}
      <div className="settings-inset-actions">
        <button type="button" className="settings-link" onClick={onClose}>
          {models.length > 0 ? '取消' : '收起'}
        </button>
        {models.length > 0 && (
          <button
            type="button"
            className="settings-btn primary"
            disabled={checked.size === 0}
            onClick={() => onAdd(models.filter((m) => checked.has(m.modelName)))}
          >
            {checked.size > 0 ? `添加 ${checked.size} 个模型` : '添加模型'}
          </button>
        )}
      </div>
    </div>
  )
}

export function manualModel(id: string): RemoteModel {
  const known = lookupModel(id)
  return {
    modelName: id,
    displayName: id,
    capabilities: known?.capabilities ?? null,
    contextWindow: known?.contextWindow ?? null,
    maxOutputTokens: known?.maxOutputTokens ?? null
  }
}

const ManualModelAdd: React.FC<{
  isAdded: (id: string) => boolean
  onAdd: (id: string) => Promise<void>
  onClose: () => void
}> = ({ isAdded, onAdd, onClose }) => {
  const [value, setValue] = useState('')
  const id = value.trim()
  const duplicate = id !== '' && isAdded(id)

  return (
    <div className="settings-inset">
      <div className="settings-inset-head">
        <span>输入服务商文档里的模型 id。认得的模型会自动填好参数，其余的添加后再填。</span>
      </div>
      <input
        className="settings-input"
        value={value}
        autoFocus
        spellCheck={false}
        placeholder="例如 deepseek-v4-pro"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && id && !duplicate) onAdd(id)
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      />
      <div className="settings-inset-actions">
        {duplicate && <span className="settings-message error">这个模型已经添加过了</span>}
        <button type="button" className="settings-link" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="settings-btn primary"
          disabled={!id || duplicate}
          onClick={() => onAdd(id)}
        >
          添加
        </button>
      </div>
    </div>
  )
}

export const TokenInput: React.FC<{
  value: number | null
  placeholder: string
  onSave: (value: number | null) => void
}> = ({ value, placeholder, onSave }) => {
  const [text, setText] = useState(value === null ? '' : value.toLocaleString('en-US'))
  const parsed = parseTokens(text)

  return (
    <span className="settings-token-input">
      <input
        className={`settings-input ${parsed === 'invalid' ? 'invalid' : ''}`}
        value={text}
        inputMode="numeric"
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (parsed === 'invalid') return
          setText(parsed === null ? '' : parsed.toLocaleString('en-US'))
          if (parsed !== value) onSave(parsed)
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <span className="settings-muted">tokens</span>
    </span>
  )
}

const ModelRow: React.FC<{
  model: Model
  expanded: boolean
  onToggle: () => void
  onChange: (action: () => Promise<unknown>) => Promise<void>
}> = ({ model, expanded, onToggle, onChange }) => {
  const [displayName, setDisplayName] = useState(model.displayName)
  const update = (patch: ModelPatch): Promise<void> =>
    onChange(() => window.api.invoke('models:update', model.id, patch))

  const caps = CAPABILITY_LABELS.filter(({ key }) => model[key])

  return (
    <div className={`settings-model ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="settings-model-grid settings-model-summary"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="settings-model-name">
          <span className="settings-truncate">{model.displayName}</span>
          {model.displayName !== model.modelName && (
            <span className="settings-model-id settings-truncate">{model.modelName}</span>
          )}
        </span>
        <span className="settings-tags">
          {needsReview(model) ? (
            <span className="settings-tag review">待确认</span>
          ) : caps.length > 0 ? (
            caps.map(({ key, label }) => (
              <span key={key} className="settings-tag">
                {label}
              </span>
            ))
          ) : (
            <span className="settings-muted">仅文字</span>
          )}
        </span>
        <span className="num">{formatTokens(model.contextWindow)}</span>
        <span className="num">{formatTokens(model.maxOutputTokens)}</span>
        <ChevronRightIcon size={12} expanded={expanded} className="settings-model-chevron" />
      </button>

      {expanded && (
        <div className="settings-model-detail">
          <div className="settings-detail-grid">
            <span className="settings-row-label">显示名称</span>
            <input
              className="settings-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={() => {
                if (displayName.trim() && displayName !== model.displayName) {
                  update({ displayName: displayName.trim() })
                } else setDisplayName(model.displayName)
              }}
            />

            <span className="settings-row-label">上下文窗口</span>
            <div className="settings-field">
              <TokenInput
                value={model.contextWindow}
                placeholder="未知"
                onSave={(contextWindow) => update({ contextWindow })}
              />
              <span className="settings-field-hint">{MODEL_HINTS.contextWindow}</span>
            </div>

            <span className="settings-row-label">最大输出</span>
            <div className="settings-field">
              <TokenInput
                value={model.maxOutputTokens}
                placeholder="未知，使用默认值"
                onSave={(maxOutputTokens) => update({ maxOutputTokens })}
              />
              <span className="settings-field-hint">{MODEL_HINTS.maxOutputTokens}</span>
            </div>

            <span className="settings-row-label">能力</span>
            <div className="settings-checks with-hints">
              {CAPABILITY_LABELS.map(({ key, label }) => (
                <Check
                  key={key}
                  checked={model[key]}
                  label={label}
                  hint={MODEL_HINTS[key]}
                  onChange={(on) => update({ [key]: on })}
                />
              ))}
              {model.supportsThinking && (
                <Check
                  checked={model.thinkingCanDisable}
                  label="可以关闭思考"
                  hint={MODEL_HINTS.thinkingCanDisable}
                  onChange={(on) => update({ thinkingCanDisable: on })}
                />
              )}
              <Check
                checked={model.supportsTools}
                label="工具调用"
                hint={MODEL_HINTS.supportsTools}
                onChange={(on) => update({ supportsTools: on })}
              />
            </div>
          </div>
          <div className="settings-detail-foot">
            <button
              type="button"
              className="settings-delete"
              onClick={() => onChange(() => window.api.invoke('models:delete', model.id))}
            >
              删除这个模型
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
