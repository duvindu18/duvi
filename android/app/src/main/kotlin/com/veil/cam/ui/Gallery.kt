package com.veil.cam.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.drawable.GradientDrawable
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.text.format.DateUtils
import android.util.LruCache
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.GridView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import com.veil.cam.R
import com.veil.cam.media.MediaStorage
import com.veil.cam.media.SilenceDetector
import com.veil.cam.media.Span
import com.veil.cam.media.Spans
import com.veil.cam.media.Trimmer
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.roundToInt

private fun fmt(us: Long): String {
    val s = (us / 1_000_000L).coerceAtLeast(0)
    return "%d:%02d".format(s / 60, s % 60)
}

private fun Activity.dp(v: Float) = Theme.dpi(this, v)

/** Private storage -> other apps, only for clips the user chooses to share. */
class ClipProvider : ContentProvider() {
    override fun onCreate() = true

    private fun fileFor(uri: Uri): File? {
        val ctx = context ?: return null
        val name = uri.lastPathSegment ?: return null
        return MediaStorage.list(ctx).firstOrNull { it.name == name }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor? =
        fileFor(uri)?.let { ParcelFileDescriptor.open(it, ParcelFileDescriptor.MODE_READ_ONLY) }

    override fun getType(uri: Uri) = if (uri.lastPathSegment?.endsWith(".mp4") == true) "video/mp4" else "image/jpeg"

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor? {
        val f = fileFor(uri) ?: return null
        return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf(f.name, f.length())) }
    }

    override fun insert(uri: Uri, values: ContentValues?) = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0

    companion object {
        fun uriFor(f: File): Uri = Uri.parse("content://com.veil.cam.clips/${Uri.encode(f.name)}")

        fun share(a: Activity, f: File) {
            val i = Intent(Intent.ACTION_SEND).apply {
                type = if (f.extension == "mp4") "video/mp4" else "image/jpeg"
                putExtra(Intent.EXTRA_STREAM, uriFor(f))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            a.startActivity(Intent.createChooser(i, "Share"))
        }
    }
}

internal fun exportAsync(a: Activity, f: File) {
    Thread {
        val msg = runCatching { MediaStorage.exportToGallery(a, f); "Saved to the phone gallery (VeilCam)" }.getOrElse { "Export failed: ${it.message}" }
        a.runOnUiThread { android.widget.Toast.makeText(a, msg, android.widget.Toast.LENGTH_SHORT).show() }
    }.start()
}

/** Shared pieces of the library screens. */
private object G {
    fun confirmDelete(a: Activity, what: String, action: () -> Unit) {
        AlertDialog.Builder(a, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setMessage("This $what will be deleted. This cannot be undone.")
            .setPositiveButton("Delete $what") { _, _ -> action() }.setNegativeButton("Cancel", null).show()
    }

    fun insets(v: View, extra: Float = 8f) {
        v.setOnApplyWindowInsetsListener { view, ins ->
            val s = ins.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val e = Theme.dpi(view.context, extra)
            view.setPadding(s.left + e, s.top + e, s.right + e, s.bottom + e)
            ins
        }
    }

    fun dateTitle(f: File): Pair<String, String> {
        val t = f.lastModified()
        val day = when {
            DateUtils.isToday(t) -> "Today"
            DateUtils.isToday(t + DateUtils.DAY_IN_MILLIS) -> "Yesterday"
            else -> SimpleDateFormat("d MMMM yyyy", Locale.getDefault()).format(Date(t))
        }
        return day to SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(t))
    }

