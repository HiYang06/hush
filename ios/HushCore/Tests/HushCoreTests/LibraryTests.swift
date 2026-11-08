import Foundation
import GRDB
import Testing
@testable import HushCore

@Test func listsMainSessionsByProjectNewestFirst() throws {
    let db = try HushDatabase.inMemory()
    try db.write { db in
        try db.execute(sql: """
            INSERT INTO projects (id, name, sort_order, created_at, updated_at) VALUES ('p2', '线代', 1, 1, 1), ('p1', '概率', 0, 2, 2);
            INSERT INTO sessions (id, kind, project_id, title, created_at, updated_at) VALUES
              ('a', 'main', NULL, '旧', 1, 10), ('b', 'main', NULL, '新', 1, 20), ('c', 'main', 'p1', '在 project 里', 1, 30);
            INSERT INTO messages (id, session_id, seq, role, status, created_at) VALUES ('m', 'b', 1, 'assistant', 'done', 1);
            INSERT INTO sessions (id, kind, parent_session_id, anchor_message_id, context_mode, title, created_at, updated_at)
              VALUES ('t', 'thread', 'b', 'm', 'fork', '追问', 1, 40);
            """)
    }
    #expect(try db.read(Library.projects).map(\.name) == ["概率", "线代"])
    #expect(try db.read { try Library.sessions($0, projectId: nil) }.map(\.id) == ["b", "a"])
    #expect(try db.read { try Library.sessions($0, projectId: "p1") }.map(\.id) == ["c"])
}

@Test func groupsByTheSameCutOffsAsTheDesktop() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
    let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 31, hour: 9))!
    let hour: Int64 = 3600 * 1000
    let nowMs = Int64(now.timeIntervalSince1970 * 1000)
    let at = { (id: String, ago: Int64) in SessionItem(id: id, title: id, updatedAt: nowMs - ago * hour) }
    let groups = groupByTime([at("昨晚", 10), at("刚才", 1), at("上周", 24 * 6), at("上个月", 24 * 30)], now: now, calendar: calendar)
    #expect(groups.map(\.label) == ["今天", "昨天", "7 天内", "更早"])
    #expect(groups.map { $0.sessions.map(\.id) } == [["刚才"], ["昨晚"], ["上周"], ["上个月"]])
}

@Test func aConversationIsTheDesktopsShapes() throws {
    let db = try HushDatabase.inMemory()
    try db.write { db in
        try db.execute(sql: """
            INSERT INTO sessions (id, kind, title, created_at, updated_at) VALUES ('s', 'main', '', 1, 1), ('other', 'main', '', 1, 1);
            INSERT INTO messages (id, session_id, seq, role, content, attachments, status, web, created_at) VALUES
              ('q', 's', 2, 'user', '问', '[{"type":"file","fileId":"f"}]', 'done', NULL, 1),
              ('a', 's', 3, 'assistant', '答', '[]', 'done', '{"steps":[],"sources":[]}', 2),
              ('x', 'other', 1, 'assistant', '别处', '[]', 'done', NULL, 3);
            INSERT INTO marks (id, session_id, message_id, quote, start_offset, end_offset, prefix, suffix, category_id, created_at)
              VALUES ('k', 's', 'a', '答', 0, 1, '', '', 'cat-quote', 1), ('k2', 'other', 'x', '别', 0, 1, '', '', NULL, 1);
            INSERT INTO sessions (id, kind, parent_session_id, anchor_message_id, anchor_quote, anchor_start, anchor_end,
              anchor_prefix, anchor_suffix, context_mode, title, created_at, updated_at)
              VALUES ('t', 'thread', 's', 'a', '答', 0, 1, '', '', 'fork', '追问', 1, 1);
            INSERT INTO files (id, sha256, name, mime, size, path, created_at) VALUES
              ('f', 'abc', '图.PNG', 'image/png', 3, 'abc.png', 1), ('unused', 'def', 'x.pdf', 'application/pdf', 3, 'def.pdf', 1);
            INSERT INTO notes (id, scope, scope_id, content, updated_at) VALUES ('n', 'session', 's', '收录', 1);
            """)
    }
    let json = try db.read { try Library.conversationJSON($0, sessionId: "s") }
    let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    #expect(object["anchorQuote"] is NSNull)
    let parsed = object.compactMapValues { $0 as? [[String: Any]] }
    #expect(parsed["messages"]!.map { $0["id"] as! String } == ["q", "a"])
    #expect((parsed["messages"]![0]["attachments"] as! [[String: String]])[0]["fileId"] == "f")
    #expect(parsed["messages"]![0]["web"] is NSNull)
    #expect(parsed["messages"]![1]["web"] is [String: Any])
    #expect(parsed["marks"]!.map { $0["id"] as! String } == ["k"])
    #expect(parsed["threads"]!.map { $0["anchorQuote"] as! String } == ["答"])
    #expect(parsed["categories"]!.count == 3)
    #expect(parsed["files"]!.map { $0["id"] as! String } == ["f"])
    #expect(object["note"] as? String == "收录")
    #expect(try db.read { try Library.file($0, id: "f") }?.storedPath == "abc/图.PNG")
    #expect(try db.read { try Library.mark($0, id: "k") }?.categoryName != nil)
    #expect(try db.read { try Library.session($0, containingMessage: "x") }?.id == "other")
    let thread = try db.read { try Library.conversationJSON($0, sessionId: "t") }
    let threadObject = try JSONSerialization.jsonObject(with: Data(thread.utf8)) as! [String: Any]
    #expect(threadObject["anchorQuote"] as? String == "答")
    // A thread's clips are in its main session's note.
    #expect(threadObject["note"] as? String == "收录")
}

