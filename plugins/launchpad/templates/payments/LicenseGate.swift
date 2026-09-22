import SwiftUI

/// Wrap your root view: `LicenseGate { ContentView() }`.
/// Shows the licensed content when valid, otherwise the paywall.
/// Dev builds (DEBUG) bypass licensing entirely.
struct LicenseGate<Content: View>: View {
    @ObservedObject private var lm = LicenseManager.shared
    private let content: () -> Content
    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }
    var body: some View {
        #if DEBUG
        content()
        #else
        Group {
            if lm.isLicensed { content() } else { LicenseView() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .licenseActivated)) { _ in
            Task { _ = await lm.hasValidLicense() }
        }
        #endif
    }
}
