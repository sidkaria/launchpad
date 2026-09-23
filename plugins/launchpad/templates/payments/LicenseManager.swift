import CryptoKit
import Foundation
import IOKit
import Security

/// Lemon Squeezy licensing for a directly-distributed Mac app.
///
/// Three public calls, no API key in the binary (the License API is public):
///
///     activate(key, instance_name)  → an instance id; consumes one of the key's seats
///     validate(key, instance_id)    → confirms that seat on every later launch
///     deactivate(key, instance_id)  → releases the seat, so the user can move Macs
///
/// Validate alone never consumes a seat, which is how a shipped app's
/// "2 devices" licence once worked on unlimited Macs. So this activates.
///
/// Every rule below was paid for by a paying customer somewhere:
///  - A store REJECTION drops the "recently confirmed" stamp and puts the gate up,
///    but never deletes the key. Rejections are also what a rate limit, a stale
///    instance or a decoder bug look like; deleting the key on one destroys the
///    customer's proof of purchase. Only an explicit deactivation removes it.
///  - Only a 5xx or a transport failure is "offline". Lemon Squeezy answers 4xx
///    with a well-formed body ("license key not found"), so those are decoded.
///  - Offline, a key confirmed within `gracePeriod` keeps working; a clock set
///    back more than a day does not extend it.
///  - The Keychain item is UPDATED in place, never deleted and re-added: a
///    re-add rebuilds its access list, discarding the user's "Always Allow".
///
/// Main-actor isolated: it publishes UI state, and it compiles clean in both the
/// Swift 5 and Swift 6 language modes.
@MainActor
final class LicenseManager: ObservableObject {
    static let shared = LicenseManager()

    @Published var isLicensed = false

    private let keychainAccount = "{{KEYCHAIN_ACCOUNT}}"
    private let gracePeriod: TimeInterval = {{GRACE_DAYS}} * 24 * 60 * 60
    /// 0 = not checked. Set, a key from any other Lemon Squeezy store or product
    /// is refused — otherwise ANY valid Lemon Squeezy key, for anybody's product,
    /// unlocks this app.
    private let expectedStoreID = {{STORE_ID}}
    private let expectedProductID = {{PRODUCT_ID}}

    nonisolated private static let apiBase = URL(string: "https://api.lemonsqueezy.com/v1/licenses/")!

    private init() {
        // Optimistic entitlement: a record on this Mac means it activated before,
        // so the app opens straight in (no paywall flash). A record we could not
        // READ counts too — gating a paying customer on a transient keychain error
        // sends them to re-activate and burn a seat. The background check below
        // settles it either way.
        isLicensed = (getLicenseKey() != nil) || loadResult() == .unreadable
        Task { _ = await hasValidLicense() }
    }

    // MARK: - Public API

    /// Settle the licence for this launch. Network trouble is not proof of anything.
    func hasValidLicense() async -> Bool {
        let stored = loadResult()
        // Unreadable is not absent: leave the app up and look again next launch.
        if stored == .unreadable { return isLicensed }
        guard case .found(let record) = stored else {
            await publish(false)
            return false
        }
        // A key saved by a validate-only build has no seat — claim one now.
        guard let instanceID = record.instanceID else {
            do {
                try await activateLicense(key: record.key)
                return true
            } catch LicenseError.networkError {
                let ok = withinGrace(record)
                await publish(ok)
                return ok
            } catch {
                invalidate(record)
                await publish(false)
                return false
            }
        }
        do {
            let response: ValidateResponse = try await post(
                "validate", body: ["license_key": record.key, "instance_id": instanceID])
            let ok = response.valid
                && (response.license_key?.status ?? "active") == "active"
                && belongsToThisProduct(response.meta)
            if ok { markValidated(record) } else { invalidate(record) }
            await publish(ok)
            return ok
        } catch {
            let ok = withinGrace(record)
            await publish(ok)
            return ok
        }
    }

    /// Claim a seat for this Mac. Throws a user-facing error when the store says no.
    func activateLicense(key: String) async throws {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw LicenseError.invalidKey }