    /** Glass context menu next to [anchor]. */
    fun menu(a: Activity, anchor: View, items: List<Triple<String, Glyph, Boolean>>, onPick: (Int) -> Unit) {
        val col = LinearLayout(a).apply {
            orientation = LinearLayout.VERTICAL
            background = GlassDrawable(a.dp(14f).toFloat(), 0xF22C2C2E.toInt(), a.resources.displayMetrics.density)
            elevation = a.dp(12f).toFloat()
        }
        val pw = PopupWindow(col, a.dp(250f), ViewGroup.LayoutParams.WRAP_CONTENT, true)
        items.forEachIndexed { i, (label, glyph, red) ->
            if (i > 0) col.addView(View(a).apply { setBackgroundColor(Theme.SEPARATOR) }, LinearLayout.LayoutParams(-1, 1))
            val row = LinearLayout(a).apply {
                gravity = Gravity.CENTER_VERTICAL; setPadding(a.dp(16f), 0, a.dp(14f), 0); minimumHeight = a.dp(46f)
                isClickable = true
                setOnClickListener { pw.dismiss(); onPick(i) }
            }
            row.addView(TextView(a).apply { text = label; textSize = 16f; setTextColor(if (red) Theme.RED else Theme.TEXT) }, LinearLayout.LayoutParams(0, -2, 1f))
            row.addView(GlyphView(a, glyph, if (red) Theme.RED else Theme.TEXT), LinearLayout.LayoutParams(a.dp(20f), a.dp(20f)))
            col.addView(row)
        }
        pw.animationStyle = android.R.style.Animation_Dialog
        pw.showAsDropDown(anchor, 0, -anchor.height / 3)
    }
}

/** A bare glyph. */
class GlyphView(ctx: android.content.Context, var glyph: Glyph, private val color: Int = Theme.TEXT) : View(ctx) {
    private val p = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(c: android.graphics.Canvas) { p.color = color; Glyphs.draw(c, glyph, width / 2f, height / 2f, minOf(width, height).toFloat(), p) }
}

