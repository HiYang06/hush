import Foundation
import GRDB

public enum HushDatabase {
    /// The database file of the app; WAL, like the desktop (src/main/db/index.ts).
    public static func open(path: String) throws -> DatabasePool {
        let pool = try DatabasePool(path: path)
        try migrate(pool)
        return pool
    }

    /// For tests.
    public static func inMemory() throws -> DatabaseQueue {
        let queue = try DatabaseQueue()
        try migrate(queue)
        return queue
    }

    static func migrate(_ writer: some DatabaseWriter) throws {
        let migrations = try migrationSQL()
        // Outside a transaction: user_version is read once, each migration then runs in its own.
        try writer.writeWithoutTransaction { db in
            let current = try Int.fetchOne(db, sql: "PRAGMA user_version")!
            if current > migrations.count {
                throw HushError.databaseTooNew(version: current, supported: migrations.count)
            }
            for version in stride(from: current + 1, through: migrations.count, by: 1) {
                try db.inTransaction {
                    try db.execute(sql: migrations[version - 1])
                    try db.execute(sql: "PRAGMA user_version = \(version)")
                    return .commit
                }
            }
        }
    }

    // Filenames start with a zero-padded number, so index i is migration version i + 1.
    static func migrationSQL() throws -> [String] {
        let dir = Bundle.module.url(forResource: "migrations", withExtension: nil)!
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "sql" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        return try files.map { try String(contentsOf: $0, encoding: .utf8) }
    }
}

public enum HushError: Error, Equatable {
    case databaseTooNew(version: Int, supported: Int)
    /// What arrived for an attachment isn't the file its name (its sha256) says.
    case fileMismatch(sha256: String)
}
