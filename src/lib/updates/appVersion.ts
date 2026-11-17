/**
 * The version of the running app.
 *
 * package.json's "version" is the single source of truth. Vite inlines it
 * here, and android/app/build.gradle reads the same field for versionName,
 * so on Android this always equals the installed APK's versionName: the web
 * bundle and the APK are built from the same commit.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