        let response: ActivateResponse
        do {
            response = try await post("activate", body: ["license_key": trimmed, "instance_name": Self.deviceName()])
        } catch {
            throw LicenseError.networkError
        }
        guard response.activated, let instanceID = response.instance?.id else {
            if let message = response.error, message.lowercased().contains("activation limit") {
                throw LicenseError.activationLimitReached
            }
            throw LicenseError.invalidKey
        }
        guard belongsToThisProduct(response.meta) else {
            // Give the seat straight back: it belongs to somebody else's product.
            let _: DeactivateResponse? = try? await post(
                "deactivate", body: ["license_key": trimmed, "instance_id": instanceID])
            throw LicenseError.wrongProduct
        }
        save(LicenseRecord(key: trimmed, instanceID: instanceID, lastValidated: Date()))
        await publish(true)
    }

    /// Release this Mac's seat and forget the key. The only place a key is deleted.
    func deactivateLicense() {
        let record = load()
        clear()
        Task {
            if let record, let instanceID = record.instanceID {
                let _: DeactivateResponse? = try? await self.post(
                    "deactivate", body: ["license_key": record.key, "instance_id": instanceID])
            }
            await self.publish(false)
        }
    }

    /// The key on file, e.g. to prefill the field after a rejection.
    var storedKey: String? { load()?.key }

    // MARK: - Decisions

    private func belongsToThisProduct(_ meta: LicenseMeta?) -> Bool {
        if expectedStoreID > 0 && meta?.store_id != expectedStoreID { return false }
        if expectedProductID > 0 && meta?.product_id != expectedProductID { return false }
        return true
    }

    private func withinGrace(_ record: LicenseRecord) -> Bool {
        guard let last = record.lastValidated else { return false }
        let elapsed = Date().timeIntervalSince(last)
        // A clock more than a day behind the last confirmation is not trusted.
        return elapsed > -86_400 && elapsed < gracePeriod
    }

    private func publish(_ value: Bool) async { isLicensed = value }

    // MARK: - Networking

    nonisolated private func post<T: Decodable>(_ path: String, body: [String: String]) async throws -> T {
        var request = URLRequest(url: Self.apiBase.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 10

        let (data, response) = try await URLSession.shared.data(for: request)
        // 4xx carries a real answer; only the server failing is "unreachable".
        if let http = response as? HTTPURLResponse, http.statusCode >= 500 || http.statusCode == 429 {
            throw LicenseError.networkError
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    /// What this activation is called in the Lemon Squeezy dashboard: the Mac's
    /// name plus a short, non-reversible tag of its hardware UUID, so a second
    /// activation of the same Mac after a reinstall is visibly a duplicate.
    nonisolated private static func deviceName() -> String {
        let name = Host.current().localizedName ?? "Mac"
        return machineTag.map { "\(name) (\($0))" } ?? name
    }

    nonisolated private static let machineTag: String? = {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPlatformExpertDevice"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        guard let uuid = IORegistryEntryCreateCFProperty(
            service, kIOPlatformUUIDKey as CFString, kCFAllocatorDefault, 0
        )?.takeRetainedValue() as? String else { return nil }
        return SHA256.hash(data: Data(uuid.utf8)).prefix(4).map { String(format: "%02X", $0) }.joined()
    }()

    // MARK: - Storage (Keychain in release, UserDefaults in DEBUG)

    private enum LoadResult: Equatable { case found(LicenseRecord), absent, unreadable }

    private func getLicenseKey() -> String? { load()?.key }

    private func load() -> LicenseRecord? {
        if case .found(let record) = loadResult() { return record }
        return nil
    }

    private func loadResult() -> LoadResult {
        #if DEBUG
        guard let data = UserDefaults.standard.data(forKey: "\(keychainAccount)-Debug") else { return .absent }
        return decode(data).map(LoadResult.found) ?? .absent
        #else
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data else { return .absent }
            return decode(data).map(LoadResult.found) ?? .absent
        case errSecItemNotFound:
            return .absent
        default:
            return .unreadable   // the item may well exist; we just could not read it
        }
        #endif
    }

    /// Current JSON records, and the bare key string older builds stored.
    private func decode(_ data: Data) -> LicenseRecord? {
        if let record = try? JSONDecoder().decode(LicenseRecord.self, from: data) { return record }
        guard let key = String(data: data, encoding: .utf8), !key.isEmpty, !key.hasPrefix("{") else { return nil }
        let legacyCheck = UserDefaults.standard.object(forKey: "lastLicenseCheck") as? Date
        return LicenseRecord(key: key, instanceID: nil, lastValidated: legacyCheck)
    }

    private func save(_ record: LicenseRecord) {
        guard let data = try? JSONEncoder().encode(record) else { return }
        #if DEBUG
        UserDefaults.standard.set(data, forKey: "\(keychainAccount)-Debug")
        #else
        let updated = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecItemNotFound else { return }
        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        attributes[kSecAttrSynchronizable as String] = false   // no iCloud sync, no prompts
        SecItemAdd(attributes as CFDictionary, nil)
        #endif
    }

    /// Refresh the confirmation stamp — at most twice a day; it only gates the grace window.
    private func markValidated(_ record: LicenseRecord) {
        if let last = record.lastValidated, Date().timeIntervalSince(last) < 12 * 60 * 60 { return }
        var next = record
        next.lastValidated = Date()
        save(next)
    }

    /// Close the grace window but KEEP the key.
    private func invalidate(_ record: LicenseRecord) {
        guard record.lastValidated != nil else { return }
        var next = record
        next.lastValidated = nil
        save(next)
    }

    private func clear() {
        #if DEBUG
        UserDefaults.standard.removeObject(forKey: "\(keychainAccount)-Debug")
        #else
        SecItemDelete(baseQuery as CFDictionary)
        #endif
        UserDefaults.standard.removeObject(forKey: "lastLicenseCheck")
    }

    private var baseQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: keychainAccount]
    }
}

// MARK: - Models

struct LicenseRecord: Codable, Equatable {
    var key: String
    var instanceID: String?
    var lastValidated: Date?
}

struct LicenseMeta: Decodable {
    let store_id: Int?
    let product_id: Int?
    let variant_id: Int?
}

struct LicenseKeyInfo: Decodable {
    let status: String?
    let activation_limit: Int?
    let activation_usage: Int?
    let expires_at: String?
}

struct LicenseInstance: Decodable {
    let id: String
}

struct ActivateResponse: Decodable {
    let activated: Bool
    let error: String?
    let license_key: LicenseKeyInfo?
    let instance: LicenseInstance?
    let meta: LicenseMeta?
}

struct ValidateResponse: Decodable {
    let valid: Bool
    let error: String?
    let license_key: LicenseKeyInfo?
    let meta: LicenseMeta?
}

struct DeactivateResponse: Decodable {
    let deactivated: Bool
    let error: String?
}

// MARK: - Errors

enum LicenseError: LocalizedError {
    case invalidKey
    case networkError
    case activationLimitReached
    case wrongProduct
    case expired

    var errorDescription: String? {
        switch self {
        case .invalidKey:
            return "That license key wasn't recognised. Check it and try again."
        case .networkError:
            return "Couldn't reach the license server. Check your connection and try again."
        case .activationLimitReached:
            return "This key is already active on its maximum number of Macs. Deactivate it on one of them, or contact support to free a seat."
        case .wrongProduct:
            return "That key is for a different product."
        case .expired:
            return "This license has expired."
        }
    }
}
