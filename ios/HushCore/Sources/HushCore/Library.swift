import Foundation
import GRDB

public struct ProjectItem: Identifiable, Hashable, Sendable, Decodable, FetchableRecord {
    public var id: String
    public var name: String
}

public struct SessionItem: Identifiable, Hashable, Sendable, Decodable, FetchableRecord {
    public var id: String
    public var title: String
    public var updatedAt: Int64
}

/// What the home and project pages list, ordered as the desktop's sidebar (repo/projects.ts, repo/sessions.ts).
public enum Library {
    public static func projects(_ db: Database) throws -> [ProjectItem] {
        try ProjectItem.fetchAll(db, sql: "SELECT id, name FROM projects ORDER BY sort_order, created_at")
    }

    /// Main sessions in a project, or those in none when projectId is nil. Threads are reached from their anchor.
    public static func sessions(_ db: Database, projectId: String?) throws -> [SessionItem] {
        try SessionItem.fetchAll(
            db,
            sql: """
                SELECT id, title, updated_at AS updatedAt FROM sessions
                WHERE kind = 'main' AND project_id IS ?
                ORDER BY updated_at DESC
                """,
            arguments: [projectId])
    }
}

extension Library {
    /// One session's reading, as JSON in the desktop's own shapes (src/shared/types.ts, repo/*.ts), so the
    /// web view hands it to the desktop's renderer unchanged: its messages, the marks and threads on them,
    /// the mark categories, the attachments' records, and the note its clips are in (for their underlines). Works for a main session and for a thread alike; a thread also carries
    /// the passage it asks about.
    public static func conversationJSON(_ db: Database, sessionId: String) throws -> String {
        let note = try noteTarget(db, sessionId: sessionId)
        return try String.fetchOne(
            db,
            sql: """
                WITH own AS (SELECT * FROM messages WHERE session_id = :id ORDER BY seq)
                SELECT json_object(
                  'anchorQuote', (SELECT anchor_quote FROM sessions WHERE id = :id),
                  'messages', (SELECT json_group_array(json_object(
                    'id', id, 'sessionId', session_id, 'seq', seq, 'role', role, 'content', content,
                    'thinking', thinking, 'thinkingMs', thinking_ms, 'attachments', json(attachments),
                    'status', status, 'error', error, 'errorKind', error_kind, 'providerId', provider_id,
                    'modelId', model_id, 'inputTokens', input_tokens, 'outputTokens', output_tokens,
                    'web', json(web), 'createdAt', created_at)) FROM own),
                  'marks', (SELECT json_group_array(json_object(
                    'id', id, 'sessionId', session_id, 'messageId', message_id, 'quote', quote,
                    'startOffset', start_offset, 'endOffset', end_offset, 'prefix', prefix, 'suffix', suffix,
                    'comment', comment, 'categoryId', category_id, 'createdAt', created_at))
                    FROM marks WHERE message_id IN (SELECT id FROM own)),
                  'threads', (SELECT json_group_array(json_object(
                    'id', id, 'kind', kind, 'projectId', project_id, 'parentSessionId', parent_session_id,
                    'anchorMessageId', anchor_message_id, 'anchorQuote', anchor_quote, 'anchorStart', anchor_start,
                    'anchorEnd', anchor_end, 'anchorPrefix', anchor_prefix, 'anchorSuffix', anchor_suffix,
                    'contextMode', context_mode, 'title', title, 'providerId', provider_id, 'modelId', model_id,
                    'createdAt', created_at, 'updatedAt', updated_at))
                    FROM sessions WHERE anchor_message_id IN (SELECT id FROM own) ORDER BY anchor_start),
                  'categories', (SELECT json_group_array(json_object(
                    'id', id, 'name', name, 'color', color, 'sortOrder', sort_order))
                    FROM mark_categories ORDER BY sort_order),
                  'files', (SELECT json_group_array(json_object(
                    'id', id, 'name', name, 'mime', mime, 'size', size, 'isScanned', is_scanned))
                    FROM files WHERE id IN (SELECT json_extract(a.value, '$.fileId') FROM own, json_each(own.attachments) a
                      WHERE json_extract(a.value, '$.type') = 'file')),
                  'note', (SELECT content FROM notes WHERE scope = :scope AND scope_id = :scopeId)
                )
                """,
            arguments: ["id": sessionId, "scope": note.scope, "scopeId": note.scopeId])!
    }

    /// The note a session's clips go to, as the desktop's sessionNoteTarget: its project's, or its own;
    /// a thread's are its main session's.
    public static func noteTarget(_ db: Database, sessionId: String) throws -> NoteTarget {
        let row = try Row.fetchOne(
            db,
            sql: """
                SELECT main.id, main.project_id FROM sessions s
                JOIN sessions main ON main.id = COALESCE(s.parent_session_id, s.id) WHERE s.id = ?
                """,
            arguments: [sessionId])!
        let projectId: String? = row["project_id"]
        return projectId.map { NoteTarget(scope: "project", scopeId: $0) } ?? NoteTarget(scope: "session", scopeId: row["id"])
    }

    /// Empty for a note never written: the desktop makes the row on first save.
    public static func note(_ db: Database, _ target: NoteTarget) throws -> String {
        try String.fetchOne(db, sql: "SELECT content FROM notes WHERE scope = ? AND scope_id = ?", arguments: [target.scope, target.scopeId]) ?? ""
    }

