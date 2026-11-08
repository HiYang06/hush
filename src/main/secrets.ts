import { safeStorage } from 'electron'

// On macOS the encryption key lives in the system keychain, so the ciphertext is safe to keep in SQLite (D-016).
export function encryptSecret(plain: string): Buffer {
  return safeStorage.encryptString(plain)
}

export function decryptSecret(encrypted: Buffer): string {
  return safeStorage.decryptString(encrypted)
}
