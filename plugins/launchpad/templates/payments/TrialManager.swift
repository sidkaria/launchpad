import Foundation
import Security

/// Client-only free-trial tracker. No backend, no network, no device fingerprint.
///
/// The trial start (and a monotonic `lastSeen`) live in a Keychain generic-password
/// item, separate from the license item. Deleting/reinstalling the `.app` does NOT
/// remove Keychain items, so a reinstall doesn't reset the trial for a normal user.
/// A rollback guard (`effectiveNow = max(now, lastSeen)`) stops "set the clock back".
@MainActor
final class TrialManager: ObservableObject {
    static let shared = TrialManager()

    static let trialDays = {{TRIAL_DAYS}}

    struct Status {
        var started = false
        var active = false
        var expired = false
        var daysRemaining = 0
        var firstLaunch = false
    }

    @Published private(set) var status = Status()

    private let trialKey = "{{KEYCHAIN_ACCOUNT}}-Trial"

    private init() { evaluate() }

    // MARK: - Evaluation

    /// Evaluate the trial, persisting first-launch/rollback state. Returns the fresh status.
    @discardableResult
    func evaluate() -> Status {
        let now = Date().timeIntervalSince1970
        var next = Status()

        if let record = load() {
            // Rollback guard: never trust a clock that moved backwards.
            let effectiveNow = max(now, record.lastSeen)
            save(start: record.start, lastSeen: effectiveNow)

            let elapsedDays = (effectiveNow - record.start) / 86400.0
            let active = elapsedDays < Double(Self.trialDays)

            next.started = true
            next.active = active
            next.expired = !active
            next.daysRemaining = max(0, Int(ceil(Double(Self.trialDays) - elapsedDays)))
            next.firstLaunch = false
        } else {
            // First launch: start the clock now.
            save(start: now, lastSeen: now)

            next.started = true
            next.active = true
            next.expired = false
            next.daysRemaining = Self.trialDays
            next.firstLaunch = true
        }

        publish(next)
        return next
    }

    private func publish(_ s: Status) {
        status = s
    }

    // MARK: - Keychain (Release-grade persistence)

    private struct Record { let start: Double; let lastSeen: Double }

    private func save(start: Double, lastSeen: Double) {
        let value = "\(start)|\(lastSeen)"
        guard let data = value.data(using: .utf8) else { return }

        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: trialKey,
        ]

        // Update in place; add only when absent. Never delete-then-add: a re-add
        // rebuilds the item's access list (discarding "Always Allow"), and a delete
        // whose query carries the value data can fail to match — after which the
        // add fails as a duplicate, silently, and `lastSeen` stops advancing.
        let updated = SecItemUpdate(match as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecItemNotFound else { return }
        var attributes = match
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        attributes[kSecAttrSynchronizable as String] = false  // Don't sync to iCloud to avoid keychain prompts
        SecItemAdd(attributes as CFDictionary, nil)
    }

    private func load() -> Record? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: trialKey,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let string = String(data: data, encoding: .utf8) else {
            return nil
        }

        let parts = string.split(separator: "|")
        guard parts.count == 2,
              let start = Double(parts[0]),
              let lastSeen = Double(parts[1]) else {
            return nil
        }

        return Record(start: start, lastSeen: lastSeen)
    }
}
