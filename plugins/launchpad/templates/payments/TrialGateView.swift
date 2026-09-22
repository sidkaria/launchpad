import SwiftUI
import AppKit

// Note: `Color(hex:)` is defined in LicenseView.swift (same module) — do not redefine it here.

/// Blocking full-screen trial gate shown on every launch while the trial is active and the
/// user is unlicensed. A prominent "Continue to free trial" button enters the app for this
/// session; a secondary CTA opens checkout; a text button reveals the license-key entry.
struct TrialGateView: View {
    let status: TrialManager.Status
    var onContinue: () -> Void
    @State private var showLicense = false

    private let accent = Color(hex: "{{ACCENT_HEX}}")
    private let bg = Color(hex: "{{BG_HEX}}")
    private let ink = Color(hex: "{{INK_HEX}}")

    private var statusLine: String {
        if status.firstLaunch { return "Welcome — your free trial has started" }
        if status.daysRemaining <= 1 { return "Last day of your free trial" }
        return "\(status.daysRemaining) days left in your free trial"
    }

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 8) {
                Text("{{APP_NAME}}")
                    .font(.system(size: 30, weight: .bold, design: {{HEADLINE_FONT_DESIGN}}))
                    .foregroundColor(ink)
                Text("{{TAGLINE}}")
                    .font(.system(size: 14))
                    .foregroundColor(ink.opacity(0.65))
                    .multilineTextAlignment(.center)
                Text(statusLine)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(accent)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 38)

            Spacer(minLength: 8)

            VStack(spacing: 10) {
                Button(action: onContinue) {
                    Text("Continue to free trial")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .foregroundColor(.white)
                        .background(RoundedRectangle(cornerRadius: 10).fill(accent))
                }.buttonStyle(.plain)

                Button(action: openCheckout) {
                    Text("Unlock lifetime — {{PRICE_AMOUNT}}")
                        .font(.system(size: 14, weight: .semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .foregroundColor(ink)
                        .background(RoundedRectangle(cornerRadius: 10).stroke(ink.opacity(0.25)))
                }.buttonStyle(.plain)

                Button(action: { showLicense = true }) {
                    Text("Already bought? Enter your license key")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(accent)
                }.buttonStyle(.plain)
            }

            Spacer(minLength: 4)
            Text("{{PRICE_AMOUNT}} · lifetime license · secure payment via Lemon Squeezy")
                .font(.system(size: 10)).foregroundColor(ink.opacity(0.35))
                .multilineTextAlignment(.center)
                .padding(.bottom, 22)
        }
        .padding(.horizontal, 32)
        .frame(width: 460, height: 470)
        .background(bg)
        .sheet(isPresented: $showLicense) { LicenseView() }
    }

    private func openCheckout() {
        if let url = URL(string: "{{CHECKOUT_URL}}") { NSWorkspace.shared.open(url) }
    }
}
