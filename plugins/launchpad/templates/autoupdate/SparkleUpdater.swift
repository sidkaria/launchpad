import SwiftUI
import Combine
import Sparkle

// launchpad-generated — Sparkle in-app updater for a SwiftUI macOS app.
// Wiring is done by /launchpad:setup, which adds to your `@main … : App`:
//     private let updater = SparkleUpdater()
//     ...
//     .commands {
//         CommandGroup(after: .appInfo) {
//             CheckForUpdatesView(updater: updater.controller.updater)
//         }
//     }
// Feed URL + public key live in Info.plist (SUFeedURL / SUPublicEDKey), so this
// file carries no app-specific values. Re-run /launchpad:setup to refresh.

final class SparkleUpdater {
    let controller: SPUStandardUpdaterController

    init() {
        // startingUpdater: true → begins scheduled background checks immediately,
        // using SUFeedURL + SUScheduledCheckInterval from Info.plist.
        controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }
}

// "Check for Updates…" menu item, disabled while a check is already running.
final class CheckForUpdatesViewModel: ObservableObject {
    @Published var canCheckForUpdates = false

    init(updater: SPUUpdater) {
        updater.publisher(for: \.canCheckForUpdates)
            .assign(to: &$canCheckForUpdates)
    }
}

struct CheckForUpdatesView: View {
    @ObservedObject private var viewModel: CheckForUpdatesViewModel
    private let updater: SPUUpdater

    init(updater: SPUUpdater) {
        self.updater = updater
        self.viewModel = CheckForUpdatesViewModel(updater: updater)
    }

    var body: some View {
        Button("Check for Updates…") {
            updater.checkForUpdates()
        }
        .disabled(!viewModel.canCheckForUpdates)
    }
}