@Test func marksAreListedInReadingOrderWithThreadsAfterTheirAnchor() throws {
    let db = try HushDatabase.inMemory()
    try db.write { db in
        try db.execute(sql: """
            INSERT INTO sessions (id, kind, title, created_at, updated_at) VALUES ('s', 'main', '', 1, 1);
            INSERT INTO messages (id, session_id, seq, role, status, created_at) VALUES
              ('a1', 's', 2, 'assistant', 'done', 1), ('a2', 's', 4, 'assistant', 'done', 1);
            INSERT INTO sessions (id, kind, parent_session_id, anchor_message_id, context_mode, title, created_at, updated_at)
              VALUES ('t', 'thread', 's', 'a1', 'fork', '', 1, 1);
            INSERT INTO messages (id, session_id, seq, role, status, created_at) VALUES ('ta', 't', 2, 'assistant', 'done', 1);
            INSERT INTO marks (id, session_id, message_id, quote, start_offset, end_offset, prefix, suffix, created_at) VALUES
              ('later', 's', 'a2', 'x', 0, 1, '', '', 1), ('inThread', 's', 'ta', 'x', 0, 1, '', '', 2),
              ('second', 's', 'a1', 'x', 9, 10, '', '', 3), ('first', 's', 'a1', 'x', 1, 2, '', '', 4);
            """)
    }
    let marks = try db.read { try Library.marks($0, mainSessionId: "s") }
    #expect(marks.map(\.id) == ["first", "second", "inThread", "later"])
    #expect(marks.map(\.inThread) == [false, false, true, false])
    #expect(marks[2].sessionId == "t")
}

@Test func aSessionsNoteIsItsProjectsOrItsOwn() throws {
    let db = try HushDatabase.inMemory()
    try db.write { db in
        try db.execute(sql: """
            INSERT INTO projects (id, name, sort_order, created_at, updated_at) VALUES ('p', '概率', 0, 1, 1);
            INSERT INTO sessions (id, kind, project_id, title, created_at, updated_at) VALUES
              ('alone', 'main', NULL, '', 1, 1), ('inProject', 'main', 'p', '', 1, 1);
            INSERT INTO messages (id, session_id, seq, role, status, created_at) VALUES ('m', 'inProject', 1, 'assistant', 'done', 1);
            INSERT INTO sessions (id, kind, parent_session_id, anchor_message_id, context_mode, title, created_at, updated_at)
              VALUES ('t', 'thread', 'inProject', 'm', 'fork', '', 1, 1);
            INSERT INTO notes (id, scope, scope_id, content, updated_at) VALUES ('n', 'project', 'p', '笔记', 1);
            """)
    }
    let project = NoteTarget(scope: "project", scopeId: "p")
    #expect(try db.read { try Library.noteTarget($0, sessionId: "alone") } == NoteTarget(scope: "session", scopeId: "alone"))
    #expect(try db.read { try Library.noteTarget($0, sessionId: "inProject") } == project)
    #expect(try db.read { try Library.noteTarget($0, sessionId: "t") } == project)
    #expect(try db.read { try Library.note($0, project) } == "笔记")
    #expect(try db.read { try Library.note($0, .global) } == "")
    #expect(try db.read { try Library.noteTarget($0, noteId: "n") } == project)
    #expect(try db.read { try Library.noteTitle($0, project) } == "Project Note · 概率")
}
