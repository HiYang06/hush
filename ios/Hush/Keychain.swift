import Foundation
import Security

/// The signed-in account. The token is a password to the user's data, so it lives in the Keychain,
/// not in the database or UserDefaults.
struct Account: Codable {
    var email: String
    var token: String
}

enum Keychain {
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "uk.evildentist.hush",
        kSecAttrAccount as String: "sync_account",
    ] }

    static func load() -> Account? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true]) { $1 } as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Account.self, from: data)
    }

    static func save(_ account: Account) {
        SecItemDelete(query as CFDictionary)
        let attributes: [String: Any] = [
            kSecValueData as String: try! JSONEncoder().encode(account),
            // ThisDeviceOnly: not carried to other devices by iCloud Keychain or backups; each signs in itself.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}
