import Foundation
import GRDB

// Mirrors src/shared/sync.ts.

public let syncTables = [
    "projects", "sessions", "messages", "marks", "mark_categories", "notes",
    "note_revisions", "files", "providers", "models", "settings",
]

/// A column value as the desktop reads it from SQLite: text, integer, real or null.
public enum SyncValue: Sendable, Equatable, Decodable {
    case null
    case int(Int64)
    case double(Double)
    case text(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Int64.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else { self = .text(try c.decode(String.self)) }
    }

    var databaseValue: DatabaseValue {
        switch self {
        case .null: .null
        case .int(let v): v.databaseValue
        case .double(let v): v.databaseValue
        case .text(let v): v.databaseValue
        }
    }
}

public typealias RowData = [String: SyncValue]

/// One row as the server holds it. A deleted row is a tombstone: data is null.
public struct SyncRow: Sendable, Decodable {
    public var tbl: String
    public var rowId: String
    public var seq: Int64
    public var deleted: Bool
    public var data: RowData?

    public init(tbl: String, rowId: String, seq: Int64, deleted: Bool, data: RowData?) {
        self.tbl = tbl
        self.rowId = rowId
        self.seq = seq
        self.deleted = deleted
        self.data = data
    }
}

public struct PullResponse: Sendable, Decodable {
    public var rows: [SyncRow]
    public var cursor: Int64
    public var more: Bool
}

public struct AuthResponse: Sendable, Decodable {
    public var token: String
    public var email: String
}
