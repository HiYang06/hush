import SwiftUI
import HushCore

/// Same steps and wording as the desktop's 账号与同步 page (product.md §13).
struct LoginView: View {
    @Environment(AppModel.self) private var model
    @State private var email = ""
    @State private var code = ""
    @State private var codeSentAt: Date?
    @State private var error: String?
    @State private var busy = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("邮箱", text: $email)
                        .textContentType(.emailAddress)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        let wait = codeSentAt.map { 60 - Int(context.date.timeIntervalSince($0)) } ?? 0
                        Button(wait > 0 ? "\(wait) 秒后可重新发送" : "发送验证码") { run { try await sendCode() } }
                            .disabled(wait > 0 || busy || email.isEmpty)
                    }
                }
                if codeSentAt != nil {
                    Section {
                        TextField("6 位验证码", text: $code)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.numberPad)
                            .focused($codeFocused)
                        Button("登录") { run { try await model.login(email: email.trimmingCharacters(in: .whitespaces), code: code) } }
                            .disabled(busy || code.count != 6)
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Text(try! AttributedString(markdown: "登录后可以看到其他设备上的会话、project 和 note。登录即表示同意[《隐私政策》](\(model.privacyURL.absoluteString))。"))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle(model.state == .expired ? "登录已过期，请重新登录" : "登录 Hush")
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear { if let account = model.account { email = account.email } }
    }

    private func sendCode() async throws {
        try await model.sendCode(email: email.trimmingCharacters(in: .whitespaces))
        codeSentAt = .now
        codeFocused = true
    }

    private func run(_ action: @escaping () async throws -> Void) {
        busy = true
        error = nil
        Task {
            do { try await action() } catch { self.error = loginErrorText(error) }
            busy = false
        }
    }
}