/** Library: the private clips and photos (hidden from the phone gallery), newest at the bottom. */
class GalleryActivity : Activity() {
    private lateinit var grid: GridView
    private lateinit var subtitle: TextView
    private var files: List<File> = emptyList()
    private val pool = Executors.newFixedThreadPool(2)
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LruCache<String, Bitmap>(48 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private val durations = HashMap<String, String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        grid = GridView(this).apply {
            numColumns = 3
            horizontalSpacing = dp(2f); verticalSpacing = dp(2f)
            stretchMode = GridView.STRETCH_COLUMN_WIDTH
            clipToPadding = false
            setOnItemClickListener { _, v, pos, _ -> open(files[pos], v) }
            setOnItemLongClickListener { _, v, pos, _ -> menu(files[pos], v); true }
        }
        root.addView(grid, FrameLayout.LayoutParams(-1, -1))
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(0xF2000000.toInt(), 0xB3000000.toInt(), 0x00000000))
        }
        val bar = FrameLayout(this)
        bar.addView(GlassButton(this, Glyph.BACK, "Camera", 40f).apply { setOnClickListener { finish() } }, FrameLayout.LayoutParams(-2, -2, Gravity.START))
        header.addView(bar)
        header.addView(TextView(this).apply { text = "Library"; textSize = 32f; typeface = Theme.bold; setTextColor(Theme.TEXT); setPadding(dp(4f), dp(8f), 0, 0) })
        subtitle = TextView(this).apply { textSize = 13f; setTextColor(Theme.SECONDARY); setPadding(dp(4f), 0, 0, dp(14f)) }
        header.addView(subtitle)
        root.addView(header, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        G.insets(header, 12f)
        root.setOnApplyWindowInsetsListener { _, ins ->
            val s = ins.getInsets(WindowInsets.Type.systemBars())
            header.post { grid.setPadding(0, header.height, 0, s.bottom + dp(20f)) }
            header.dispatchApplyWindowInsets(ins)
            ins
        }
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        files = MediaStorage.list(this).reversed() // oldest first, newest at the bottom
        val clips = files.count { it.extension == "mp4" }
        val photos = files.size - clips
        subtitle.text = listOfNotNull(
            if (clips > 0) "$clips video${if (clips == 1) "" else "s"}" else null,
            if (photos > 0) "$photos photo${if (photos == 1) "" else "s"}" else null,
        ).joinToString(", ").ifEmpty { "No videos or photos yet" } + " · private, not in the phone gallery"
        grid.adapter = Adapter()
        grid.post { grid.setSelection(files.size - 1) }
    }

    override fun onDestroy() { pool.shutdownNow(); super.onDestroy() }

    private fun open(f: File, v: View?) {
        startActivity(Intent(this, if (f.extension == "mp4") PlayerActivity::class.java else PhotoActivity::class.java).putExtra("path", f.absolutePath))
        @Suppress("DEPRECATION") overridePendingTransition(R.anim.veil_zoom_in, R.anim.veil_hold)
    }

    private fun menu(f: File, cell: View) {
        cell.tick()
        cell.spring(Spring.BOUNCY).scaleX(1.06f).scaleY(1.06f).withEndAction { cell.spring(Spring.SMOOTH).scaleX(1f).scaleY(1f).start() }.start()
        G.menu(this, cell, listOf(
            Triple("Save to Phone Gallery", Glyph.EXPORT, false),
            Triple("Share", Glyph.SHARE, false),
            Triple("Delete", Glyph.TRASH, true),
        )) { which ->
            when (which) {
                0 -> exportAsync(this, f)
                1 -> ClipProvider.share(this, f)
                2 -> G.confirmDelete(this, if (f.extension == "mp4") "video" else "photo") { f.delete(); onResume() }
            }
        }
    }

    private inner class Adapter : BaseAdapter() {
        override fun getCount() = files.size
        override fun getItem(i: Int) = files[i]
        override fun getItemId(i: Int) = i.toLong()
        override fun getView(i: Int, convert: View?, parent: ViewGroup?): View {
            val f = files[i]
            val side = ((parent?.width ?: grid.width) - dp(4f)) / 3
            val cell = (convert as? FrameLayout) ?: FrameLayout(this@GalleryActivity).apply {
                setBackgroundColor(Theme.SHEET)
                addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; tag = "img" }, FrameLayout.LayoutParams(-1, -1))
                addView(TextView(context).apply {
                    tag = "label"; setTextColor(Color.WHITE); textSize = 12f; typeface = Theme.semibold
                    setShadowLayer(4f, 0f, 1f, 0x99000000.toInt())
                }, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, dp(6f), dp(4f)) })
            }
            cell.layoutParams = ViewGroup.LayoutParams(-1, side.coerceAtLeast(1))
            val img = cell.findViewWithTag<ImageView>("img")
            val label = cell.findViewWithTag<TextView>("label")
            img.setImageBitmap(cache.get(f.path))
            label.text = if (f.extension == "mp4") durations[f.path] ?: "" else ""
            cell.setTag(R.id.cell_file, f.path)
            if (cache.get(f.path) == null || (f.extension == "mp4" && durations[f.path] == null)) pool.execute {
                val (bmp, dur) = thumb(f)
                main.post {
                    if (bmp != null) cache.put(f.path, bmp)
                    if (dur != null) durations[f.path] = dur
                    if (cell.getTag(R.id.cell_file) == f.path) {
                        img.setImageBitmap(bmp)
                        label.text = dur ?: ""
                    }
                }
            }
            return cell
        }
    }

    private fun thumb(f: File): Pair<Bitmap?, String?> = runCatching {
        if (f.extension == "mp4") {
            MediaMetadataRetriever().use { r ->
                r.setDataSource(f.absolutePath)
                val dur = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0
                val b = cache.get(f.path) ?: r.getScaledFrameAtTime(minOf(1_000_000L, dur * 500), MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 360, 360)
                b to fmt(dur * 1000)
            }
        } else {
            BitmapFactory.decodeFile(f.absolutePath, BitmapFactory.Options().apply { inSampleSize = 8 }) to null
        }
    }.getOrDefault(null to null)
}

