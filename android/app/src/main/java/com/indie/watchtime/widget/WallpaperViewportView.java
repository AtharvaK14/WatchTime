package com.indie.watchtime.widget;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.View;

import androidx.core.content.ContextCompat;

import com.indie.watchtime.R;

/**
 * Punches a rounded hole in the appearance screen so the user's real wallpaper
 * shows through it.
 *
 * An app cannot simply read the wallpaper and draw it: since Android 13,
 * WallpaperManager.getDrawable() throws SecurityException for any app
 * targeting 33+, and there is no permission an ordinary app can hold to get
 * around that. What an app CAN do is ask the window manager to composite the
 * wallpaper behind its own window - android:windowShowWallpaper on a
 * translucent window, set in WidgetConfigTheme. The wallpaper then appears
 * wherever the window draws nothing opaque.
 *
 * Which is what this view controls. It fills itself with the page colour and
 * then clears a rounded rectangle back to full transparency, so the wallpaper
 * is revealed in exactly that shape and nowhere else. The widget preview is
 * drawn on top of it, inside the hole.
 *
 * The CLEAR xfermode needs an offscreen buffer to erase into, hence the
 * software layer; without it the clear would have nothing to punch through and
 * the hole would simply not appear.
 */
public class WallpaperViewportView extends View {

    private static final float HOLE_RADIUS_DP = 20f;
    private static final float HOLE_INSET_X_DP = 16f;
    private static final float HOLE_INSET_Y_DP = 6f;

    private final Paint scrimPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint holePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF hole = new RectF();

    private final float radiusPx;
    private final float insetXPx;
    private final float insetYPx;

    public WallpaperViewportView(Context context, AttributeSet attrs) {
        super(context, attrs);

        setLayerType(LAYER_TYPE_SOFTWARE, null);

        scrimPaint.setColor(ContextCompat.getColor(context, R.color.widget_bg));
        holePaint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));

        float density = context.getResources().getDisplayMetrics().density;
        radiusPx = HOLE_RADIUS_DP * density;
        insetXPx = HOLE_INSET_X_DP * density;
        insetYPx = HOLE_INSET_Y_DP * density;
    }

    @Override
    protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
        super.onSizeChanged(width, height, oldWidth, oldHeight);
        hole.set(insetXPx, insetYPx, width - insetXPx, height - insetYPx);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        canvas.drawRect(0f, 0f, getWidth(), getHeight(), scrimPaint);
        canvas.drawRoundRect(hole, radiusPx, radiusPx, holePaint);
    }
}
