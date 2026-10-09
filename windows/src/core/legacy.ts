// What the pages kept under the app's old name, moved to Lumo's keys once
// (the folders and the keychain are moved by src-tauri/src/migrate.rs, the only
// other place the old name is written). Each page imports this module first,
// before anything reads its storage; a key Lumo already has is never replaced.

export const OLD_PREFIX = "coucou.";
const KEYS = ["chats.v1", "settings.page", "claudePlanUsage"];

export function moveOldStorage(storage: Storage | null = typeof window === "undefined" ? null : window.localStorage) {
  if (!storage) return;
  for (const key of KEYS) {
    try {
      const old = storage.getItem(OLD_PREFIX + key);
      if (old == null) continue;
      if (storage.getItem(`lumo.${key}`) == null) storage.setItem(`lumo.${key}`, old);
      storage.removeItem(OLD_PREFIX + key);
    } catch {
      // Storage refused: what was there stays where it was.
    }
  }
}

// Imported first by each page, so this runs before any module reads its storage.
moveOldStorage();