/** Top and bottom glass chrome of the viewers; tap the picture to hide it. */
private class ViewerChrome(val a: Activity, root: FrameLayout, f: File, fromCamera: Boolean, onBack: () -> Unit) {
    val top = FrameLayout(a)
    val bottom = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL }
    var shown = true

    init {
        top.addView(GlassButton(a, Glyph.BACK, "Back", 40f).apply { setOnClickListener { onBack() } }, FrameLayout.LayoutParams(-2, -2, Gravity.START or Gravity.CENTER_VERTICAL))
        val (day, time) = G.dateTitle(f)
        val title = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        title.addView(TextView(a).apply { text = day; textSize = 15f; typeface = Theme.semibold; setTextColor(Theme.TEXT) })
        title.addView(TextView(a).apply { text = time; textSize = 12f; setTextColor(Theme.SECONDARY) })
        top.addView(title, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        if (fromCamera) top.addView(GlassButton(a, Glyph.LIBRARY, "All videos and photos", 36f, "Library").apply {
            setOnClickListener { a.startActivity(Intent(a, GalleryActivity::class.java)) }
        }, FrameLayout.LayoutParams(-2, -2, Gravity.END or Gravity.CENTER_VERTICAL))
        val holder = FrameLayout(a)
        holder.addView(top, FrameLayout.LayoutParams(-1, a.dp(48f), Gravity.TOP))
        holder.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        root.addView(holder, FrameLayout.LayoutParams(-1, -1))
        G.insets(holder, 10f)
    }

    fun toggle() {
        shown = !shown
        for (v in listOf(top, bottom)) v.spring(Spring.SMOOTH).alpha(if (shown) 1f else 0f).start()
        top.isEnabled = shown
    }

    /** Glass capsule toolbar. */
    fun toolbar(): LinearLayout = LinearLayout(a).apply {
        gravity = Gravity.CENTER_VERTICAL
        background = GlassDrawable(a.dp(28f).toFloat(), Theme.GLASS_STRONG, a.resources.displayMetrics.density)
        setPadding(a.dp(8f), a.dp(6f), a.dp(8f), a.dp(6f))
    }
}

private fun LinearLayout.spacer() = addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))

/** Full-screen photo: pinch or double-tap to zoom, drag to look around. */
class PhotoActivity : Activity() {
    private var fromCamera = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val f = File(intent.getStringExtra("path") ?: return finish())
        fromCamera = intent.getBooleanExtra("fromCamera", false)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val img = ZoomImageView(this)
        root.addView(img, FrameLayout.LayoutParams(-1, -1))
        Thread {
            val b = BitmapFactory.decodeFile(f.absolutePath, BitmapFactory.Options().apply { inSampleSize = 2 })
            runOnUiThread { img.setBitmap(b) }
        }.start()
        val chrome = ViewerChrome(this, root, f, fromCamera) { finish() }
        img.onTap = { chrome.toggle(); root.setBackgroundColor(if (chrome.shown) Color.BLACK else Color.BLACK) }
        val bar = chrome.toolbar()
        bar.addView(GlassButton(this, Glyph.SHARE, "Share", 44f).apply { glass = false; setOnClickListener { ClipProvider.share(this@PhotoActivity, f) } })
        bar.spacer()
        bar.addView(GlassButton(this, Glyph.EXPORT, "Save to phone gallery", 44f).apply { glass = false; setOnClickListener { exportAsync(this@PhotoActivity, f) } })
        bar.spacer()
        bar.addView(GlassButton(this, Glyph.TRASH, "Delete", 44f).apply { glass = false; setOnClickListener { G.confirmDelete(this@PhotoActivity, "photo") { f.delete(); finish() } } })
        chrome.bottom.addView(bar, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)
    }

    override fun finish() {
        super.finish()
        @Suppress("DEPRECATION") overridePendingTransition(R.anim.veil_hold, R.anim.veil_zoom_out)
    }
}

/** Image with pinch / double-tap zoom and panning. */
@SuppressLint("AppCompatCustomView") // platform activities, no AppCompat
class ZoomImageView(ctx: android.content.Context) : ImageView(ctx) {
    var onTap: (() -> Unit)? = null
    private val m = Matrix()
    private var base = 1f
    private var bmpW = 1; private var bmpH = 1

