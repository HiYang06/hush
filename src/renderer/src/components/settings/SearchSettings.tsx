import React, { useState } from 'react'
import type { SearchService, SearchServiceId } from '@shared/types'
import { useAppStore } from '@renderer/stores/appStore'
import { errorText } from '@renderer/lib/errors'
import { Group, Row } from './SettingsView'

// Free tiers as listed on each pricing page (2026-11).
export const SERVICES: { id: SearchServiceId; name: string; site: string; note: string }[] = [
  { id: 'tavily', name: 'Tavily', site: 'https://app.tavily.com', note: '网页搜索，每条结果给出最相关的几段原文。每月免费 1000 次' },
  { id: 'exa', name: 'Exa', site: 'https://dashboard.exa.ai/api-keys', note: '按语义检索，讲概念、找文章更准。每月有 10 美元免费额度' }
]

type TestState = { status: 'idle' | 'checking' | 'ok' } | { status: 'error'; message: string }

export const SearchSettings: React.FC = () => {
  const services = useAppStore((s) => s.searchServices)
  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">联网搜索</h1>
          <p className="settings-subtitle">
            填好至少一个，输入框旁的「联网」才能打开。填了几个就同时用几个搜，结果合在一起交给模型。
          </p>
        </div>
      </header>
      <Group title="搜索服务">
        {SERVICES.map((info) => (
          <ServiceRow
            key={info.id}
            info={info}
            service={services.find((s) => s.id === info.id) ?? { id: info.id, hasApiKey: false }}
          />
        ))}
      </Group>
    </>
  )
}

export const ServiceRow: React.FC<{ info: (typeof SERVICES)[number]; service: SearchService }> = ({ info, service }) => {
  const [editing, setEditing] = useState(!service.hasApiKey)
  const [apiKey, setApiKey] = useState('')
  const [test, setTest] = useState<TestState>({ status: 'idle' })

  const setKey = async (key: string): Promise<void> => {
    const services = await window.api.invoke('searchServices:setKey', info.id, key)
    useAppStore.setState({ searchServices: services })
  }

  const runTest = async (): Promise<void> => {
    setTest({ status: 'checking' })
    try {
      await window.api.invoke('searchServices:test', info.id)
      setTest({ status: 'ok' })
    } catch (err) {
      setTest({ status: 'error', message: errorText(err) })
    }
  }

  const save = async (): Promise<void> => {
    if (!apiKey.trim()) return
    await setKey(apiKey.trim())
    setApiKey('')
    setEditing(false)
    await runTest()
  }

  return (
    <div className="settings-service">
      <Row label={info.name}>
        {editing ? (
          <div className="settings-key-edit">
            <input
              className="settings-inline-input"
              type="password"
              value={apiKey}
              autoFocus={service.hasApiKey}
              placeholder={`粘贴 ${info.name} 的 key`}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape' && service.hasApiKey) {
                  e.stopPropagation()
                  setEditing(false)
                }
              }}
            />
            <button type="button" className="settings-link" disabled={!apiKey.trim()} onClick={save}>
              保存
            </button>
            {service.hasApiKey ? (
              <button type="button" className="settings-link" onClick={() => setEditing(false)}>
                取消
              </button>
            ) : (
              <button type="button" className="settings-link" onClick={() => window.api.invoke('links:open', info.site)}>
                去申请
              </button>
            )}
          </div>
        ) : (
          <div className="settings-key-saved">
            <span className="settings-key-dots" aria-label="已保存">
              ••••••••••••
            </span>
            <span className="settings-muted">
              {test.status === 'checking' ? '测试中…' : test.status === 'ok' ? '可以使用' : '已加密保存在本机'}
            </span>
            <button type="button" className="settings-link" disabled={test.status === 'checking'} onClick={runTest}>
              测试
            </button>
            <button type="button" className="settings-link" onClick={() => setEditing(true)}>
              更换
            </button>
            <button
              type="button"
              className="settings-link"
              onClick={async () => {
                await setKey('')
                setTest({ status: 'idle' })
                setEditing(true)
              }}
            >
              移除
            </button>
          </div>
        )}
      </Row>
      {test.status === 'error' ? (
        <p className="settings-service-note error">{test.message}</p>
      ) : (
        <p className="settings-service-note">{info.note}</p>
      )}
    </div>
  )
}
