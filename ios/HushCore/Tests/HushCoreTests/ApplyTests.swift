import GRDB
import Testing
@testable import HushCore

private func row(_ tbl: String, _ data: RowData) -> SyncRow {
    let id = tbl == "settings" ? data["key"]! : data["id"]!
    guard case .text(let rowId) = id else { fatalError() }
    return SyncRow(tbl: tbl, rowId: rowId, seq: 0, deleted: false, data: data)
}
private func tombstone(_ tbl: String, _ id: String) -> SyncRow {
    return SyncRow(tbl: tbl, rowId: id, seq: 0, deleted: true, data: nil)
}

private func session(_ id: String, title: String = "") -> SyncRow {
    row("sessions", ["id": .text(id), "kind": .text("main"), "title": .text(title), "created_at": .int(1), "updated_at": .int(1)])
}
private func message(_ id: String, in session: String, seq: Int64, plain: String = "") -> SyncRow {
    row("messages", [
        "id": .text(id), "session_id": .text(session), "seq": .int(seq), "role": .text("assistant"),
        "content": .text(plain), "plain": .text(plain), "status": .text("done"), "created_at": .int(1),
    ])
}
private func mark(_ id: String, session: String, message: String, category: String? = nil) -> SyncRow {
    row("marks", [
        "id": .text(id), "session_id": .text(session), "message_id": .text(message), "quote": .text("q"),
        "start_offset": .int(0), "end_offset": .int(1), "prefix": .text(""), "suffix": .text(""),
        "category_id": category.map(SyncValue.text) ?? .null, "created_at": .int(1),
    ])
}

private func count(_ db: some DatabaseReader, _ sql: String) throws -> Int {
    try db.read { try Int.fetchOne($0, sql: sql)! }
}

@Test func migratesToLatestAndSearchesWithTrigrams() throws {
    let db = try HushDatabase.inMemory()
    #expect(try count(db, "PRAGMA user_version") == HushDatabase.migrationSQL().count)
    try applyRemote(db, rows: [session("s"), message("m", in: "s", seq: 1, plain: "矩阵的特征值和特征向量")], cursor: 2)
    #expect(try count(db, "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH '特征值'") == 1)
}

@Test func childrenBeforeParentsAndNothingRecordedAsLocal() throws {
    let db = try HushDatabase.inMemory()
    try applyRemote(db, rows: [message("m", in: "s", seq: 1), mark("k", session: "s", message: "m"), session("s")], cursor: 7)
    #expect(try count(db, "SELECT count(*) FROM marks") == 1)
    #expect(try count(db, "SELECT count(*) FROM sync_dirty WHERE tbl <> 'mark_categories'") == 0)
    #expect(try count(db, "SELECT applying FROM sync_state") == 0)
    #expect(try db.read(pullCursor) == 7)
}

@Test func updatingASessionKeepsItsMessages() throws {
    let db = try HushDatabase.inMemory()
    try applyRemote(db, rows: [session("s"), message("m", in: "s", seq: 1)], cursor: 2)
    try applyRemote(db, rows: [session("s", title: "新标题")], cursor: 3)
    #expect(try count(db, "SELECT count(*) FROM messages") == 1)
    #expect(try db.read { try String.fetchOne($0, sql: "SELECT title FROM sessions") } == "新标题")
}

@Test func tombstonesDeleteWithCascade() throws {
    let db = try HushDatabase.inMemory()
    try applyRemote(db, rows: [session("s"), message("m", in: "s", seq: 1), mark("k", session: "s", message: "m")], cursor: 3)
    try applyRemote(db, rows: [tombstone("sessions", "s")], cursor: 4)
    #expect(try count(db, "SELECT count(*) FROM messages") == 0)
    #expect(try count(db, "SELECT count(*) FROM marks") == 0)
}

@Test func unknownColumnsAndLocalSettingsAreDropped() throws {
    let db = try HushDatabase.inMemory()
    var newer = session("s")
    newer.data!["from_a_newer_desktop"] = .text("x")
    let local = row("settings", ["key": .text("sync_account"), "value": .text("{}")])
    let prompt = row("settings", ["key": .text("system_prompt"), "value": .text("简洁")])
    try applyRemote(db, rows: [newer, local, prompt], cursor: 3)
    #expect(try count(db, "SELECT count(*) FROM sessions") == 1)
    #expect(try db.read { try String.fetchAll($0, sql: "SELECT key FROM settings") } == ["system_prompt"])
}

@Test func aRegeneratedReplyReplacesTheOldOneAtItsSeq() throws {
    let db = try HushDatabase.inMemory()
    try applyRemote(db, rows: [session("s"), message("old", in: "s", seq: 1)], cursor: 2)
    // The old reply's tombstone hasn't arrived yet (a later page of another device's push).
    try applyRemote(db, rows: [message("new", in: "s", seq: 1)], cursor: 3)
    #expect(try db.read { try String.fetchAll($0, sql: "SELECT id FROM messages") } == ["new"])
}

@Test func danglingReferencesAreClearedOrDropped() throws {
    let db = try HushDatabase.inMemory()
    try applyRemote(db, rows: [session("s"), message("m", in: "s", seq: 1)], cursor: 2)
    try applyRemote(db, rows: [mark("k1", session: "s", message: "m", category: "gone"), mark("k2", session: "s", message: "gone")], cursor: 4)
    #expect(try db.read { try String.fetchAll($0, sql: "SELECT id FROM marks") } == ["k1"])
    #expect(try count(db, "SELECT count(*) FROM marks WHERE category_id IS NULL") == 1)
}

@Test func signingOutClearsTheMirror() throws {
    let db = try HushDatabase.inMemory()
    try applyRemote(db, rows: [session("s"), message("m", in: "s", seq: 1, plain: "特征值")], cursor: 2)
    try clearMirror(db)
    #expect(try count(db, "SELECT count(*) FROM sessions") == 0)
    #expect(try count(db, "SELECT count(*) FROM messages_fts WHERE messages_fts MATCH '特征值'") == 0)
    #expect(try count(db, "SELECT count(*) FROM sync_dirty") == 0)
    #expect(try db.read(pullCursor) == 0)
}

@Test func theServersBuiltInCategoriesAreNotLeftToPush() throws {
    let db = try HushDatabase.inMemory()
    #expect(try count(db, "SELECT count(*) FROM sync_dirty WHERE tbl = 'mark_categories'") == 3)
    let renamed = row("mark_categories", ["id": .text("cat-quote"), "name": .text("金句"), "color": .text("#888"), "sort_order": .int(2)])
    try applyRemote(db, rows: [renamed], cursor: 1)
    #expect(try db.read { try String.fetchAll($0, sql: "SELECT row_id FROM sync_dirty ORDER BY row_id") } == ["cat-knowledge", "cat-question"])
}