    init { scaleType = ScaleType.MATRIX }

    fun setBitmap(b: Bitmap?) {
        setImageBitmap(b ?: return)
        bmpW = b.width; bmpH = b.height
        post { fit() }
    }

    private fun fit() {
        base = minOf(width.toFloat() / bmpW, height.toFloat() / bmpH)
        m.reset(); m.postScale(base, base); m.postTranslate((width - bmpW * base) / 2, (height - bmpH * base) / 2)
        imageMatrix = m
    }

    private fun scale(): Float { val v = FloatArray(9); m.getValues(v); return v[Matrix.MSCALE_X] }

    private fun clamp() {
        val v = FloatArray(9); m.getValues(v)
        val s = v[Matrix.MSCALE_X]
        val w = bmpW * s; val h = bmpH * s
        var tx = v[Matrix.MTRANS_X]; var ty = v[Matrix.MTRANS_Y]
        tx = if (w <= width) (width - w) / 2 else tx.coerceIn(width - w, 0f)
        ty = if (h <= height) (height - h) / 2 else ty.coerceIn(height - h, 0f)
        v[Matrix.MTRANS_X] = tx; v[Matrix.MTRANS_Y] = ty
        m.setValues(v)
        imageMatrix = m
    }

    private val scaler = ScaleGestureDetector(ctx, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(d: ScaleGestureDetector): Boolean {
            val f = (scale() * d.scaleFactor).coerceIn(base, base * 6f) / scale()
            m.postScale(f, f, d.focusX, d.focusY); clamp(); return true
        }
    })
    private val gestures = GestureDetector(ctx, object : GestureDetector.SimpleOnGestureListener() {
        override fun onSingleTapConfirmed(e: MotionEvent): Boolean { onTap?.invoke(); return true }
        override fun onDoubleTap(e: MotionEvent): Boolean {
            val from = scale()
            val to = if (from > base * 1.1f) base else base * 2.5f
            springFloat(0f, 1f, Spring.SMOOTH) { t ->
                val target = from + (to - from) * t
                val f = target / scale()
                m.postScale(f, f, e.x, e.y); clamp()
            }
            return true
        }
        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, dx: Float, dy: Float): Boolean { m.postTranslate(-dx, -dy); clamp(); return true }
    })

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        scaler.onTouchEvent(e)
        if (!scaler.isInProgress) gestures.onTouchEvent(e)
        return true
    }

    override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) { if (drawable != null) fit() }
}

/**
 * Player and editor. Play, scrub the filmstrip, step frames. Edit: mark parts to
 * remove (drag on the filmstrip with the scissors, or In / Out at the playhead),
 * Auto-trim pauses, preview the edit, Done saves it as a new clip.
 */
