import React from 'react'

interface IconProps {
  size?: number
  className?: string
}

export const SearchIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.45"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="7.2" cy="7.2" r="4.6" />
    <line x1="10.6" y1="10.6" x2="13.8" y2="13.8" />
  </svg>
)

export const PlusIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="8" y1="3.2" x2="8" y2="12.8" />
    <line x1="3.2" y1="8" x2="12.8" y2="8" />
  </svg>
)

export const BookmarkIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M4.2 2.5H11.8C12.2 2.5 12.5 2.8 12.5 3.2V13.6L8 10.6L3.5 13.6V3.2C3.5 2.8 3.8 2.5 4.2 2.5Z" />
  </svg>
)

export const NotePageIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M3.5 2.5H10.2L12.8 5.1V13.2C12.8 13.6 12.5 13.9 12.1 13.9H3.5C3.1 13.9 2.8 13.6 2.8 13.2V3.2C2.8 2.8 3.1 2.5 3.5 2.5Z" />
    <path d="M9.8 2.5V5.3H12.6" />
    <line x1="5.2" y1="8" x2="10.4" y2="8" />
    <line x1="5.2" y1="10.6" x2="8.8" y2="10.6" />
  </svg>
)

export const ThreadBranchIcon: React.FC<IconProps> = ({
  size = 14,
  className
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M4.5 3V9.5C4.5 11 5.7 12.2 7.2 12.2H12.2" />
    <path d="M9.8 9.8L12.4 12.2L9.8 14.6" />
    <circle cx="4.5" cy="3" r="1.3" fill="currentColor" stroke="none" />
  </svg>
)

export const SettingsSlidersIcon: React.FC<IconProps> = ({
  size = 15,
  className
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <line x1="2.5" y1="4.5" x2="13.5" y2="4.5" />
    <line x1="2.5" y1="11.5" x2="13.5" y2="11.5" />
    <circle cx="6" cy="4.5" r="1.8" fill="var(--bg-primary)" />
    <circle cx="10.2" cy="11.5" r="1.8" fill="var(--bg-primary)" />
  </svg>
)

export const UpdateArrowIcon: React.FC<IconProps> = ({ size = 15, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="6" />
    <path d="M8 11V5.2" />
    <path d="M5.6 7.4L8 5L10.4 7.4" />
  </svg>
)

export const ChevronRightIcon: React.FC<
  IconProps & { expanded?: boolean }
> = ({ size = 11, expanded = false, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={`ui-chevron-icon ${expanded ? 'expanded' : ''} ${className ?? ''}`}
    aria-hidden="true"
  >
    <path d="M4.2 2.6L7.8 6L4.2 9.4" />
  </svg>
)

export const HistoryClockIcon: React.FC<IconProps> = ({
  size = 13,
  className
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5.2V8.2L10.2 9.5" />
  </svg>
)

export const ExpandPanelIcon: React.FC<
  IconProps & { expanded?: boolean }
> = ({ size = 13, expanded = false, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {expanded ? (
      <>
        <path d="M6.8 9.2H3.2M6.8 9.2V12.8M6.8 9.2L2.8 13.2" />
        <path d="M9.2 6.8H12.8M9.2 6.8V3.2M9.2 6.8L13.2 2.8" />
      </>
    ) : (
      <>
        <path d="M9.8 2.8H13.2V6.2" />
        <path d="M13.2 2.8L9.2 6.8" />
        <path d="M6.2 13.2H2.8V9.8" />
        <path d="M2.8 13.2L6.8 9.2" />
      </>
    )}
  </svg>
)

// A panel with a chevron pushing it away: hides the right panel. Not an ×, which on Windows would sit
// next to the window's own close button (D-074).
export const CollapsePanelIcon: React.FC<IconProps> = ({ size = 13, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" />
    <path d="M9.8 2.8V13.2" />
    <path d="M5.2 6.2L7 8L5.2 9.8" />
  </svg>
)

export const SparkleOrganizeIcon: React.FC<IconProps> = ({
  size = 13,
  className
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M8 2.2L9.3 6.2L13.3 7.5L9.3 8.8L8 12.8L6.7 8.8L2.7 7.5L6.7 6.2L8 2.2Z" />
  </svg>
)

export const PaperclipIcon: React.FC<IconProps> = ({ size = 14, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.45"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M13.2 7.6L8.1 12.7a3.3 3.3 0 0 1-4.7-4.7l5.4-5.4a2.2 2.2 0 0 1 3.1 3.1L6.6 11a1.1 1.1 0 0 1-1.6-1.6l4.8-4.8" />
  </svg>
)

// Closed folder for a collapsed project, open folder when its sessions are showing.
export const FolderIcon: React.FC<IconProps & { open?: boolean }> = ({
  size = 14,
  className,
  open = false
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.35"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {open ? (
      <>
        <path d="M2.2 12.3V4.4a1 1 0 0 1 1-1h3l1.4 1.5h4.6a1 1 0 0 1 1 1v1.2" />
        <path d="M2.2 12.3l1.9-5a1 1 0 0 1 .9-.6h8.6a.6.6 0 0 1 .6.8l-1.7 4.5a1 1 0 0 1-.9.6H3.2" />
      </>
    ) : (
      <path d="M2.2 4.4a1 1 0 0 1 1-1h3l1.4 1.5h5.2a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z" />
    )}
  </svg>
)
