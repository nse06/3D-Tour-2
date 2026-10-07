import SwiftUI

@main
struct AtriumCaptureApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(model)
                .tint(Theme.gold)
                // atriumcapture://pair?server=…&token=… from the dashboard's QR code.
                .onOpenURL { url in model.handleOpenURL(url) }
        }
    }
}