class PlayerActivity : Activity() {
    private lateinit var file: File
    private var player: MediaPlayer? = null
    private lateinit var surface: SurfaceView
    private lateinit var timeline: TimelineView
    private lateinit var time: TextView
    private lateinit var playBtn: GlassButton
    private lateinit var cutBtn: GlassButton
    private lateinit var status: TextView
    private lateinit var viewBar: LinearLayout
    private lateinit var editBar: LinearLayout
    private lateinit var editTools: LinearLayout
    private lateinit var chrome: ViewerChrome
    private val main = Handler(Looper.getMainLooper())
    private var durationUs = 1L
    private var markIn = -1L
    private var previewEdit = true
    private var editing = false
    private var videoW = 16; private var videoH = 9
    private var fps = 30
    private var fromCamera = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        file = File(intent.getStringExtra("path") ?: return finish())
        fromCamera = intent.getBooleanExtra("fromCamera", false)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surface = SurfaceView(this)
        root.addView(surface, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        val tapLayer = View(this)
        root.addView(tapLayer, FrameLayout.LayoutParams(-1, -1))
        chrome = ViewerChrome(this, root, file, fromCamera) { finish() }
        tapLayer.setOnClickListener { if (!editing) chrome.toggle() }

        status = TextView(this).apply { setTextColor(Theme.SECONDARY); textSize = 12f; gravity = Gravity.CENTER; setPadding(0, 0, 0, dp(6f)) }
        chrome.bottom.addView(status)
        val stripRow = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        timeline = TimelineView(this)
        timeline.onScrub = { us, done -> player?.seekTo(us / 1000, if (done) MediaPlayer.SEEK_CLOSEST else MediaPlayer.SEEK_PREVIOUS_SYNC); updateTime() }
        timeline.onCutsChanged = { cutsChanged() }
        stripRow.addView(timeline, LinearLayout.LayoutParams(0, -2, 1f))
        time = TextView(this).apply { setTextColor(Theme.TEXT); textSize = 12f; typeface = Theme.semibold; fontFeatureSettings = "tnum"; setPadding(dp(6f), 0, dp(4f), 0) }
        stripRow.addView(time)
        chrome.bottom.addView(stripRow, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8f) })

        // Viewing toolbar: share, step, play, step, edit, delete.
        viewBar = chrome.toolbar()
        fun icon(g: Glyph, desc: String, size: Float = 44f, onClick: () -> Unit) = GlassButton(this, g, desc, size).apply { glass = false; setOnClickListener { onClick() } }
        viewBar.addView(icon(Glyph.SHARE, "Share") { ClipProvider.share(this, file) })
        viewBar.spacer()
        viewBar.addView(icon(Glyph.STEP_BACK, "Previous frame", 40f) { step(-1) })
        playBtn = icon(Glyph.PLAY, "Play", 52f) { togglePlay() }
        viewBar.addView(playBtn, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(6f); rightMargin = dp(6f) })
        viewBar.addView(icon(Glyph.STEP_FWD, "Next frame", 40f) { step(1) })
        viewBar.spacer()
        viewBar.addView(GlassButton(this, null, "Edit", 40f, "Edit").apply { glass = false; setOnClickListener { setEditing(true) } })
        viewBar.addView(icon(Glyph.TRASH, "Delete") { G.confirmDelete(this, "video") { release(); file.delete(); finish() } })
        chrome.bottom.addView(viewBar, LinearLayout.LayoutParams(-1, -2))

        // Edit toolbar: Cancel | scissors, In, Out, auto-trim, undo | Done.
        editBar = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; visibility = View.GONE }
        editTools = chrome.toolbar().apply { gravity = Gravity.CENTER }
        cutBtn = icon(Glyph.SCISSORS, "Mark parts to remove") { setCutMode(!timeline.cutMode) }
        editTools.addView(cutBtn)
        editTools.addView(icon(Glyph.MARK_IN, "In at playhead") { markIn = posUs(); toast("In at ${fmtFine(markIn)}") })
        editTools.addView(icon(Glyph.MARK_OUT, "Out at playhead") { addOut() })
        editTools.addView(icon(Glyph.WAND, "Auto-trim pauses") { autoTrim() })
        editTools.addView(icon(Glyph.UNDO, "Undo") { if (timeline.cuts.isNotEmpty()) { timeline.cuts.removeAt(timeline.cuts.size - 1); cutsChanged() } })
        editBar.addView(editTools, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8f) })
        val doneRow = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(dp(8f), 0, dp(8f), 0) }
        doneRow.addView(TextView(this).apply { text = "Cancel"; textSize = 17f; setTextColor(Theme.TEXT); setOnClickListener { timeline.cuts.clear(); cutsChanged(); setEditing(false) } })
        doneRow.spacer()
        doneRow.addView(icon(Glyph.PLAY, "Preview", 44f) { togglePlay() })
        doneRow.spacer()
        doneRow.addView(TextView(this).apply { text = "Done"; textSize = 17f; typeface = Theme.semibold; setTextColor(Theme.YELLOW); setOnClickListener { if (timeline.cuts.isEmpty()) setEditing(false) else save() } })
        editBar.addView(doneRow, LinearLayout.LayoutParams(-1, dp(44f)))
        chrome.bottom.addView(editBar, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)

        MediaMetadataRetriever().use { r ->
            r.setDataSource(file.absolutePath)
            durationUs = (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 1) * 1000
            videoW = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 16
            videoH = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 9
            val rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            if (rot % 180 == 90) { val t = videoW; videoW = videoH; videoH = t }
            fps = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CAPTURE_FRAMERATE)?.toFloatOrNull()?.roundToInt()
                ?: r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT)?.toLongOrNull()?.let { (it * 1_000_000L / durationUs.coerceAtLeast(1)).toInt() } ?: 30
        }
        timeline.durationUs = durationUs
        loadThumbs()
        surface.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(h: SurfaceHolder) = startPlayer(h)
            override fun surfaceChanged(h: SurfaceHolder, f: Int, w: Int, hh: Int) {}
            override fun surfaceDestroyed(h: SurfaceHolder) = release()
        })
        root.post { fitSurface(root) }
        cutsChanged()
    }

    override fun finish() {
        super.finish()
        @Suppress("DEPRECATION") overridePendingTransition(R.anim.veil_hold, R.anim.veil_zoom_out)
    }

    private fun setEditing(on: Boolean) {
        editing = on
        if (!on) setCutMode(false)
        timeline.editing = on
        val (show, hide) = if (on) editBar to viewBar else viewBar to editBar
        hide.spring(Spring.SNAPPY).alpha(0f).withEndAction { hide.visibility = View.GONE }.start()
        show.visibility = View.VISIBLE; show.alpha = 0f
        show.spring(Spring.SMOOTH).alpha(1f).start()
        chrome.top.spring(Spring.SMOOTH).alpha(if (on) 0f else 1f).start()
        if (on) setCutMode(true)
        cutsChanged()
    }

    private fun fitSurface(root: View) {
        val k = minOf(root.width.toFloat() / videoW, root.height.toFloat() / videoH)
        surface.layoutParams = FrameLayout.LayoutParams((videoW * k).toInt(), (videoH * k).toInt(), Gravity.CENTER)
    }

    private fun startPlayer(h: SurfaceHolder) {
        val mp = MediaPlayer()
        mp.setDataSource(file.absolutePath)
        mp.setDisplay(h)
        mp.setOnPreparedListener { it.seekTo(0, MediaPlayer.SEEK_CLOSEST); tick() }
        mp.setOnCompletionListener { playBtn.glyph = Glyph.PLAY }
        mp.prepareAsync()
        player = mp
    }

    private fun release() { main.removeCallbacksAndMessages(null); player?.release(); player = null }

    override fun onPause() { player?.takeIf { it.isPlaying }?.pause(); playBtn.glyph = Glyph.PLAY; super.onPause() }
    override fun onDestroy() { release(); super.onDestroy() }

    private fun posUs() = (player?.currentPosition ?: 0) * 1000L

    private fun tick() {
        val p = player ?: return
        val us = posUs()
        // Preview the edit: jump over parts marked for removal.
        if (previewEdit && p.isPlaying) timeline.cuts.firstOrNull { us >= it.startUs && us < it.endUs - 20_000 }?.let { p.seekTo(it.endUs / 1000, MediaPlayer.SEEK_CLOSEST) }
        timeline.positionUs = us
        updateTime()
        main.postDelayed({ tick() }, 33)
    }

    private fun updateTime() { time.text = "${fmt(timeline.positionUs)}" }

    private fun fmtFine(us: Long): String {
        val f = ((us % 1_000_000L) * fps / 1_000_000L)
        return "${fmt(us)}:%02d".format(f)
    }

    private fun togglePlay() {
        val p = player ?: return
        if (p.isPlaying) { p.pause(); playBtn.glyph = Glyph.PLAY } else { p.start(); playBtn.glyph = Glyph.PAUSE }
        playBtn.tick()
    }

    /** One frame back or forward (frame-accurate seek). */
    private fun step(dir: Int) {
        val p = player ?: return
        if (p.isPlaying) togglePlay()
        val frameUs = 1_000_000L / fps.coerceAtLeast(1)
        val t = (posUs() + dir * frameUs).coerceIn(0, durationUs)
        p.seekTo(t / 1000, MediaPlayer.SEEK_CLOSEST)
        timeline.positionUs = t
        updateTime()
    }

    private fun setCutMode(on: Boolean) {
        timeline.cutMode = on
        cutBtn.active = on
        status.text = if (on) "Drag across the filmstrip to remove that part · tap a removed part to keep it" else statusText()
    }

    private fun addOut() {
        if (markIn < 0) { toast("Set In first"); return }
        val out = posUs()
        if (out - markIn < 40_000 && markIn - out < 40_000) { toast("Move the playhead to the end of the part to remove"); return }
        timeline.cuts.add(Span(minOf(markIn, out), maxOf(markIn, out)))
        markIn = -1
        cutsChanged()
    }

    private fun statusText(): String {
        val keep = Spans.keep(timeline.cuts, durationUs).sumOf { it.durationUs }
        return if (timeline.cuts.isEmpty()) (if (editing) "Nothing removed · ${fmt(durationUs)}" else "${fmt(durationUs)} · $fps fps")
        else "${timeline.cuts.size} part${if (timeline.cuts.size == 1) "" else "s"} removed · new length ${fmt(keep)}"
    }

    private fun cutsChanged() {
        val m = Spans.merge(timeline.cuts)
        timeline.cuts.clear(); timeline.cuts.addAll(m)
        timeline.invalidate()
        if (!timeline.cutMode) status.text = statusText()
    }

    private fun autoTrim() {
        status.text = "Finding pauses…"
        Thread {
            val found = runCatching { SilenceDetector.find(file) }.getOrElse { emptyList() }
            runOnUiThread {
                if (found.isEmpty()) { status.text = "No pauses found (or the clip has no sound)"; return@runOnUiThread }
                timeline.cuts.addAll(found)
                cutsChanged()
                toast("Marked ${found.size} pause${if (found.size == 1) "" else "s"} to remove · tap any to keep it")
            }
        }.start()
    }

    private fun save() {
        val keep = Spans.keep(timeline.cuts, durationUs)
        if (keep.isEmpty()) { toast("That would remove the whole clip"); return }
        player?.takeIf { it.isPlaying }?.pause()
        val out = MediaStorage.uniqueFile(File(file.parentFile, file.nameWithoutExtension + "_edit.mp4"))
        val trimmer = Trimmer(file, out)
        val dlg = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle("Saving as new clip")
            .setMessage("Preparing…").setNegativeButton("Cancel") { _, _ -> trimmer.cancelled = true }.setCancelable(false).show()
        Thread {
            val err = runCatching { trimmer.run(keep) { p -> runOnUiThread { dlg.setMessage("${(p * 100).roundToInt()} %") } } }.exceptionOrNull()
            runOnUiThread {
                dlg.dismiss()
                if (err != null) toast("Not saved: ${err.message}") else {
                    out.setLastModified(System.currentTimeMillis())
                    toast("Saved as a new clip (original kept)")
                    startActivity(Intent(this, PlayerActivity::class.java).putExtra("path", out.absolutePath))
                    finish()
                }
            }
        }.start()
    }

    private fun loadThumbs() {
        Thread {
            val list = ArrayList<Bitmap>()
            runCatching {
                MediaMetadataRetriever().use { r ->
                    r.setDataSource(file.absolutePath)
                    val n = 12
                    for (i in 0 until n) {
                        r.getScaledFrameAtTime(durationUs * i / n + 1, MediaMetadataRetriever.OPTION_CLOSEST_SYNC, 160, 160)?.let { list.add(it) }
                    }
                }
            }
            runOnUiThread { timeline.thumbs = list }
        }.start()
    }

    private fun toast(s: String) = android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_SHORT).show()
}
