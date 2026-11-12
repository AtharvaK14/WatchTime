package com.indie.watchtime.widget;

import android.appwidget.AppWidgetManager;
import android.content.Intent;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.SeekBar;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.appcompat.widget.SwitchCompat;

import com.indie.watchtime.R;

/**
 * The widget's settings screen: background opacity and colour, corners, text
 * size, compact rows, the title bar and artwork. Each placed widget keeps its
 * own settings (WidgetStore).
 *
 * Declared as android:configure on both providers, so it runs when a widget is
 * added, and again on demand because both are marked reconfigurable - the
 * settings are not a one-shot choice trapped at add time.
 *
 * The preview is the SAME layout the launcher's widget picker renders
 * (widget_preview_up_next / widget_preview_coming_up), inflated normally here
 * rather than as RemoteViews. Reusing it means the picker, this screen and the
 * placed widget cannot show three different designs. Every control updates it
 * as it changes, so what Save applies is what the user was looking at.
 *
 * It is shown over the user's actual wallpaper rather than a flat page, which
 * is the only way a transparency setting can be judged: 40% over a dark
 * wallpaper and 40% over a bright photo are completely different results. See
 * WidgetConfigTheme and WallpaperViewportView for how the wallpaper gets
 * there, given that an app is not allowed to read it.
 *
 * Opacity and colour apply to the widget_bg layer alone, in both the preview
 * and the real widget, so the episode list, its text and artwork stay fully
 * legible at any setting.
 */
public class WidgetConfigActivity extends AppCompatActivity {

    private int appWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;

    private View preview;
    private ImageView previewBackground;
    private TextView valueLabel;

    private int opacity = WidgetStore.DEFAULT_OPACITY;
    private int background;
    private int corners;
    private int textSize;
    private boolean compact;
    private boolean showHeader;
    private boolean showArtwork;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Backing out (back gesture, Cancel) must not leave a half-configured
        // widget on the home screen: the launcher removes it on CANCELED.
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
        background = WidgetStore.getBackground(this, appWidgetId);
        corners = WidgetStore.getCorners(this, appWidgetId);
        textSize = WidgetStore.getTextSize(this, appWidgetId);
        compact = WidgetStore.getCompact(this, appWidgetId);
        showHeader = WidgetStore.getShowHeader(this, appWidgetId);
        showArtwork = WidgetStore.getShowArtwork(this, appWidgetId);

        FrameLayout previewHost = findViewById(R.id.config_preview_host);
        preview = LayoutInflater.from(this).inflate(previewLayoutFor(appWidgetId), previewHost, false);
        previewHost.addView(preview);
        previewBackground = preview.findViewById(R.id.widget_bg);
        rememberTextSizes(preview);

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

        bindChoice(R.id.config_background, background, i -> background = i);
        bindChoice(R.id.config_corners, corners, i -> corners = i);
        bindChoice(R.id.config_text_size, textSize, i -> textSize = i);
        bindSwitch(R.id.config_compact, compact, v -> compact = v);
        bindSwitch(R.id.config_header, showHeader, v -> showHeader = v);
        bindSwitch(R.id.config_artwork, showArtwork, v -> showArtwork = v);

        applyToPreview();

        Button save = findViewById(R.id.config_save);
        save.setText(isReconfiguring() ? R.string.widget_config_save_existing : R.string.widget_config_save);
        save.setOnClickListener(v -> commit());

