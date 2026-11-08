import Foundation
import GRDB
import HushCore
import Observation

enum SyncState: Equatable {
    case idle, syncing, offline, expired
    case failed(String)
}

@MainActor @Observable
final class AppModel {
    let db: DatabasePool
    private(set) var account: Account?
    private(set) var state: SyncState = .idle
    private(set) var lastSyncedAt: Date?
    private let baseURL: URL
    /// Attachments brought down so far (FileItem.storedPath).
    private let attachments = URL.applicationSupportDirectory.appending(path: "attachments")
    private var downloads: [String: Task<URL, Error>] = [:]

    init() {
        let dir = URL.applicationSupportDirectory
        try! FileManager.default.createDirectory(at: attachments, withIntermediateDirectories: true)
        db = try! HushDatabase.open(path: dir.appending(path: "hush.db").path)
        // HUSH_SYNC_URL points a dev build at a local server, like the desktop (src/main/index.ts).
        baseURL = URL(string: ProcessInfo.processInfo.environment["HUSH_SYNC_URL"] ?? "https://hush.evildentist.uk")!
        account = Keychain.load()
    }

    var privacyURL: URL { SyncClient(baseURL: baseURL).privacyURL }

    /// The dot on the account button, like the desktop's settings button (product.md §13).
    var needsLook: Bool {
        switch state {
        case .offline, .failed: true
        default: false
        }
    }

    func sendCode(email: String) async throws {
        try await SyncClient(baseURL: baseURL).sendCode(email: email)
    }

    func login(email: String, code: String) async throws {
        let auth = try await SyncClient(baseURL: baseURL).verify(email: email, code: code)
        let account = Account(email: auth.email, token: auth.token)
        // An expired sign-in keeps its mirror; another account mustn't see it.
        if let previous = self.account, previous.email != account.email { try clearMirror(db) }
        Keychain.save(account)
        self.account = account
        state = .idle
        await pull()
    }

    func logout() async {
        guard let account else { return }
        // Signing out works offline too; the server just keeps a token nobody holds any more.
        try? await SyncClient(baseURL: baseURL, token: account.token).logout()
        forget()
    }

    /// Unlike signing out, this needs the server: the cloud copy is what goes.
    func deleteAccount() async throws {
        guard let account else { return }
        try await SyncClient(baseURL: baseURL, token: account.token).deleteAccount()
        forget()
    }

    /// On launch, on coming to the foreground and on pull to refresh.
    func pull() async {
        guard let account, state != .syncing, state != .expired else { return }
        state = .syncing
        do {
            try await SyncClient(baseURL: baseURL, token: account.token).pull(into: db)
            state = .idle
            lastSyncedAt = .now
        } catch let error as SyncHTTPError {
            state = error.status == 401 ? .expired : .failed("服务器返回 \(error.status)")
        } catch is URLError {
            state = .offline
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    /// An attachment on this device, downloaded the first time it's needed (plan: 用到时才下载). A thumbnail
    /// and a tap on it can ask at once; they share one download.
    func attachment(_ id: String) async throws -> URL {
        guard let file = try await db.read({ try Library.file($0, id: id) }) else { throw URLError(.fileDoesNotExist) }
        let url = attachments.appending(path: file.storedPath)
        if FileManager.default.fileExists(atPath: url.path) { return url }
        if let running = downloads[file.sha256] { return try await running.value }
        guard let account else { throw SyncHTTPError(status: 401, code: "unauthorized") }
        let client = SyncClient(baseURL: baseURL, token: account.token)
        let download = Task {
            let data = try await client.download(sha256: file.sha256)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return url
        }
        downloads[file.sha256] = download
        defer { downloads[file.sha256] = nil }
        return try await download.value
    }

    /// Keeps a view's data current: the first value right away, then again after every write that touches it.
    func observe<T: Sendable>(_ fetch: @escaping @Sendable (Database) throws -> T, _ update: @MainActor (T) -> Void) async {
        do {
            for try await value in ValueObservation.tracking(fetch).values(in: db) { update(value) }
        } catch {
            // Only a broken query gets here, and every query is a fixed string.
            fatalError("Database observation failed: \(error)")
        }
    }

    private func forget() {
        Keychain.delete()
        account = nil
        state = .idle
        lastSyncedAt = nil
        // This device only mirrors the account (D-072), so nothing here is lost.
        try! clearMirror(db)
        try! FileManager.default.removeItem(at: attachments)
        try! FileManager.default.createDirectory(at: attachments, withIntermediateDirectories: true)
    }
}
