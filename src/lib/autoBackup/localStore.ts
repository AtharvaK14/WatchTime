// The app-owned folder on Android, as a BackupStore.
//
// Directory.External is Context.getExternalFilesDir(): a folder on shared
// storage that belongs to this app, needs no permission to write, and is
// removed when the app is uninstalled. So these files protect a working
// install against a cleared or corrupted database. They do not survive a
// reinstall; only the copy Android's own backup carries does (see
// SYSTEM_BACKUP_DIR and docs/backup-and-updates.md).

import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import type { BackupStore } from "./pipeline";

/** Dated backups, API keys included. Excluded from Android's own backup. */
export const LOCAL_BACKUP_DIR = "backups";

/**
 * One file, API keys removed, and the only thing Android's Auto Backup is
 * allowed to take (res/xml/backup_rules.xml and data_extraction_rules.xml
 * name this exact path - keep the three in step).
 */
export const SYSTEM_BACKUP_DIR = "system-backup";
export const SYSTEM_BACKUP_FILE = "watchtime-latest.json";

export function externalFolderStore(folder: string): BackupStore {
  const at = (name: string) => ({ path: `${folder}/${name}`, directory: Directory.External });
  return {
    async list() {
      try {
        const { files } = await Filesystem.readdir({ path: folder, directory: Directory.External });
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
      await Filesystem.rename({ from: at(from).path, to: at(to).path, directory: Directory.External });
    },
    async remove(name) {
      await Filesystem.deleteFile(at(name));
    },
  };
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
