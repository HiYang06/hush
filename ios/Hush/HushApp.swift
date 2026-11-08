import SwiftUI

@main
struct HushApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                if model.account == nil || model.state == .expired {
                    LoginView()
                } else {
                    HomeView()
                }
            }
            .environment(model)
        }
        // Covers launch too: the scene becomes active right after it appears.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.pull() } }
        }
    }
}
