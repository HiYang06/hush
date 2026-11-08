import React, { useEffect, useState } from 'react'
import type { NoteRevision, NoteRevisionReason, NoteTarget } from '@shared/types'
import { MarkdownContent } from '@renderer/components/chat/MarkdownContent'
import { useAppStore } from '@renderer/stores/appStore'

// A revision is the content from just before the write it names (D-014).
const REASON_LABEL: Record<NoteRevisionReason, string> = {
  ai_append: 'AI 整理追加之前',
  ai_rewrite: 'AI 重新整理之前',
  migrate_in: '移入内容之前',
  migrate_out: '移出内容之前',
  merge: '合并会话 note 之前',
  restore: '恢复旧版本之前',
  sync_conflict: '同步冲突时本机的版本'
}

const formatTime = (ms: number): string =>
  new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })

interface NoteHistoryProps {
  target: NoteTarget
  onClose: () => void
}

// Takes the note page's place: the list of versions, then one version's preview with a restore button.
export const NoteHistory: React.FC<NoteHistoryProps> = ({ target, onClose }) => {
  const [revisions, setRevisions] = useState<NoteRevision[] | null>(null)
  const [selected, setSelected] = useState<NoteRevision | null>(null)
  const restoreNoteRevision = useAppStore((s) => s.restoreNoteRevision)
  const jumpToMessage = useAppStore((s) => s.jumpToMessage)
  const { scope, scopeId } = target

  useEffect(() => {
    window.api.invoke('notes:revisions', { scope, scopeId }).then(setRevisions)
  }, [scope, scopeId])

  return (
    <div className="note-tab-container">
      <div className="note-toolbar">
        <button type="button" className="note-small-btn" onClick={() => (selected ? setSelected(null) : onClose())}>
          {selected ? '← 版本列表' : '← 返回 note'}
        </button>
        {selected && (
          <button
            type="button"
            className="note-small-btn"
            onClick={() => restoreNoteRevision(selected.id).then(onClose)}
          >
            恢复这个版本
          </button>
        )}
      </div>

      {selected ? (
        <div className="note-editor-scroll">
          <div className="note-history-caption">
            {formatTime(selected.createdAt)} · {REASON_LABEL[selected.reason]}
          </div>
          {selected.content.trim() ? (
            <MarkdownContent content={selected.content} onJumpToMessage={jumpToMessage} />
          ) : (
            <div className="note-empty-hint">这个版本是空的</div>
          )}
        </div>
      ) : (
        <div className="note-editor-scroll">
          {revisions?.length === 0 && (
            <div className="note-empty-hint">
              还没有历史版本。AI 整理、移入或移出内容、合并会话 note、恢复旧版本之前，都会自动存一个版本。
            </div>
          )}
          {revisions?.map((r) => (
            <button key={r.id} type="button" className="note-history-item" onClick={() => setSelected(r)}>
              <span>{formatTime(r.createdAt)}</span>
              <span className="note-history-reason">{REASON_LABEL[r.reason]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
