import SwiftUI

/// Trial-aware gate. Wrap your root view: `LicenseGate { ContentView() }`.
///  - Licensed          → content immediately, no chrome, no flash.
///  - Active trial       → a blocking `TrialGateView` on every launch until the user taps
///                         "Continue to free trial", then content for the session.
///  - Expired/unlicensed → the paywall (`LicenseView`) with a "trial ended" sub-headline.
/// Dev builds (DEBUG) bypass licensing and the trial entirely — and never touch
/// them: both managers are only created inside the release-only view below, so a
/// Debug build neither starts the trial clock in the Keychain nor calls the store.
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
    @ObservedObject private var trial = TrialManager.shared
    @State private var continuedTrial = false
    let content: () -> Content
    var body: some View {
        Group {
            if lm.isLicensed {
                content()
            } else if trial.status.active {
                if continuedTrial {
                    content()
                } else {
                    TrialGateView(status: trial.status, onContinue: { continuedTrial = true })
                }
            } else {
                LicenseView(trialEnded: trial.status.expired)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .licenseActivated)) { _ in
            Task { _ = await lm.hasValidLicense() }
        }
    }
}
#endif