        findViewById(R.id.config_cancel).setOnClickListener(v -> finish());
    }

    private interface IntSetter { void set(int value); }
    private interface BoolSetter { void set(boolean value); }

    /** A segmented choice: its options are the group's children, in order. */
    private void bindChoice(int groupId, int selected, IntSetter onChange) {
        RadioGroup group = findViewById(groupId);
        View option = group.getChildAt(selected);
        if (option instanceof RadioButton) ((RadioButton) option).setChecked(true);
        group.setOnCheckedChangeListener((g, checkedId) -> {
            onChange.set(g.indexOfChild(g.findViewById(checkedId)));
            applyToPreview();
        });
    }

    private void bindSwitch(int id, boolean checked, BoolSetter onChange) {
        SwitchCompat toggle = findViewById(id);
        toggle.setChecked(checked);
        toggle.setOnCheckedChangeListener((b, value) -> {
            onChange.set(value);
            applyToPreview();
        });
    }

    /**
     * Whether this widget is already on the home screen (opened to edit it)
     * rather than being added right now, which decides the button's wording.
     */
    private boolean isReconfiguring() {
        int[] placed = AppWidgetManager.getInstance(this)
                .getAppWidgetIds(new android.content.ComponentName(this, providerClassFor(appWidgetId)));
        if (placed == null) return false;
        for (int id : placed) {
            if (id == appWidgetId) return true;
        }
        return false;
    }

    /** The preview shows every setting as the real widget will. */
    private void applyToPreview() {
        if (previewBackground != null) {
            previewBackground.setImageResource(WidgetStore.backgroundDrawable(corners));
            previewBackground.setColorFilter(WidgetStore.backgroundColor(background));
            previewBackground.setAlpha(WidgetStore.opacityToAlpha(opacity));
        }
        if (valueLabel != null) {
            valueLabel.setText(getString(R.string.widget_config_opacity_value, opacity));
        }
        if (preview != null) {
            View header = preview.findViewById(R.id.preview_header);
            if (header != null) header.setVisibility(showHeader ? View.VISIBLE : View.GONE);
            applyToViews(preview, WidgetStore.textScale(textSize));
        }
    }

    /**
     * Walks the preview: artwork is hidden when Artwork is off or rows are
     * compact, the second text line ("detail") when rows are compact, and every
     * text is scaled from its own original size.
     */
    private void applyToViews(View view, float scale) {
        Object tag = view.getTag();
        if ("poster".equals(tag)) {
            view.setVisibility(showArtwork && !compact ? View.VISIBLE : View.GONE);
        } else if ("detail".equals(tag)) {
            view.setVisibility(compact ? View.GONE : View.VISIBLE);
        }
        if (view instanceof TextView) {
            Object base = view.getTag(R.id.config_base_text_size);
            if (base instanceof Float) {
                ((TextView) view).setTextSize(TypedValue.COMPLEX_UNIT_PX, (Float) base * scale);
            }
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) applyToViews(group.getChildAt(i), scale);
        }
    }

    /** Records each preview text's designed size, so scaling never compounds. */
    private void rememberTextSizes(View view) {
        if (view instanceof TextView) {
            view.setTag(R.id.config_base_text_size, ((TextView) view).getTextSize());
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) rememberTextSizes(group.getChildAt(i));
        }
    }

    private void commit() {
        WidgetStore.setOpacity(this, appWidgetId, opacity);
        WidgetStore.saveAppearance(this, appWidgetId, background, corners, textSize, compact, showHeader, showArtwork);

        // Redraw now rather than waiting for the next update: the container
        // (background, title bar) here, and the rows through the list factory.
        AppWidgetManager manager = AppWidgetManager.getInstance(this);
        providerFor(appWidgetId).render(this, manager, appWidgetId);
        manager.notifyAppWidgetViewDataChanged(appWidgetId, R.id.widget_list);

        Intent result = new Intent();
        result.putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        setResult(RESULT_OK, result);
        finish();
    }

    // ---- Which widget this is ----------------------------------------------
    // One activity serves every widget; the provider recorded for the id says
    // which preview to show and which provider to ask for a redraw.

    private int previewLayoutFor(int id) {
        switch (BaseWidgetProvider.kindOf(this, id)) {
            case COMING_UP: return R.layout.widget_preview_coming_up;
            case MOVIES_TO_WATCH: return R.layout.widget_preview_movies;
            case MOVIE_RELEASES: return R.layout.widget_preview_movie_releases;
            default: return R.layout.widget_preview_up_next;
        }
    }

    private Class<?> providerClassFor(int id) {
        return providerFor(id).getClass();
    }

    private BaseWidgetProvider providerFor(int id) {
        return BaseWidgetProvider.providerFor(BaseWidgetProvider.kindOf(this, id));
    }
}
