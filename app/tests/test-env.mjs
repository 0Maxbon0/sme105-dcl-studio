import { webcrypto } from "node:crypto";

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

// Node 18 has no `navigator`, and Node 22 exposes one without a StorageManager.
// Recording code must tolerate both; tests still exercise the persistent-storage path.
export const navigatorStorageMock = Object.freeze({
  estimate: async () => ({ quota: 4 * 1024 ** 3, usage: 0 }),
  persist: async () => false,
});

function installNavigatorStorage() {
  const storage = navigatorStorageMock;
  const existing = globalThis.navigator;
  if (!existing) {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true, writable: true, value: { storage },
    });
    return;
  }
  if (existing.storage) return;
  try {
    Object.defineProperty(existing, "storage", {
      configurable: true, writable: true, value: storage,
    });
  } catch {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true, writable: true, value: { ...existing, storage },
    });
  }
}

installNavigatorStorage();
