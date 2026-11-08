import CryptoKit
import Foundation
import GRDB

/// The server answered with an error; code is its { error } (unauthorized, too_soon, …).
public struct SyncHTTPError: Error, Equatable {
    public var status: Int
    public var code: String

    public init(status: Int, code: String) {
        self.status = status
        self.code = code
    }
}

/// The Hush server's API (server/src/app.ts), as src/main/sync/service.ts calls it.
public struct SyncClient: Sendable {
    public var baseURL: URL
    public var token: String?

    public init(baseURL: URL, token: String? = nil) {
        self.baseURL = baseURL
        self.token = token
    }

    public var privacyURL: URL { baseURL.appending(path: "privacy") }

    public func sendCode(email: String) async throws {
        _ = try await call("POST", "auth/start", body: ["email": email])
    }

    public func verify(email: String, code: String) async throws -> AuthResponse {
        try JSONDecoder().decode(AuthResponse.self, from: try await call("POST", "auth/verify", body: ["email": email, "code": code]))
    }

    public func logout() async throws {
        _ = try await call("POST", "auth/logout", body: [:])
    }

    public func deleteAccount() async throws {
        _ = try await call("DELETE", "account")
    }

    /// Pulls everything after this device's cursor and writes it; true when anything arrived.
    @discardableResult
    public func pull(into writer: some DatabaseWriter) async throws -> Bool {
        var cursor = try await writer.read(pullCursor)
        var rows: [SyncRow] = []
        while true {
            let data = try await call("GET", "sync/pull", query: [URLQueryItem(name: "since", value: String(cursor))])
            let page = try JSONDecoder().decode(PullResponse.self, from: data)
            rows += page.rows
            cursor = page.cursor
            if !page.more { break }
        }
        guard !rows.isEmpty else { return false }
        try applyRemote(writer, rows: rows, cursor: cursor)
        return true
    }

    /// An attachment's bytes, as src/main/sync/files.ts downloadFile: the server signs a short-lived
    /// storage URL, and what comes back must hash to the name it was asked for.
    public func download(sha256: String) async throws -> Data {
        let answer = try JSONDecoder().decode([String: String].self, from: try await call("GET", "files/\(sha256)/download"))
        let (data, response) = try await URLSession.shared.data(from: URL(string: answer["url"] ?? "")!)
        let status = (response as! HTTPURLResponse).statusCode
        guard status == 200 else { throw SyncHTTPError(status: status, code: "download_failed") }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard hash == sha256 else { throw HushError.fileMismatch(sha256: sha256) }
        return data
    }

    private func call(_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: String]? = nil) async throws -> Data {
        var request = URLRequest(url: baseURL.appending(path: path).appending(queryItems: query), timeoutInterval: 30)
        request.httpMethod = method
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as! HTTPURLResponse).statusCode
        guard status == 200 else {
            // nginx's own rate-limit answer is an HTML page, not the server's JSON.
            let code = (try? JSONDecoder().decode([String: String].self, from: data))?["error"] ?? ""
            throw SyncHTTPError(status: status, code: code)
        }
        return data
    }
}

/// What the server's error codes mean to the person signing in; same text as the desktop.
public func loginErrorText(_ error: Error) -> String {
    guard let error = error as? SyncHTTPError else { return "连不上同步服务器，请检查网络" }
    let known = [
        "bad_email": "邮箱格式不对",
        "too_soon": "刚发过验证码，请一分钟后再试",
        "code_wrong": "验证码不对",
        "code_expired": "验证码已过期，请重新发送",
        "too_many_attempts": "输错次数太多，请重新发送验证码",
        "email_daily_limit": "今天这个邮箱的验证码发得太多了，明天再试",
        "ip_daily_limit": "今天这个网络请求的验证码太多了，明天再试",
        "mail_daily_limit": "今天发送的验证码太多了，请明天再试",
    ]
    if let text = known[error.code] { return text }
    return error.status == 429 ? "请求太频繁，请稍后再试" : "服务器返回 \(error.status)"
}

/// Why an attachment couldn't be shown; same text as the desktop (sync/service.ts download).
public func downloadErrorText(_ error: Error) -> String {
    if error is URLError { return "这个附件还没下载到这台设备，联网后再试" }
    guard let error = error as? SyncHTTPError else { return "下载附件失败（\(error.localizedDescription)）" }
    switch error.status {
    case 404: return "这个附件还没从另一台设备传上来，可能是云端空间满了"
    case 401: return "登录已过期，重新登录后才能下载附件"
    default: return "下载附件失败（服务器返回 \(error.status)）"
    }
}
