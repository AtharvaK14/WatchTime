// Folders the backups are written to, as BackupStores.
//
// Dated backups go to Directory.External, Context.getExternalFilesDir(): a
// folder that belongs to this app, needs no permission, and is removed on
// uninstall. They protect a working install against a cleared or damaged
// library, not against a reinstall.
//
// The snapshot for Android's own backup goes to Directory.Data,
// Context.getFilesDir(): internal storage, always available, and the
// directory the backup rules point at (see snapshot.ts).

import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { BackupStore } from "./pipeline";

/** Dated backups, API keys included. Never part of Android's backup. */
export const LOCAL_BACKUP_DIR = "backups";

/**
 * Where an earlier build of this branch kept the Android-backup copy. Read
 * by nothing; deleted once so it does not linger.
 */
const LEGACY_SYSTEM_DIR = "system-backup";
const LEGACY_SYSTEM_FILE = "watchtime-latest.json";

export function folderStore(folder: string, directory: Directory): BackupStore {
  const at = (name: string) => ({ path: `${folder}/${name}`, directory });
  return {
    async list() {
      try {
        const { files } = await Filesystem.readdir({ path: folder, directory });
        return files.filter((f) => f.type === "file").map((f) => f.name);
      } catch {
        // The folder is created by the first write. Until then there is
        // nothing in it, which is not an error.
        return [];
      }
    },
    async write(name, data) {
      await Filesystem.writeFile({ ...at(name), data, encoding: Encoding.UTF8, recursive: true });
    },
    async read(name) {
      const { data } = await Filesystem.readFile({ ...at(name), encoding: Encoding.UTF8 });
      // With an encoding the plugin returns text; a Blob only comes back on web.
      return typeof data === "string" ? data : await data.text();
    },
    async rename(from, to) {
      await Filesystem.rename({ from: at(from).path, to: at(to).path, directory });
    },
    async remove(name) {
      await Filesystem.deleteFile(at(name));
    },
  };
}

export function externalFolderStore(folder: string): BackupStore {
  return folderStore(folder, Directory.External);
}

export function internalFolderStore(folder: string): BackupStore {
  return folderStore(folder, Directory.Data);
}

export async function removeLegacySystemCopy(): Promise<void> {
  try {
    await Filesystem.deleteFile({ path: `${LEGACY_SYSTEM_DIR}/${LEGACY_SYSTEM_FILE}`, directory: Directory.External });
  } catch {
    // Not there, which is the usual case.
  }
}

/** The folder's path as the user would see it in a file manager, or null if it cannot be resolved. */
export async function localBackupFolderPath(): Promise<string | null> {
  try {
    const { uri } = await Filesystem.getUri({ path: LOCAL_BACKUP_DIR, directory: Directory.External });
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  } catch {
    return null;
  }
}
