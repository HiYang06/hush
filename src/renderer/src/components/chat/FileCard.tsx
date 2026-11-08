import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { fileKind, fileUrl, formatSize, type FileKind } from '@shared/files'
import type { FileRecord } from '@shared/types'
import { useAppStore } from '@renderer/stores/appStore'

const KIND_LABEL: Record<Exclude<FileKind, 'image'>, string> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PPT',
  text: '文本'
}

export const Lightbox: React.FC<{ file: FileRecord; onClose: () => void }> = ({ file, onClose }) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Esc here only closes the picture, not the panels behind it.
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // Portaled out because .message-item's content-visibility contains fixed children to the message box.
  return createPortal(
    <div className="image-lightbox" onClick={onClose} role="dialog" aria-label={file.name}>
      <img src={fileUrl(file.id)} alt={file.name} />
    </div>,
    document.body
  )
}

interface FileCardProps {
  file: FileRecord
  onRemove?: () => void
}

export const FileCard: React.FC<FileCardProps> = ({ file, onRemove }) => {
  const openFilePreview = useAppStore((s) => s.openFilePreview)
  const kind = fileKind(file.mime)
  // Synced from another device and couldn't be downloaded; the preview says why and tries again.
  const [missing, setMissing] = useState(false)

  const remove = onRemove && (
    <button
      type="button"
      className="file-card-remove"
      aria-label={`移除 ${file.name}`}
      onClick={(e) => {
        e.stopPropagation()
        onRemove()
      }}
    >
      ×
    </button>
  )

  if (kind === 'image') {
    return (
      <div className="file-thumb" title={file.name} onClick={() => openFilePreview(file.id)}>
        {missing ? (
          <span className="file-thumb-missing">未下载</span>
        ) : (
          <img src={fileUrl(file.id)} alt={file.name} onError={() => setMissing(true)} />
        )}
        {remove}
      </div>
    )
  }

  const label = file.isScanned ? 'PDF · 扫描件' : KIND_LABEL[kind]
  return (
    <div
      className="file-card"
      title={file.name}
      onClick={() => openFilePreview(file.id)}
    >
      <span className="file-card-kind">{label}</span>
      <span className="file-card-body">
        <span className="file-card-name">{file.name}</span>
        <span className="file-card-meta">{formatSize(file.size)}</span>
      </span>
      {remove}
    </div>
  )
}

// Shown while a file is still being read, or when it could not be added.
export const PendingFileCard: React.FC<{ name: string; error: string | null; onRemove: () => void }> = ({
  name,
  error,
  onRemove
}) => (
  <div className={`file-card pending ${error ? 'failed' : ''}`} title={name}>
    <span className="file-card-body">
      <span className="file-card-name">{name}</span>
      <span className="file-card-meta">{error ?? '正在读取…'}</span>
    </span>
    <button type="button" className="file-card-remove" aria-label={`移除 ${name}`} onClick={onRemove}>
      ×
    </button>
  </div>
)
