import SwiftUI

/// Trial-aware gate. Wrap your root view: `LicenseGate { ContentView() }`.
///  - Licensed          → content immediately, no chrome, no flash.
///  - Active trial       → a blocking `TrialGateView` on every launch until the user taps
///                         "Continue to free trial", then content for the session.
///  - Expired/unlicensed → the paywall (`LicenseView`) with a "trial ended" sub-headline.
/// Dev builds (DEBUG) bypass licensing and the trial entirely.
struct LicenseGate<Content: View>: View {
    @ObservedObject private var lm = LicenseManager.shared
    @ObservedObject private var trial = TrialManager.shared
    @State private var continuedTrial = false
    private let content: () -> Content
    init(@ViewBuilder content: @escaping () -> Content) { self.content = content }
    var body: some View {
        #if DEBUG
        content()
        #else
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
        #endif
    }
}