    /// Where a 笔记引用 card leads.
    public static func noteTarget(_ db: Database, noteId: String) throws -> NoteTarget? {
        try Row.fetchOne(db, sql: "SELECT scope, scope_id FROM notes WHERE id = ?", arguments: [noteId])
            .map { NoteTarget(scope: $0["scope"], scopeId: $0["scope_id"]) }
    }

    /// As the desktop's note header names it (NoteView.tsx).
    public static func noteTitle(_ db: Database, _ target: NoteTarget) throws -> String {
        switch target.scope {
        case "global": return "全局 Note"
        case "project":
            let name = try String.fetchOne(db, sql: "SELECT name FROM projects WHERE id = ?", arguments: [target.scopeId])
            return "Project Note · \(name ?? "")"
        default: return "会话 Note"
        }
    }

    public static func file(_ db: Database, id: String) throws -> FileItem? {
        try FileItem.fetchOne(db, sql: "SELECT id, sha256, name, mime FROM files WHERE id = ?", arguments: [id])
    }

    public static func session(_ db: Database, id: String) throws -> SessionItem? {
        try SessionItem.fetchOne(db, sql: "SELECT id, title, updated_at AS updatedAt FROM sessions WHERE id = ?", arguments: [id])
    }

    /// The session a hush://message/ link lands in.
    public static func session(_ db: Database, containingMessage messageId: String) throws -> SessionItem? {
        try SessionItem.fetchOne(
            db,
            sql: "SELECT s.id, s.title, s.updated_at AS updatedAt FROM sessions s JOIN messages m ON m.session_id = s.id WHERE m.id = ?",
            arguments: [messageId])
    }

    /// A main session's marks, its threads' included, in reading order: as RightPanel.tsx sorts them, a
    /// thread's marks come right after the main message the thread hangs from.
    public static func marks(_ db: Database, mainSessionId: String) throws -> [MarkItem] {
        try MarkItem.fetchAll(
            db,
            sql: """
                SELECT mk.id, mk.quote, mk.comment, c.name AS categoryName, c.color AS categoryColor,
                  msg.session_id AS sessionId, s.kind = 'thread' AS inThread
                FROM marks mk
                JOIN messages msg ON msg.id = mk.message_id
                JOIN sessions s ON s.id = msg.session_id
                LEFT JOIN messages anchor ON anchor.id = s.anchor_message_id
                LEFT JOIN mark_categories c ON c.id = mk.category_id
                WHERE mk.session_id = ?
                ORDER BY CASE WHEN s.kind = 'thread' THEN anchor.seq ELSE msg.seq END,
                  s.kind = 'thread', CASE WHEN s.kind = 'thread' THEN msg.seq ELSE 0 END, mk.start_offset
                """,
            arguments: [mainSessionId])
    }

    public static func mark(_ db: Database, id: String) throws -> MarkDetail? {
        try MarkDetail.fetchOne(
            db,
            sql: """
                SELECT m.id, m.quote, m.comment, c.name AS categoryName, c.color AS categoryColor
                FROM marks m LEFT JOIN mark_categories c ON c.id = m.category_id WHERE m.id = ?
                """,
            arguments: [id])
    }
}

/// What the card for a tapped mark shows.
public struct MarkDetail: Identifiable, Hashable, Sendable, Decodable, FetchableRecord {
    public var id: String
    public var quote: String
    public var comment: String?
    public var categoryName: String?
    public var categoryColor: String?
}

public struct MarkItem: Identifiable, Hashable, Sendable, Decodable, FetchableRecord {
    public var id: String
    public var quote: String
    public var comment: String?
    public var categoryName: String?
    public var categoryColor: String?
    /// Where the mark is read: the main session, or the thread it was made in.
    public var sessionId: String
    public var inThread: Bool
}

/// global / project / session, with the global note's scopeId 'global' (shared/types.ts NoteTarget).
public struct NoteTarget: Hashable, Sendable {
    public var scope: String
    public var scopeId: String

    public init(scope: String, scopeId: String) {
        self.scope = scope
        self.scopeId = scopeId
    }

    public static let global = NoteTarget(scope: "global", scopeId: "global")
}

public struct FileItem: Hashable, Sendable, Decodable, FetchableRecord {
    public var id: String
    public var sha256: String
    public var name: String
    public var mime: String

    /// Where it's kept under the attachments folder: a folder per content, like the desktop's, so a file
    /// is downloaded once; inside it the file keeps its own name, which Quick Look shows as the title.
    public var storedPath: String {
        let safe = name.replacingOccurrences(of: "/", with: "_")
        return "\(sha256)/\(safe.isEmpty || safe.hasPrefix(".") ? "file" + safe : safe)"
    }
}

public struct TimeGroup: Hashable, Sendable {
    public var label: String
    public var sessions: [SessionItem]
}

/// 今天 / 昨天 / 7 天内 / 更早, by when a session was last updated; same cut-offs as LeftSidebar.tsx.
public func groupByTime(_ sessions: [SessionItem], now: Date, calendar: Calendar = .current) -> [TimeGroup] {
    let day: Int64 = 24 * 3600 * 1000
    let today = Int64(calendar.startOfDay(for: now).timeIntervalSince1970 * 1000)
    let bounds: [(String, Int64)] = [("今天", today), ("昨天", today - day), ("7 天内", today - 7 * day), ("更早", .min)]
    var groups = bounds.map { TimeGroup(label: $0.0, sessions: []) }
    for session in sessions.sorted(by: { $0.updatedAt > $1.updatedAt }) {
        let index = bounds.firstIndex { session.updatedAt >= $0.1 }!
        groups[index].sessions.append(session)
    }
    return groups.filter { !$0.sessions.isEmpty }
}
