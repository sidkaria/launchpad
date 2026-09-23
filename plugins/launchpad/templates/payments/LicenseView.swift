import SwiftUI
import AppKit

struct LicenseView: View {
    var trialEnded: Bool = false
    @ObservedObject var licenseManager = LicenseManager.shared
    @State private var licenseKey = ""
    @State private var isValidating = false
    @State private var errorMessage = ""
    @State private var showSuccess = false

    private let accent = Color(hex: "{{ACCENT_HEX}}")
    private let bg = Color(hex: "{{BG_HEX}}")
    private let ink = Color(hex: "{{INK_HEX}}")

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
                if trialEnded {
                    Text("Your free trial has ended")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(accent)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.top, 38)

            VStack(alignment: .leading, spacing: 8) {
                Text("LICENSE KEY")
                    .font(.system(size: 11, weight: .medium)).tracking(0.5)
                    .foregroundColor(ink.opacity(0.5))
                TextField("XXXX-XXXX-XXXX-XXXX", text: $licenseKey)
                    .textFieldStyle(.plain)
                    .font(.system(size: 14, design: .monospaced))
                    .foregroundColor(ink)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 10).fill(ink.opacity(0.06)))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(ink.opacity(0.12)))
                    .disabled(isValidating)
            }

            if !errorMessage.isEmpty {
                Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                    .font(.system(size: 12)).foregroundColor(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if showSuccess {
                Label("License activated", systemImage: "checkmark.circle.fill")
                    .font(.system(size: 12)).foregroundColor(accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: 10) {
                Button(action: openPurchasePage) {
                    Text("{{BUY_LABEL}}").font(.system(size: 14, weight: .semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .foregroundColor(.white)
                        .background(RoundedRectangle(cornerRadius: 10).fill(accent))
                }.buttonStyle(.plain)

                Button(action: activateLicense) {
                    Text(isValidating ? "Verifying…" : "Activate").font(.system(size: 14, weight: .semibold))
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .foregroundColor(ink)
                        .background(RoundedRectangle(cornerRadius: 10).stroke(ink.opacity(0.25)))
                }.buttonStyle(.plain).disabled(licenseKey.isEmpty || isValidating)
            }

            Spacer(minLength: 4)
            VStack(spacing: 4) {
                Text("{{PRICE_LINE}}")
                    .font(.system(size: 12, weight: .medium)).foregroundColor(ink.opacity(0.5))
                Text("Secure payment via Lemon Squeezy")
                    .font(.system(size: 10)).foregroundColor(ink.opacity(0.35))
            }.padding(.bottom, 22)
        }
        .padding(.horizontal, 32)
        .frame(width: 460, height: 470)
        .background(bg)
        // A rejected key is kept, not deleted — so a retry is one click.
        .onAppear { if licenseKey.isEmpty { licenseKey = licenseManager.storedKey ?? "" } }
    }

    private func activateLicense() {
        let key = licenseKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        isValidating = true; errorMessage = ""; showSuccess = false
        Task {
            do {
                try await licenseManager.activateLicense(key: key)
                await MainActor.run {
                    isValidating = false; showSuccess = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                        NotificationCenter.default.post(name: .licenseActivated, object: nil)
                    }
                }
            } catch {
                await MainActor.run {
                    isValidating = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func openPurchasePage() {
        if let url = URL(string: "{{CHECKOUT_URL}}") { NSWorkspace.shared.open(url) }
    }
}

extension Notification.Name {
    static let licenseActivated = Notification.Name("LicenseActivated")
}

extension Color {
    init(hex: String) {
        let h = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var int: UInt64 = 0
        Scanner(string: h).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xff) / 255.0
        let g = Double((int >> 8) & 0xff) / 255.0
        let b = Double(int & 0xff) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}
