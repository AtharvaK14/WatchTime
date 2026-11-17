/**
 * The app's version, taken from package.json at build time (vite.config.ts).
 * The Android build reads the same field for versionName, so this is the
 * installed version on every platform. Undefined outside a Vite build, e.g.
 * in the check scripts; read it through lib/updates/appVersion.ts.
 */
declare const __APP_VERSION__: string | undefined;
