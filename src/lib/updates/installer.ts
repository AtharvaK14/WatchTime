// Typed proxy for the native APK installer (UpdateInstallerPlugin.java).
//
// Android only, and only for builds distributed through GitHub Releases. The
// web build never offers an install; it links to the release page instead.

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

interface DownloadProgress {
  received: number;
  /** -1 when the server did not say how large the file is. */
  total: number;
}

interface UpdaterPlugin {
  canInstall(): Promise<{ allowed: boolean }>;
  openInstallSettings(): Promise<void>;
  download(options: { url: string }): Promise<void>;
  install(): Promise<void>;
  addListener(event: "progress", listener: (progress: DownloadProgress) => void): Promise<PluginListenerHandle>;
}

const Updater = registerPlugin<UpdaterPlugin>("WatchTimeUpdater");

export function installerSupported(): boolean {
  return Capacitor.getPlatform() === "android";
}

/** Why an install step failed, in terms the Settings screen can act on. */
export type InstallProblem = "offline" | "download-failed" | "not-an-update" | "install-blocked" | "no-installer";

export class InstallError extends Error {
  readonly problem: InstallProblem;
  constructor(problem: InstallProblem, message: string) {
    super(message);
    this.name = "InstallError";
    this.problem = problem;
  }
}

const MESSAGES: Record<InstallProblem, string> = {
  offline: "You're offline. Connect and try the download again.",
  "download-failed": "The download didn't finish. Try again, or get the file from the release page.",
  "not-an-update": "The downloaded file isn't a newer WatchTime package, so it was discarded.",
  "install-blocked":
    "Android isn't allowing WatchTime to install apps yet. Allow it in the settings screen, then come back and install.",
  "no-installer": "This device has no installer for the file. Use the release page instead.",
};

const PROBLEM_BY_CODE: Record<string, InstallProblem> = {
  OFFLINE: "offline",
  DOWNLOAD_FAILED: "download-failed",
  NOT_AN_UPDATE: "not-an-update",
  NOT_DOWNLOADED: "download-failed",
  INSTALL_BLOCKED: "install-blocked",
  NO_INSTALLER: "no-installer",
};

function toInstallError(error: unknown): InstallError {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  // An unknown rejection (an older native build without the plugin, say) is
  // reported as a failed download: the release page is the way forward.
  const problem = PROBLEM_BY_CODE[code] ?? "download-failed";
  return new InstallError(problem, MESSAGES[problem]);
}

export async function canInstallUpdates(): Promise<boolean> {
  if (!installerSupported()) return false;
  try {
    return (await Updater.canInstall()).allowed;
  } catch {
    return false;
  }
}

/** Opens Android's "Install unknown apps" switch for this app. */
export async function openInstallSettings(): Promise<void> {
  try {
    await Updater.openInstallSettings();
  } catch (error) {
    throw toInstallError(error);
  }
}

/**
 * Downloads the release APK. `onProgress` gets a fraction from 0 to 1, or
 * null while the size is unknown.
 */
export async function downloadUpdate(url: string, onProgress: (fraction: number | null) => void): Promise<void> {
  let handle: PluginListenerHandle | undefined;
  try {
    handle = await Updater.addListener("progress", ({ received, total }) => {
      onProgress(total > 0 ? Math.min(received / total, 1) : null);
    });
    await Updater.download({ url });
  } catch (error) {
    throw toInstallError(error);
  } finally {
    await handle?.remove().catch(() => {});
  }
}

/** Hands the downloaded APK to Android's installer, which asks the user to confirm. */
export async function installDownloadedUpdate(): Promise<void> {
  try {
    await Updater.install();
  } catch (error) {
    throw toInstallError(error);
  }
}
