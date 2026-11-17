package com.indie.watchtime.backup;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Answers one question for src/lib/autoBackup/native.ts: can Android encrypt
 * this app's backup end to end right now?
 *
 * Android's backup is end-to-end encrypted "on devices running Android 9 or
 * higher as long as the user has enabled backup ... and has set a screen
 * lock" (developer.android.com/identity/data/autobackup). The API keys file
 * is only written while that holds, because the Android 12+ backup rules have
 * no per-file way to say "only if encrypted" - the older rules
 * (res/xml-v28/backup_rules.xml) do, and use it as well.
 *
 * Whether backup itself is switched on is not visible to apps, and does not
 * matter here: with backup off, nothing leaves the device at all.
 */
@CapacitorPlugin(name = "WatchTimeBackup")
public class BackupSupportPlugin extends Plugin {

    @PluginMethod
    public void encryptionAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", endToEndEncryptionPossible(getContext()));
        call.resolve(result);
    }

    static boolean endToEndEncryptionPossible(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false;
        KeyguardManager keyguard = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        return keyguard != null && keyguard.isDeviceSecure();
    }
}
