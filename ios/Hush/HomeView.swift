import GRDB
import HushCore
import SwiftUI

enum Route: Hashable {
    case project(ProjectItem)
    case session(SessionItem, reveal: Reveal? = nil)
    case note(NoteTarget, reveal: Reveal? = nil)
    case account
}

/// Where a page lands when opened from a mark, a link, a clip or a 笔记引用, instead of at the top.
enum Reveal: Hashable {
    case mark(String)
    case message(String)
    /// A clip in a note: the quote its source link closes.
    case clip(messageId: String, start: Int, end: Int)
    /// A heading in a note.
    case section(String)
}

extension EnvironmentValues {
    /// Pushes a page from inside another, e.g. a thread from a tap in the reading view.
    @Entry var open: (Route) -> Void = { _ in }
}

extension SessionItem {
    var displayTitle: String { title.isEmpty ? "新对话" : title }
}

/// The desktop's left sidebar as a phone's first page (product.md §1): projects, then the sessions in none.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var projects: [ProjectItem] = []
    @State private var sessions: [SessionItem] = []
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    NavigationLink(value: Route.note(.global)) { Label("全局 Note", systemImage: "note.text") }
                }
                if !projects.isEmpty {
                    Section("Project") {
                        ForEach(projects) { project in
                            NavigationLink(value: Route.project(project)) {
                                Label(project.name, systemImage: "folder")
                            }
                        }
                    }
                }
                ForEach(groupByTime(sessions, now: .now), id: \.label) { group in
                    Section(group.label) {
                        ForEach(group.sessions) { session in
                            NavigationLink(session.displayTitle, value: Route.session(session))
                        }
                    }
                }
            }
            .overlay {
                if projects.isEmpty && sessions.isEmpty {
                    if model.state == .syncing {
                        ProgressView("正在同步…")
                    } else {
                        ContentUnavailableView("还没有会话", systemImage: "text.bubble", description: Text("在电脑上的 Hush 里开始对话，会同步到这里。"))
                    }
                }
            }
            .refreshable { await model.pull() }
            .navigationTitle("Hush")
            .toolbar {
                NavigationLink(value: Route.account) {
                    Image(systemName: "person.crop.circle")
                        .overlay(alignment: .topTrailing) {
                            if model.needsLook {
                                Circle().fill(.red).frame(width: 8, height: 8).offset(x: 2, y: -2)
                            }
                        }
                }
                .accessibilityLabel("账号与同步")
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .project(let project): ProjectView(project: project)
                case .session(let session, let reveal): SessionView(session: session, reveal: reveal)
                case .note(let target, let reveal): NoteView(target: target, reveal: reveal)
                case .account: AccountView()
                }
            }
        }
        .environment(\.open) { path.append($0) }
        .task { await model.observe(Library.projects) { projects = $0 } }
        .task { await model.observe({ try Library.sessions($0, projectId: nil) }) { sessions = $0 } }
    }
}

struct ProjectView: View {
    @Environment(AppModel.self) private var model
    let project: ProjectItem
    @State private var sessions: [SessionItem] = []

    var body: some View {
        List {
            Section {
                NavigationLink(value: Route.note(NoteTarget(scope: "project", scopeId: project.id))) {
                    Label("Note", systemImage: "note.text")
                }
            }
            Section {
                ForEach(sessions) { session in
                    NavigationLink(session.displayTitle, value: Route.session(session))
                }
                if sessions.isEmpty { Text("这个 project 里还没有会话").foregroundStyle(.secondary) }
            }
        }
        .refreshable { await model.pull() }
        .navigationTitle(project.name)
        .task { await model.observe({ [id = project.id] in try Library.sessions($0, projectId: id) }) { sessions = $0 } }
    }
}
