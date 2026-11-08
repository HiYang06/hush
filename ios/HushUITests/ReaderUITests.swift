import XCTest

/// Signs in against a local server seeded from a desktop database, looks around, reads the session the
/// server adds (阅读测试: marks on plain text, on a formula and in a thread, a picture, a clip in its note,
/// a 笔记引用), opens the global note, signs out. Needs
///   cd server && node scripts/ios-e2e.ts <copy of hush.db>     (ready after about a minute)
///   TEST_RUNNER_HUSH_E2E_SERVER=http://localhost:8787 xcodebuild test -project ios/Hush.xcodeproj -scheme Hush ...
/// and is skipped otherwise. Screenshots are kept in the test result.
@MainActor
final class ReaderUITests: XCTestCase {
    private let email = "ios-e2e@example.com"

    func testSignInReadAndSignOut() async throws {
        let server = ProcessInfo.processInfo.environment["HUSH_E2E_SERVER"] ?? ""
        try XCTSkipIf(server.isEmpty, "Set TEST_RUNNER_HUSH_E2E_SERVER to run this test")
        let app = XCUIApplication()
        app.launchEnvironment["HUSH_SYNC_URL"] = server
        app.launch()

        let account = app.buttons["账号与同步"]
        // The simulator's Keychain outlives reinstalls, so an earlier run may still be signed in.
        if account.waitForExistence(timeout: 3) {
            account.tap()
            app.buttons["退出登录"].tap()
        }

        let emailField = app.textFields["邮箱"]
        XCTAssert(emailField.waitForExistence(timeout: 5))
        snap("登录")
        emailField.tap()
        emailField.typeText(email)
        app.buttons["发送验证码"].tap()
        let codeField = app.textFields["6 位验证码"]
        XCTAssert(codeField.waitForExistence(timeout: 5))
        codeField.typeText(try await code(from: server))
        app.buttons["登录"].tap()

        XCTAssert(account.waitForExistence(timeout: 10))
        XCTAssert(app.cells.buttons.firstMatch.waitForExistence(timeout: 10))
        snap("首页")

        app.cells.buttons.firstMatch.tap()
        let back = app.navigationBars.buttons["Hush"]
        XCTAssert(back.waitForExistence(timeout: 5))
        snap("project")
        back.tap()

        app.cells.buttons["阅读测试"].tap()
        let marked = app.webViews.staticTexts["这一段有 mark，点一下会弹出卡片。"]
        XCTAssert(marked.waitForExistence(timeout: 10))
        snap("会话")
        marked.tap()
        XCTAssert(app.staticTexts["卡片里的批注"].waitForExistence(timeout: 5))
        snap("mark 卡片")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.1)).tap()

        app.buttons["Mark 3"].tap()
        let inThread = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "这一句被 mark 了")).firstMatch
        XCTAssert(inThread.waitForExistence(timeout: 5))
        snap("Mark 列表")
        inThread.tap()
        XCTAssert(app.navigationBars["测试追问"].waitForExistence(timeout: 5))
        XCTAssert(app.webViews.staticTexts["这段是什么意思？"].waitForExistence(timeout: 10))
        snap("追问")
        app.navigationBars.buttons["阅读测试"].tap()

        app.webViews.staticTexts["这一段挂着一次追问。"].tap()
        XCTAssert(app.navigationBars["测试追问"].waitForExistence(timeout: 5))
        app.navigationBars.buttons["阅读测试"].tap()

        // The picture is downloaded for its thumbnail, then opens full screen in Quick Look.
        let thumbnail = app.webViews.images["测试图.png"]
        XCTAssert(thumbnail.waitForExistence(timeout: 10))
        XCTAssertFalse(app.webViews.staticTexts["未下载"].exists)
        // Quick Look draws in another process, out of this test's reach: its showing is told by what it covers.
        let noteButton = app.buttons["Note"]
        thumbnail.tap()
        await fulfillment(of: [expectation(for: NSPredicate(format: "hittable == false"), evaluatedWith: noteButton)], timeout: 10)
        // Its bars hide a moment after opening; a tap brings them back, with the close button at the top left.
        // Taps during its opening animation are dropped, and nothing in this process tells when that ends.
        try await Task.sleep(for: .seconds(2))
        snap("附件预览")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        try await Task.sleep(for: .seconds(1))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.073, dy: 0.096)).tap()
        await fulfillment(of: [expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: noteButton)], timeout: 10)

        // A clipped passage's underline opens the note at that clip; so does a 笔记引用 card, at its section.
        app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "也能 mark")).firstMatch.tap()
        XCTAssert(app.navigationBars["会话 Note"].waitForExistence(timeout: 5))
        XCTAssert(app.webViews.staticTexts["笔记引用指向这一节。"].waitForExistence(timeout: 10))
        snap("会话 Note")
        app.navigationBars.buttons["阅读测试"].tap()
        app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "笔记引用：")).firstMatch.tap()
        XCTAssert(app.navigationBars["会话 Note"].waitForExistence(timeout: 5))
        app.navigationBars.buttons["阅读测试"].tap()
        app.navigationBars.buttons["Hush"].tap()

        app.buttons["全局 Note"].tap()
        XCTAssert(app.navigationBars["全局 Note"].waitForExistence(timeout: 5))
        // The desktop copy's global note, or 这个 note 还是空的 when it has none.
        XCTAssert(app.webViews.staticTexts.firstMatch.waitForExistence(timeout: 10))
        snap("全局 Note")
        app.navigationBars.buttons["Hush"].tap()

        account.tap()
        XCTAssert(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", email)).firstMatch.waitForExistence(timeout: 5))
        snap("账号与同步")
        app.buttons["退出登录"].tap()
        XCTAssert(emailField.waitForExistence(timeout: 5))
    }

    private func code(from server: String) async throws -> String {
        let url = URL(string: "\(server)/dev/code?email=\(email)")!
        for _ in 0..<20 {
            let (data, _) = try await URLSession.shared.data(from: url)
            if let code = try JSONDecoder().decode([String: String?].self, from: data)["code"] ?? nil { return code }
            try await Task.sleep(for: .milliseconds(500))
        }
        XCTFail("The server sent no code; was it started over a minute ago?")
        return ""
    }

    private func snap(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
