import Foundation
import Security

class LicenseManager: ObservableObject {
    static let shared = LicenseManager()

    @Published var isLicensed = false

    private let keychainKey = "{{KEYCHAIN_ACCOUNT}}"
    private let userDefaultsKey = "{{KEYCHAIN_ACCOUNT}}-Debug"

    // No API key needed! Lemon Squeezy's license validation is a public endpoint

    // Use UserDefaults for debug builds to avoid keychain prompts on every build
    // Use Keychain for release builds for proper security
    private var useUserDefaultsForDebug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    private init() {
        // Optimistic entitlement: a stored key means it validated successfully before,
        // so the user is licensed immediately (no paywall flash on launch). Revalidate in
        // the background (offline-grace tolerant); downgrade only on a definitive online failure.
        isLicensed = (getLicenseKey() != nil)
        updateLicenseStatus()
    }

    // MARK: - Public Methods

    /// Check if user has valid license
    func hasValidLicense() async -> Bool {
        // Check storage (UserDefaults for debug, Keychain for release) for saved license
        if let savedKey = getLicenseKey() {
            let isValid = await validateLicense(key: savedKey)
            await MainActor.run {
                self.isLicensed = isValid
            }
            return isValid
        }

        // No license found
        await MainActor.run {
            self.isLicensed = false
        }
        return false
    }

    /// Validate license key with Lemon Squeezy's public API
    /// No API key required - this endpoint is public for license verification
    func validateLicense(key: String) async -> Bool {
        let url = URL(string: "https://api.lemonsqueezy.com/v1/licenses/validate")!

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "license_key": key,
            "instance_name": getDeviceName()
        ]

        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)

            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                print("License validation failed: Invalid response")
                return false
            }

            let licenseResponse = try JSONDecoder().decode(LicenseResponse.self, from: data)

            if licenseResponse.valid {
                // Save to storage (UserDefaults for debug, Keychain for release) for offline use
                saveLicenseKey(key)
                await MainActor.run {
                    self.isLicensed = true
                }
                return true
            }

            return false

        } catch {
            print("License validation error: \(error)")

            // If we have a cached license and network failed, allow offline grace period
            if getLicenseKey() != nil {
                return checkOfflineGracePeriod()
            }

            return false
        }
    }

    /// Activate license key
    func activateLicense(key: String) async throws {
        let isValid = await validateLicense(key: key)

        if !isValid {
            throw LicenseError.invalidKey
        }
    }

    /// Deactivate current license
    func deactivateLicense() {
        removeLicenseKey()
        Task {
            await MainActor.run {
                self.isLicensed = false
            }
        }
    }

    // MARK: - Offline Grace Period

    private func checkOfflineGracePeriod() -> Bool {
        guard let lastCheck = UserDefaults.standard.object(forKey: "lastLicenseCheck") as? Date else {
            return false
        }

        let gracePeriod: TimeInterval = {{GRACE_DAYS}} * 24 * 60 * 60
        let elapsed = Date().timeIntervalSince(lastCheck)

        return elapsed < gracePeriod
    }

    private func updateLastCheckDate() {
        UserDefaults.standard.set(Date(), forKey: "lastLicenseCheck")
    }

    // MARK: - Storage Management (Keychain for release, UserDefaults for debug)

    private func saveLicenseKey(_ key: String) {
        if useUserDefaultsForDebug {
            saveLicenseToUserDefaults(key)
        } else {
            saveLicenseToKeychain(key)
        }
    }

    private func getLicenseKey() -> String? {
        if useUserDefaultsForDebug {
            return getLicenseFromUserDefaults()
        } else {
            return getLicenseFromKeychain()
        }
    }

    private func removeLicenseKey() {
        if useUserDefaultsForDebug {
            removeLicenseFromUserDefaults()
        } else {
            removeLicenseFromKeychain()
        }
    }

    // MARK: - UserDefaults Storage (Debug Only)

    private func saveLicenseToUserDefaults(_ key: String) {
        UserDefaults.standard.set(key, forKey: userDefaultsKey)
        updateLastCheckDate()
        print("🔐 [DEBUG] License saved to UserDefaults")
    }

    private func getLicenseFromUserDefaults() -> String? {
        let key = UserDefaults.standard.string(forKey: userDefaultsKey)
        if key != nil {
            print("🔐 [DEBUG] License loaded from UserDefaults")
        }
        return key
    }

    private func removeLicenseFromUserDefaults() {
        UserDefaults.standard.removeObject(forKey: userDefaultsKey)
        UserDefaults.standard.removeObject(forKey: "lastLicenseCheck")
        print("🔐 [DEBUG] License removed from UserDefaults")
    }

    // MARK: - Keychain Management (Release Only)

    private func saveLicenseToKeychain(_ key: String) {
        guard let data = key.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainKey,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
            kSecAttrSynchronizable as String: false  // Don't sync to iCloud to avoid keychain prompts
        ]

        // Delete existing item
        SecItemDelete(query as CFDictionary)

        // Add new item
        let status = SecItemAdd(query as CFDictionary, nil)

        if status == errSecSuccess {
            updateLastCheckDate()
        }
    }

    private func getLicenseFromKeychain() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let key = String(data: data, encoding: .utf8) else {
            return nil
        }

        return key
    }

    private func removeLicenseFromKeychain() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainKey
        ]

        SecItemDelete(query as CFDictionary)
        UserDefaults.standard.removeObject(forKey: "lastLicenseCheck")
    }

    // MARK: - Utilities

    private func getDeviceName() -> String {
        return Host.current().localizedName ?? "Unknown Mac"
    }

    private func updateLicenseStatus() {
        Task {
            _ = await hasValidLicense()
        }
    }
}

// MARK: - Models

struct LicenseResponse: Codable {
    let valid: Bool
    let error: String?
    let license_key: LicenseKey?

    struct LicenseKey: Codable {
        let id: Int
        let status: String
        let key: String
        let activation_limit: Int?
        let activation_usage: Int?
        let expires_at: String?
    }
}

// MARK: - Errors

enum LicenseError: LocalizedError {
    case invalidKey
    case networkError
    case activationLimitReached
    case expired

    var errorDescription: String? {
        switch self {
        case .invalidKey:
            return "Invalid license key. Please check and try again."
        case .networkError:
            return "Unable to verify license. Please check your internet connection."
        case .activationLimitReached:
            return "Activation limit reached. Please deactivate on another device first."
        case .expired:
            return "This license has expired."
        }
    }
}
