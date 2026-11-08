import GRDB

// The pull side of src/main/sync/apply.ts and rows.ts. This app makes no changes of its own yet (D-072),
// so nothing here is ever dirty: no note merge, no conflict copies, the server's row always wins.

/// Must match the WHEN clause of the settings triggers in migration 008.
let syncedSettings = ["system_prompt"]

// rowid is each device's own (FTS uses it); the API key never leaves the device that typed it.
private let localOnly: [String: [String]] = ["messages": ["rowid"], "notes": ["rowid"], "providers": ["api_key_enc"]]

/// UNIQUE keys besides the primary key. Another device resolved a clash on these before pushing, so a
/// local row in the way is one the server already replaced; its delete can still be a page or a pull behind.
private let uniqueKeys: [String: [String]] = [
    "messages": ["session_id", "seq"],
    "models": ["provider_id", "model_name"],
    "files": ["sha256"],
]

func keyOf(_ tbl: String) -> String { tbl == "settings" ? "key" : "id" }

/// Writes one pull (all of its pages) in a single transaction. Rows arrive in server seq order, which
/// doesn't put parents first (a session edited later has a later seq than its messages), so foreign keys
/// are only checked at commit.
public func applyRemote(_ writer: some DatabaseWriter, rows: [SyncRow], cursor: Int64) throws {
    try writer.write { db in
        try db.execute(sql: "PRAGMA defer_foreign_keys = ON")
        // So the sync triggers of migration 008 don't record these rows as this device's changes.
        try db.execute(sql: "UPDATE sync_state SET applying = 1")
        for row in applyOrder(rows) { try applyRow(db, row) }
        try dropDanglingReferences(db)
        try db.execute(sql: "UPDATE sync_state SET applying = 0, pull_cursor = ?", arguments: [cursor])
    }
}

/// Signing out: this device only mirrors the account, so its copy goes and the next sign-in pulls from 0.
public func clearMirror(_ writer: some DatabaseWriter) throws {
    try writer.write { db in
        try db.execute(sql: "PRAGMA defer_foreign_keys = ON")
        try db.execute(sql: "UPDATE sync_state SET applying = 1")
        for tbl in syncTables + ["sync_dirty"] { try db.execute(sql: "DELETE FROM \(tbl)") }
        try db.execute(sql: "UPDATE sync_state SET applying = 0, pull_cursor = 0")
    }
}

public func pullCursor(_ db: Database) throws -> Int64 {
    try Int64.fetchOne(db, sql: "SELECT pull_cursor FROM sync_state")!
}

// Deletes first: regenerating a reply deletes it and writes a new one at the same seq. Messages by their
// place in the session, as the desktop does.
func applyOrder(_ rows: [SyncRow]) -> [SyncRow] {
    func sessionSeq(_ r: SyncRow) -> Int64 {
        guard r.tbl == "messages", case .int(let seq) = r.data?["seq"] else { return 0 }
        return seq
    }
    let kept = rows.filter { !$0.deleted }.enumerated().sorted {
        (sessionSeq($0.element), $0.offset) < (sessionSeq($1.element), $1.offset)
    }.map(\.element)
    return rows.filter(\.deleted) + kept
}

private func applyRow(_ db: Database, _ row: SyncRow) throws {
    guard syncTables.contains(row.tbl) else { return }
    if row.tbl == "settings" && !syncedSettings.contains(row.rowId) { return }
    // Migration 008 marks the built-in mark categories dirty; the server's copy is the later write.
    try db.execute(sql: "DELETE FROM sync_dirty WHERE tbl = ? AND row_id = ?", arguments: [row.tbl, row.rowId])
    guard !row.deleted, let data = row.data else {
        try db.execute(sql: "DELETE FROM \(row.tbl) WHERE \(keyOf(row.tbl)) = ?", arguments: [row.rowId])
        return
    }
    if let unique = uniqueKeys[row.tbl], unique.allSatisfy({ data[$0] != nil }) {
        let match = unique.map { "\($0) = ?" }.joined(separator: " AND ")
        let args = StatementArguments(unique.map { data[$0]!.databaseValue }) + [row.rowId]
        try db.execute(sql: "DELETE FROM \(row.tbl) WHERE \(match) AND id <> ?", arguments: args)
    }
    try writeRow(db, row.tbl, data)
}

// An upsert, never INSERT OR REPLACE: REPLACE deletes first, and the cascade would take the row's messages
// and marks with it. Columns this device doesn't have (a newer desktop's) are dropped; the table's own
// columns are also the whitelist for names arriving from the server, which end up in SQL text.
private func writeRow(_ db: Database, _ tbl: String, _ data: RowData) throws {
    let key = keyOf(tbl)
    let excluded = localOnly[tbl] ?? []
    let columns = try db.columns(in: tbl).map(\.name).filter { !excluded.contains($0) && data[$0] != nil }
    let updates = columns.filter { $0 != key }.map { "\($0) = excluded.\($0)" }
    let conflict = updates.isEmpty ? "NOTHING" : "UPDATE SET \(updates.joined(separator: ", "))"
    try db.execute(
        sql: """
            INSERT INTO \(tbl) (\(columns.joined(separator: ", "))) VALUES (\(columns.map { _ in "?" }.joined(separator: ", ")))
            ON CONFLICT (\(key)) DO \(conflict)
            """,
        arguments: StatementArguments(columns.map { data[$0]!.databaseValue }))
}

// A remote row can point at one whose delete arrived before it. The delete wins: the reference is cleared
// where the schema says SET NULL, otherwise the orphan goes too.
private func dropDanglingReferences(_ db: Database) throws {
    for v in try Row.fetchAll(db, sql: "PRAGMA foreign_key_check") {
        let table: String = v["table"], rowid: Int64 = v["rowid"], fkid: Int64 = v["fkid"]
        let fk = try Row.fetchAll(db, sql: "PRAGMA foreign_key_list(\(table))").first { ($0["id"] as Int64?) == fkid }!
        if (fk["on_delete"] as String?) == "SET NULL" {
            let column: String = fk["from"]
            try db.execute(sql: "UPDATE \(table) SET \(column) = NULL WHERE rowid = ?", arguments: [rowid])
        } else {
            try db.execute(sql: "DELETE FROM \(table) WHERE rowid = ?", arguments: [rowid])
        }
    }
}
