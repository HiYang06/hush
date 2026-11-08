import React, { useEffect, useState } from 'react'
import type { SyncStatus } from '@shared/types'
import { formatSize } from '@shared/files'
import { useAppStore } from '@renderer/stores/appStore'
import { errorText } from '@renderer/lib/errors'
import { Group, Row } from './SettingsView'

const RESEND_SECONDS = 60

const PrivacyLink: React.FC<{ before: string }> = ({ before }) => (
  <p className="settings-muted project-prompt-hint">
    {before}
    <button type="button" className="settings-inline-link" onClick={() => window.api.invoke('account:openPrivacy')}>
      《隐私政策》
    </button>
  </p>
)

export const AccountSettings: React.FC = () => {
  const status = useAppStore((s) => s.syncStatus)

  // Opening the page is seeing its notices; ones that arrive while it's open are seen too.
  useEffect(() => {
    if (status?.unseen) void window.api.invoke('sync:markSeen').then((syncStatus) => useAppStore.setState({ syncStatus }))
  }, [status?.unseen])

  if (!status) return null
  return (
    <>
      <header className="settings-header">
        <div>
          <h1 className="settings-title">账号与同步</h1>
          <p className="settings-subtitle">
            登录后，会话、追问、mark 和 note 会在你的设备之间自动同步。API key 不同步，每台设备要各自填写。
          </p>
        </div>
      </header>
      {status.email && status.state !== 'expired' ? <SignedIn status={status} /> : <SignIn initialEmail={status.email} />}
    </>
  )
}

const SignIn: React.FC<{ initialEmail: string | null }> = ({ initialEmail }) => {
  const [email, setEmail] = useState(initialEmail ?? '')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [wait, setWait] = useState(0)

  useEffect(() => {
    if (wait <= 0) return
    const timer = setTimeout(() => setWait(wait - 1), 1000)
    return () => clearTimeout(timer)
  }, [wait])

  const attempt = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const sendCode = (): Promise<void> =>
    attempt(async () => {
      const address = email.trim()
      await window.api.invoke('account:sendCode', address)
      setSentTo(address)
      setCode('')
      setWait(RESEND_SECONDS)
    })

  const login = (): Promise<void> =>
    attempt(async () => {
      const syncStatus = await window.api.invoke('account:login', sentTo!, code.trim())
      useAppStore.setState({ syncStatus })
    })

  return (
    <>
      <Group title={initialEmail ? '登录已过期，请重新登录' : '登录'}>
        <Row label="邮箱">
          <div className="settings-key-edit">
            <input
              className="settings-inline-input"
              type="email"
              value={email}
              autoFocus={!initialEmail}
              placeholder="you@example.com"
              spellCheck={false}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && email.trim() && wait === 0 && sendCode()}
            />
            <button type="button" className="settings-link" disabled={busy || !email.trim() || wait > 0} onClick={sendCode}>
              {wait > 0 ? `${wait} 秒后可重发` : sentTo ? '重新发送' : '发送验证码'}
            </button>
          </div>
        </Row>
        {sentTo && (
          <Row label="验证码">
            <div className="settings-key-edit">
              <input
                className="settings-inline-input"
                value={code}
                autoFocus
                inputMode="numeric"
                maxLength={6}
                placeholder="邮件里的 6 位数字"
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && login()}
              />
              <button type="button" className="settings-link" disabled={busy || code.length !== 6} onClick={login}>
                登录
              </button>
            </div>
          </Row>
        )}
      </Group>
      {error ? (
        <p className="settings-message error">{error}</p>
      ) : (
        <p className="settings-message">
          {sentTo
            ? `验证码已发到 ${sentTo}，10 分钟内有效。没收到可以看看垃圾邮件。`
            : '不用设密码，每次登录用邮箱收一个验证码。这台设备上已有的内容会和账号里的合并，不会覆盖任何一边。'}
        </p>
      )}
      <PrivacyLink before="登录即表示同意" />
    </>
  )
}

function stateText(status: SyncStatus, now: number): string {
  switch (status.state) {
    case 'syncing':
      return '同步中…'
    case 'offline':
      return '离线，联网后自动同步'
    case 'expired':
      return '登录已过期，请重新登录'
    case 'failed':
      return `同步失败（${status.error}），稍后自动重试`
    case 'idle':
      return status.lastSyncedAt === null ? '等待同步' : `已同步 · ${ago(status.lastSyncedAt, now)}`
  }
}

function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const SignedIn: React.FC<{ status: SyncStatus }> = ({ status }) => {
  const [now, setNow] = useState(Date.now())
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const deleteAccount = async (): Promise<void> => {
    setDeleting(true)
    setDeleteError(null)
    try {
      useAppStore.setState({ syncStatus: await window.api.invoke('account:delete') })
    } catch (err) {
      setDeleteError(errorText(err))
      setDeleting(false)
    }
  }

  // Keeps 「刚刚」 and 「N 分钟前」 current while the page stays open.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <>
      <Group title="账号">
        <Row label="邮箱">
          <span className="settings-text">{status.email}</span>
        </Row>
        <Row label="同步">
          <div className="settings-key-saved">
            <span className={status.state === 'failed' ? 'settings-muted error' : 'settings-muted'}>
              {stateText(status, now)}
            </span>
            <button
              type="button"
              className="settings-link"
              disabled={status.state === 'syncing'}
              onClick={() => window.api.invoke('sync:now')}
            >
              立即同步
            </button>
          </div>
        </Row>
        {status.storage && (
          <Row label="附件空间">
            <span className="settings-text">
              {formatSize(status.storage.usage)} / {formatSize(status.storage.quota)}
            </span>
          </Row>
        )}
      </Group>

      {status.notices.length > 0 && (
        <Group title="提示">
          {status.notices.map((notice) => (
            <Row key={notice.id} label={ago(notice.at, now)}>
              <span className="settings-text">{notice.text}</span>
            </Row>
          ))}
        </Group>
      )}

      <div className="settings-danger">
        <div className="settings-danger-actions">
          <button
            type="button"
            className="settings-delete"
            onClick={async () => useAppStore.setState({ syncStatus: await window.api.invoke('account:logout') })}
          >
            退出登录
          </button>
          {!confirmingDelete && (
            <button type="button" className="settings-delete" onClick={() => setConfirmingDelete(true)}>
              注销账号
            </button>
          )}
        </div>
        {confirmingDelete ? (
          <div className="settings-delete-confirm">
            <p className="settings-text">会删除云端的所有会话、note 和附件，不能恢复；这台设备上的内容保留。</p>
            <div className="settings-danger-actions">
              <button type="button" className="settings-delete danger" disabled={deleting} onClick={deleteAccount}>
                {deleting ? '正在注销…' : '确认注销'}
              </button>
              <button
                type="button"
                className="settings-delete"
                disabled={deleting}
                onClick={() => {
                  setConfirmingDelete(false)
                  setDeleteError(null)
                }}
              >
                取消
              </button>
            </div>
            {deleteError && <p className="settings-message error">{deleteError}</p>}
          </div>
        ) : (
          <p className="settings-muted project-prompt-hint">退出后这台设备上的内容都还在，只是不再同步。</p>
        )}
        <PrivacyLink before="查看" />
      </div>
    </>
  )
}
