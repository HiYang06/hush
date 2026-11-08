import HushCore
import SwiftUI

/// The desktop's 账号与同步 page (product.md §13), minus what only a device that writes needs:
/// conflict notices and attachment space.
struct AccountView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmingDelete = false
    @State private var deleting = false
    @State private var deleteError: String?

    var body: some View {
        Form {
            Section {
                LabeledContent("账号", value: model.account?.email ?? "")
            }
            Section {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Text(statusText(now: context.date))
                        .foregroundStyle(model.needsLook ? .red : .secondary)
                }
                Button("立即同步") { Task { await model.pull() } }
                    .disabled(model.state == .syncing)
            } footer: {
                Text("打开 Hush、切回 Hush 或在列表里下拉时同步。")
            }
            Section {
                Button("退出登录") { Task { await model.logout() } }
            } footer: {
                Text("退出后这台手机上的内容会清除，重新登录后再同步下来。")
            }
            Section {
                if confirmingDelete {
                    Text("会删除云端的所有会话、note 和附件，不能恢复；电脑上已有的内容保留。")
                    Button(deleting ? "正在注销…" : "确认注销", role: .destructive) { deleteAccount() }
                        .disabled(deleting)
                    Button("取消") { confirmingDelete = false; deleteError = nil }
                        .disabled(deleting)
                    if let deleteError { Text(deleteError).foregroundStyle(.red) }
                } else {
                    Button("注销账号", role: .destructive) { confirmingDelete = true }
                }
            } footer: {
                Link("查看《隐私政策》", destination: model.privacyURL)
                    .font(.footnote)
                    .padding(.top, 8)
            }
        }
        .navigationTitle("账号与同步")
        .navigationBarTitleDisplayMode(.inline)
    }

    // AccountSettings.tsx's wording, except this app only syncs when opened or pulled, not on its own.
    private func statusText(now: Date) -> String {
        switch model.state {
        case .syncing: return "同步中…"
        case .offline: return "离线，联网后下拉同步"
        case .failed(let error): return "同步失败（\(error)），下拉重试"
        case .expired: return "登录已过期，请重新登录"
        case .idle:
            guard let at = model.lastSyncedAt else { return "等待同步" }
            let minutes = Int(now.timeIntervalSince(at) / 60)
            if minutes < 1 { return "已同步 · 刚刚" }
            if minutes < 60 { return "已同步 · \(minutes) 分钟前" }
            return "已同步 · \(at.formatted(date: .omitted, time: .shortened))"
        }
    }

    private func deleteAccount() {
        deleting = true
        deleteError = nil
        Task {
            do { try await model.deleteAccount() } catch { deleteError = loginErrorText(error) }
            deleting = false
        }
    }
}
