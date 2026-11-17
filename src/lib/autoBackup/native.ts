// Typed proxy for BackupSupportPlugin.java.

import { registerPlugin } from "@capacitor/core";

interface BackupSupportPlugin {
  encryptionAvailable(): Promise<{ available: boolean }>;
}

const BackupSupport = registerPlugin<BackupSupportPlugin>("WatchTimeBackup");

/**
 * Whether Android can encrypt the app's backup end to end (Android 9+ with
 * a screen lock). False when it cannot be determined, so the API keys are
 * left out rather than risked.
 */
export async function backupEncryptionAvailable(): Promise<boolean> {
  try {
    return (await BackupSupport.encryptionAvailable()).available;
  } catch {
    return false;
  }
}
