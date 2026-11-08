import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// What a tap in the reading view asks the app to do (ios/web/bridge.ts).
enum ReaderTap {
    case mark(String)
    case thread(String)
    case message(String)
    case session(String)
    case clip(messageId: String, start: Int, end: Int)
    case file(String)
    case note(id: String, section: String?)
    case link(URL)
}

/// What a page shows: a session's conversation (Library.conversationJSON) or a note's Markdown.
enum ReaderContent: Equatable {
    case conversation(String)
    case note(String)
}

/// One session's reading view: the desktop renderer's components (ios/web) in a WKWebView. Swift hands it
/// data and gets taps back; scrolling, text selection and layout stay the web view's own.
@MainActor
final class ReaderPage: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    let webView: WKWebView
    var onTap: (ReaderTap) -> Void = { _ in }
    private var ready = false
    private var queued: [(String, [String: Any])] = []
    private var shown: ReaderContent?

    /// attachment finds an attachment on this device, downloading it first if need be (AppModel.attachment).
    init(attachment: @escaping @MainActor (String) async throws -> URL) {
        let config = WKWebViewConfiguration()
        // A custom scheme, not file://: WebKit won't load module scripts from a file URL.
        config.setURLSchemeHandler(BundledWeb(), forURLScheme: BundledWeb.scheme)
        config.setURLSchemeHandler(AttachmentFiles(attachment: attachment), forURLScheme: "hush-file")
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(WeakHandler(self), name: "hush")
        webView.navigationDelegate = self
        webView.allowsLinkPreview = false
        // The page's own background shows through while it loads, instead of a white flash in dark mode.
        webView.isOpaque = false
        webView.backgroundColor = .readerBackground
        webView.scrollView.backgroundColor = .readerBackground
        #if DEBUG
        webView.isInspectable = true
        #endif
        webView.load(URLRequest(url: URL(string: "\(BundledWeb.scheme)://app/index.html")!))
    }

    func show(_ content: ReaderContent) {
        // Every write to the tables a page reads fires the observation, most of them elsewhere.
        guard content != shown else { return }
        shown = content
        switch content {
        case .conversation(let json): call("window.hush.show(json)", ["json": json])
        case .note(let markdown): call("window.hush.showNote(markdown)", ["markdown": markdown])
        }
    }

    func reveal(_ reveal: Reveal) {
        switch reveal {
        case .mark(let id): call("window.hush.revealMark(id)", ["id": id])
        case .message(let id): call("window.hush.revealMessage(id)", ["id": id])
        case .clip(let messageId, let start, let end):
            call("window.hush.revealClip(messageId, start, end)", ["messageId": messageId, "start": start, "end": end])
        case .section(let title): call("window.hush.revealSection(title)", ["title": title])
        }
    }

    private func call(_ script: String, _ arguments: [String: Any]) {
        guard ready else { return queued.append((script, arguments)) }
        webView.callAsyncJavaScript(script, arguments: arguments, in: nil, in: .page) { result in
            if case .failure(let error) = result { assertionFailure("Reader script failed: \(error)") }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let id = body["id"] as? String ?? ""
        switch type {
        case "ready":
            ready = true
            for (script, arguments) in queued { call(script, arguments) }
            queued = []
        case "mark": onTap(.mark(id))
        case "thread": onTap(.thread(id))
        case "message": onTap(.message(id))
        case "session": onTap(.session(id))
        case "clip": onTap(.clip(messageId: id, start: body["start"] as? Int ?? 0, end: body["end"] as? Int ?? 0))
        case "file": onTap(.file(id))
        case "note": onTap(.note(id: id, section: body["section"] as? String))
        case "link": if let url = URL(string: body["url"] as? String ?? "") { onTap(.link(url)) }
        default: break
        }
    }

    // An ordinary link (target=_blank, in a reply or a source list) leaves the app for the browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url, url.scheme != BundledWeb.scheme else { return .allow }
        onTap(.link(url))
        return .cancel
    }
}

/// The user content controller keeps its handlers alive, and the page keeps the web view: without this
/// in between, a closed session page would never be freed.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: ReaderPage?
    init(_ target: ReaderPage) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Serves the `web` folder the build copies into the app (npm run build:ios-web).
private final class BundledWeb: NSObject, WKURLSchemeHandler {
    static let scheme = "hush-app"
    private let root = Bundle.main.resourceURL!.appending(path: "web")

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let url = task.request.url!
        let file = root.appending(path: url.path(percentEncoded: false))
        guard let data = try? Data(contentsOf: file) else {
            return task.didFailWithError(URLError(.fileDoesNotExist, userInfo: [NSURLErrorFailingURLErrorKey: url]))
        }
        let type = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

/// hush-file://<file id>, like the desktop's protocol of that name: an attachment's bytes, fetched from the
/// server the first time. A failure leaves the thumbnail to say 未下载; tapping it gives the reason.
@MainActor
private final class AttachmentFiles: NSObject, WKURLSchemeHandler {
    private let attachment: @MainActor (String) async throws -> URL
    private var stopped = Set<ObjectIdentifier>()

    init(attachment: @escaping @MainActor (String) async throws -> URL) {
        self.attachment = attachment
    }

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let url = task.request.url!
        Task { @MainActor in
            let file = try? await attachment(url.host() ?? "")
            // WebKit raises if a task it has stopped (the image scrolled away, the page closed) hears back.
            guard stopped.remove(ObjectIdentifier(task)) == nil else { return }
            guard let file, let data = try? Data(contentsOf: file) else {
                return task.didFailWithError(URLError(.fileDoesNotExist, userInfo: [NSURLErrorFailingURLErrorKey: url]))
            }
            let type = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!)
            task.didReceive(data)
            task.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }
}

extension UIColor {
    /// --bg-primary in tokens.css, light and dark.
    static let readerBackground = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x18 / 255, green: 0x19 / 255, blue: 0x1B / 255, alpha: 1)
            : UIColor(red: 0xF9 / 255, green: 0xF9 / 255, blue: 0xF7 / 255, alpha: 1)
    }
}

struct ReaderView: UIViewRepresentable {
    let page: ReaderPage
    let content: ReaderContent?
    func makeUIView(context: Context) -> WKWebView { page.webView }
    func updateUIView(_ webView: WKWebView, context: Context) {
        if let content { page.show(content) }
    }
}
