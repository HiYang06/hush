import HushCore
import SwiftUI

/// A note, read-only, rendered as the desktop's history view renders one (MarkdownContent). A source link
/// goes back to the passage in its conversation.
struct NoteView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.open) private var open
    @Environment(\.openURL) private var openURL
    let target: NoteTarget
    var reveal: Reveal?
    // Made on first appear, as in SessionView.
    @State private var page: ReaderPage?
    @State private var content: String?
    @State private var title = ""

    var body: some View {
        ZStack {
            Color(.readerBackground).ignoresSafeArea()
            if let page { ReaderView(page: page, content: content.map(ReaderContent.note)).ignoresSafeArea(edges: .bottom) }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            guard page == nil else { return }
            let page = ReaderPage(attachment: model.attachment)
            page.onTap = handle
            if let reveal { page.reveal(reveal) }
            self.page = page
        }
        .task { await model.observe({ [target] in try Library.note($0, target) }) { content = $0 } }
        .task { await model.observe({ [target] in try Library.noteTitle($0, target) }) { title = $0 } }
    }

    private func handle(_ tap: ReaderTap) {
        switch tap {
        case .message(let id):
            if let session = try? model.db.read({ try Library.session($0, containingMessage: id) }) {
                open(.session(session, reveal: .message(id)))
            }
        case .link(let url):
            openURL(url)
        default:
            break
        }
    }
}
