// Creating the desktop service must not initialize Keychain. These closures are
// invoked only when the user explicitly uses or saves an API key. Keep the
// existing ciphertext format so previously saved keys remain readable.
export function createDesktopKeyProtection(storage) {
  return {
    isAvailable: () => storage.isEncryptionAvailable(),
    encrypt: (value) => storage.encryptString(value),
    decrypt: (value) => storage.decryptString(value),
  };
}
