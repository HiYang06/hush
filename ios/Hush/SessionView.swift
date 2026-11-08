import HushCore
import QuickLook
import SwiftUI

/// A session or a thread, read as on the desktop. Tapping a mark brings up its card, a thread's dashed
/// underline opens that thread as the next page.
struct SessionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.open) private var open
    @Environment(\.openURL) private var openURL
    let session: SessionItem
    var reveal: Reveal?
    // Made on first appear: a @State initial value is rebuilt with every copy of this view, and this one
    // holds a web view.
    @State private var page: ReaderPage?
    @State private var json: String?
    @State private var note = NoteTarget.global
    @State private var hasNote = false
    @State private var preview: URL?
    @State private var downloading = false
    @State private var downloadError: String?
    @State private var marks: [MarkItem] = []
    @State private var card: MarkDetail?
    @State private var listingMarks = false

    var body: some View {
        // The color is there from the start: an empty view would never appear, and onAppear makes the page.
        ZStack {
            Color(.readerBackground).ignoresSafeArea()
            if let page { ReaderView(page: page, content: json.map(ReaderContent.conversation)).ignoresSafeArea(edges: .bottom) }
            if downloading { ProgressView("正在下载…").padding().background(.regularMaterial, in: .rect(cornerRadius: 12)) }
        }
            .navigationTitle(session.displayTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // A thread's marks are listed with its main session's (product.md §4), so a thread has none of its own.
                if !marks.isEmpty {
                    Button("Mark \(marks.count)") { listingMarks = true }
                }
                if hasNote {
                    Button("Note") { open(.note(note)) }
                }
            }
            .sheet(item: $card) { MarkCard(mark: $0) }
            .quickLookPreview($preview)
            .alert("无法打开附件", isPresented: Binding { downloadError != nil } set: { if !$0 { downloadError = nil } }) {
            } message: {
                Text(downloadError ?? "")
            }
            .sheet(isPresented: $listingMarks) {
                MarkList(marks: marks) { mark in
                    listingMarks = false
                    if mark.sessionId == session.id {
                        page?.reveal(.mark(mark.id))
                    } else if let thread = try? model.db.read({ try Library.session($0, id: mark.sessionId) }) {
                        open(.session(thread, reveal: .mark(mark.id)))
                    }
                }
            }
            .onAppear {
                // Also on coming back from a thread, where the page and its scroll position stay as they were.
                guard page == nil else { return }
                let page = ReaderPage(attachment: model.attachment)
                page.onTap = handle
                if let reveal { page.reveal(reveal) }
                self.page = page
            }
            .task {
                await model.observe({ [id = session.id] in try Library.conversationJSON($0, sessionId: id) }) { json = $0 }
            }
            .task {
                await model.observe({ [id = session.id] in try Library.marks($0, mainSessionId: id) }) { marks = $0 }
            }
            .task {
                // Where this session's clips go (a project's note, or its own); shown when there's something in it.
                await model.observe({ [id = session.id] in
                    let target = try Library.noteTarget($0, sessionId: id)
                    return (target, !(try Library.note($0, target)).isEmpty)
                }) { (note, hasNote) = $0 }
            }
    }

    private func handle(_ tap: ReaderTap) {
        switch tap {
        case .mark(let id):
            card = try? model.db.read { try Library.mark($0, id: id) }
        case .thread(let id), .session(let id):
            if let target = try? model.db.read({ try Library.session($0, id: id) }) { open(.session(target)) }
        case .message(let id):
            guard let target = try? model.db.read({ try Library.session($0, containingMessage: id) }) else { return }
            if target.id == session.id { page?.reveal(.message(id)) } else { open(.session(target, reveal: .message(id))) }
        case .clip(let messageId, let start, let end):
            open(.note(note, reveal: .clip(messageId: messageId, start: start, end: end)))
        case .note(let id, let section):
            if let target = try? model.db.read({ try Library.noteTarget($0, noteId: id) }) {
                open(.note(target, reveal: section.map(Reveal.section)))
            }
        case .file(let id):
            Task { await showFile(id) }
        case .link(let url):
            openURL(url)
        }
    }

    /// Full screen in Quick Look, which reads images, PDF, Word and PowerPoint alike.
    private func showFile(_ id: String) async {
        downloading = true
        defer { downloading = false }
        do {
            preview = try await model.attachment(id)
        } catch {
            downloadError = downloadErrorText(error)
        }
    }
}

private extension MarkDetail {
    var color: Color { markColor(categoryColor) }
}

/// amber / blue / green, the three category colors (tokens.css --mark-*-text).
private func markColor(_ name: String?) -> Color {
    switch name {
    case "blue": .blue
    case "green": .green
    default: .orange
    }
}

private struct CategoryBadge: View {
    let name: String
    let color: Color

    var body: some View {
        Text(name)
            .font(.caption.weight(.medium))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
    }
}

/// The desktop's mark card, read-only: category, comment, the passage.
private struct MarkCard: View {
    let mark: MarkDetail

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let name = mark.categoryName { CategoryBadge(name: name, color: mark.color) }
                Text(mark.quote)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 12)
                    .overlay(alignment: .leading) { Rectangle().fill(.quaternary).frame(width: 2) }
                if let comment = mark.comment, !comment.isEmpty {
                    Text(comment)
                } else {
                    Text("没有批注").foregroundStyle(.tertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .textSelection(.enabled)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

/// Every mark of the session in reading order; a tap goes back to its passage.
private struct MarkList: View {
    let marks: [MarkItem]
    let select: (MarkItem) -> Void

    var body: some View {
        NavigationStack {
            List(marks) { mark in
                Button { select(mark) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            if let name = mark.categoryName { CategoryBadge(name: name, color: markColor(mark.categoryColor)) }
                            if mark.inThread {
                                Text("追问").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Text(mark.quote).lineLimit(3)
                        if let comment = mark.comment, !comment.isEmpty {
                            Text(comment).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                .tint(.primary)
            }
            .navigationTitle("Mark")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
    }
}
