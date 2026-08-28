package com.indie.watchtime.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.Intent;
import android.os.Bundle;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.indie.watchtime.R;

/**
 * The widget's appearance screen: how transparent its background should be.
 *
 * Declared as android:configure on both providers, so it runs when a widget is
 * added, and again on demand because both are marked reconfigurable - the
 * setting is not a one-shot choice trapped at add time.
 *
 * The preview is the SAME layout the launcher's widget picker renders
 * (widget_preview_up_next / widget_preview_coming_up), inflated normally here
 * rather than as RemoteViews. Reusing it means the picker, this screen and the
 * placed widget cannot show three different designs, and it is why the slider
 * previews truthfully.
 *
 * It is shown over the user's actual wallpaper rather than a flat page, which
 * is the only way a transparency setting can be judged: 40% over a dark
 * wallpaper and 40% over a bright photo are completely different results. See
 * WidgetConfigTheme and WallpaperViewportView for how the wallpaper gets
 * there, given that an app is not allowed to read it.
 *
 * Opacity is applied to the widget_bg layer alone, in both the preview and the
 * real widget. Nothing above that layer is touched, so the episode list, its
 * text, its artwork and its separators stay fully opaque at every setting -
 * including 0%, where the background disappears entirely and the list is still
 * perfectly readable.
 */
public class WidgetConfigActivity extends AppCompatActivity {

    private int appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private ImageView previewBackground;
    private TextView valueLabel;
    private int opacity = WidgetStore.DEFAULT_OPACITY;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Cancelled unless the user completes the screen: on RESULT_CANCELED at
        // add time the launcher drops the widget rather than placing a
        // half-configured one.
        setResult(RESULT_CANCELED);

        Intent intent = getIntent();
        Bundle extras = intent == null ? null : intent.getExtras();
        if (extras != null) {
            appWidgetId = extras.getInt(AppWidgetManager.EXTRA_APPWIDGET_ID,
                    AppWidgetManager.INVALID_APPWIDGET_ID);
        }
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
            finish();
            return;
        }

        setContentView(R.layout.activity_widget_config);

        opacity = WidgetStore.getOpacity(this, appWidgetId);

        FrameLayout previewHost = findViewById(R.id.config_preview_host);
        View preview = LayoutInflater.from(this).inflate(previewLayoutFor(appWidgetId), previewHost, false);
        previewHost.addView(preview);
        previewBackground = preview.findViewById(R.id.widget_bg);

        valueLabel = findViewById(R.id.config_opacity_value);

        SeekBar slider = findViewById(R.id.config_opacity_slider);
        slider.setProgress(opacity);
        slider.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                opacity = progress;
                applyToPreview();
            }

            @Override
            public void onStartTrackingTouch(SeekBar seekBar) {}

            @Override
            public void onStopTrackingTouch(SeekBar seekBar) {}
        });
        applyToPreview();

        Button save = findViewById(R.id.config_save);
        // Adding versus adjusting an existing widget are different actions and
        // the button should not claim to be the first when it is the second.
        save.setText(isReconfiguring() ? R.string.widget_config_save_existing : R.string.widget_config_save);
        save.setOnClickListener(v -> commit());

        // Leaves RESULT_CANCELED in place, which at add time tells the launcher
        // not to place the widget at all, and when reconfiguring simply drops
        // the unsaved change.
        findViewById(R.id.config_cancel).setOnClickListener(v -> finish());
    }

    /** True when the launcher opened this for a widget already on a home screen. */
    private boolean isReconfiguring() {
        int[] placed = AppWidgetManager.getInstance(this)
                .getAppWidgetIds(new android.content.ComponentName(this, providerClassFor(appWidgetId)));
        if (placed == null) return false;
        for (int id : placed) {
            if (id == appWidgetId) return true;
        }
        return false;
    }

    private void applyToPreview() {
        if (previewBackground != null) {
            // The same call the real widget makes through RemoteViews, so the
            // preview cannot flatter the result.
            previewBackground.setAlpha(WidgetStore.opacityToAlpha(opacity));
        }
        if (valueLabel != null) {
            valueLabel.setText(getString(R.string.widget_config_opacity_value, opacity));
        }
    }

    private void commit() {
        WidgetStore.setOpacity(this, appWidgetId, opacity);

        // A widget added through a configuration activity gets no automatic
        // APPWIDGET_UPDATE broadcast: drawing it for the first time is this
        // screen's responsibility, and skipping it leaves a blank widget.
        AppWidgetManager manager = AppWidgetManager.getInstance(this);
        providerFor(appWidgetId).render(this, manager, appWidgetId);
        manager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.widget_list);

        Intent result = new Intent();
        result.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        setResult(RESULT_OK, result);
        finish();
    }

    // ---- Which of the two widgets is being configured ----------------------
    //
    // Read from the widget's own provider info rather than passed in, because
    // the launcher decides which provider it is launching this for and the
    // intent carries only the id.

    private boolean isComingUp(int id) {
        AppWidgetProviderInfo info = AppWidgetManager.getInstance(this).getAppWidgetInfo(id);
        return info != null && info.provider != null
                && ComingUpWidgetProvider.class.getName().equals(info.provider.getClassName());
    }

    private int previewLayoutFor(int id) {
        return isComingUp(id) ? R.layout.widget_preview_coming_up : R.layout.widget_preview_up_next;
    }

    private Class<?> providerClassFor(int id) {
        return isComingUp(id) ? ComingUpWidgetProvider.class : WatchNextWidgetProvider.class;
    }

    private BaseWidgetProvider providerFor(int id) {
        return isComingUp(id) ? new ComingUpWidgetProvider() : new WatchNextWidgetProvider();
    }
}
