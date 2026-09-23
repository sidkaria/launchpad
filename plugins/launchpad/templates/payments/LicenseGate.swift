import SwiftUI

/// Wrap your root view: `LicenseGate { ContentView() }`.
/// Shows the licensed content when valid, otherwise the paywall.
/// Dev builds (DEBUG) bypass licensing entirely — and never touch it: the
/// licence manager is only created inside the release-only view below, so a
/// Debug build makes no network call and writes nothing to the Keychain.
struct LicenseGate<Content: View>: View {
    private let content: () -> Content
    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }
    var body: some View {
        #if DEBUG
        content()
        #else
        ReleaseLicenseGate(content: content)
        #endif
    }
}

#if !DEBUG
private struct ReleaseLicenseGate<Content: View>: View {
    @ObservedObject private var lm = LicenseManager.shared
    let content: () -> Content
    var body: some View {
        Group {
            if lm.isLicensed { content() } else { LicenseView() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .licenseActivated)) { _ in
            Task { _ = await lm.hasValidLicense() }
        }
    }
}
#endif
