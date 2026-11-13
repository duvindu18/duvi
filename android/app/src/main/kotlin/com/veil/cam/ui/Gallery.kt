package com.veil.cam.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.MediaMetadataRetriever
import android.media.MediaPlayer
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import android.util.LruCache
import android.view.Gravity
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
import android.widget.TextView
import com.veil.cam.media.MediaStorage
import com.veil.cam.media.SilenceDetector
import com.veil.cam.media.Span
import com.veil.cam.media.Spans
import com.veil.cam.media.Trimmer
import java.io.File
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

/** Shared look for the gallery screens: black, capsule buttons. */
private object G {
    fun capsule(a: Activity, text: String, red: Boolean = false, onClick: () -> Unit) = TextView(a).apply {
        this.text = text; textSize = 14f; typeface = Theme.medium; gravity = Gravity.CENTER
        setTextColor(if (red) Theme.ACCENT else Theme.TEXT)
        background = Theme.pill(Theme.SURFACE2, Theme.dp(a, 20f))
        setPadding(a.dp(18f), 0, a.dp(18f), 0)
        minHeight = a.dp(40f)
        setOnClickListener { onClick() }
    }

    fun confirm(a: Activity, title: String, msg: String, ok: String, action: () -> Unit) {
        AlertDialog.Builder(a, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle(title).setMessage(msg)
            .setPositiveButton(ok) { _, _ -> action() }.setNegativeButton("Cancel", null).show()
    }

    fun insets(root: View) {
        root.setOnApplyWindowInsetsListener { v, ins ->
            val s = ins.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val base = Theme.dpi(v.context, 12f)
            v.setPadding(s.left + base, s.top + base, s.right + base, s.bottom + base)
            ins
        }
    }
}

/** Grid of the private clips and photos (hidden from the phone gallery). */
class GalleryActivity : Activity() {
    private lateinit var grid: GridView
    private lateinit var title: TextView
    private var files: List<File> = emptyList()
    private val pool = Executors.newFixedThreadPool(2)
    private val main = Handler(Looper.getMainLooper())
    private val cache = object : LruCache<String, Bitmap>(48 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.BLACK) }
        val bar = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, 0, 0, dp(12f)) }
        bar.addView(G.capsule(this, "‹ Camera") { finish() })
        title = TextView(this).apply { setTextColor(Theme.TEXT); textSize = 20f; typeface = Theme.regular; setPadding(dp(16f), 0, 0, 0) }
        bar.addView(title, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(bar)
        grid = GridView(this).apply {
            numColumns = GridView.AUTO_FIT
            columnWidth = dp(150f)
            horizontalSpacing = dp(6f); verticalSpacing = dp(6f)
            stretchMode = GridView.STRETCH_COLUMN_WIDTH
            setOnItemClickListener { _, _, pos, _ -> open(files[pos]) }
            setOnItemLongClickListener { _, _, pos, _ -> menu(files[pos]); true }
        }
        root.addView(grid, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(TextView(this).apply {
            text = "Private: these files are not shown in the phone gallery. Long-press to export, share or delete."
            setTextColor(Theme.FAINT); textSize = 11f; setPadding(0, dp(8f), 0, 0)
        })
        G.insets(root)
        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        files = MediaStorage.list(this)
        val clips = files.count { it.extension == "mp4" }
        title.text = "Gallery  ·  $clips clip${if (clips == 1) "" else "s"}, ${files.size - clips} photo${if (files.size - clips == 1) "" else "s"}"
        grid.adapter = Adapter()
    }

    override fun onDestroy() { pool.shutdownNow(); super.onDestroy() }

    private fun open(f: File) {
        startActivity(Intent(this, if (f.extension == "mp4") PlayerActivity::class.java else PhotoActivity::class.java).putExtra("path", f.absolutePath))
    }

    private fun menu(f: File) {
        AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle(f.name)
            .setItems(arrayOf("Export to phone gallery", "Share…", "Delete")) { _, which ->
                when (which) {
                    0 -> exportAsync(this, f)
                    1 -> ClipProvider.share(this, f)
                    2 -> G.confirm(this, "Delete", "Delete ${f.name}? This cannot be undone.", "Delete") { f.delete(); onResume() }
                }
            }.show()
    }

    private inner class Adapter : BaseAdapter() {
        override fun getCount() = files.size
        override fun getItem(i: Int) = files[i]
        override fun getItemId(i: Int) = i.toLong()
        override fun getView(i: Int, convert: View?, parent: ViewGroup?): View {
            val f = files[i]
            val cell = (convert as? FrameLayout) ?: FrameLayout(this@GalleryActivity).apply {
                layoutParams = ViewGroup.LayoutParams(-1, dp(110f))
                background = Theme.pill(Theme.SURFACE2, Theme.dp(this@GalleryActivity, 14f))
                clipToOutline = true
                addView(ImageView(context).apply { scaleType = ImageView.ScaleType.CENTER_CROP; tag = "img" }, FrameLayout.LayoutParams(-1, -1))
                addView(TextView(context).apply {
                    tag = "label"; setTextColor(Color.WHITE); textSize = 11f; typeface = Theme.mono
                    background = Theme.pill(0x99000000.toInt(), Theme.dp(context, 9f)); setPadding(dp(7f), dp(2f), dp(7f), dp(2f))
                }, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, dp(6f), dp(6f)) })
            }
            val img = cell.findViewWithTag<ImageView>("img")
            val label = cell.findViewWithTag<TextView>("label")
            img.tag = "img"; img.setImageBitmap(cache.get(f.path))
            label.text = if (f.extension == "mp4") "…" else "PHOTO"
            cell.setTag(com.veil.cam.R.id.cell_file, f.path)
            if (cache.get(f.path) == null || f.extension == "mp4") pool.execute {
                val (bmp, dur) = thumb(f)
                main.post {
                    if (bmp != null) cache.put(f.path, bmp)
                    if (cell.getTag(com.veil.cam.R.id.cell_file) == f.path) {
                        img.setImageBitmap(bmp)
                        label.text = dur ?: "PHOTO"
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
            val o = BitmapFactory.Options().apply { inSampleSize = 8 }
            BitmapFactory.decodeFile(f.absolutePath, o) to null
        }
    }.getOrDefault(null to null)
}

internal fun exportAsync(a: Activity, f: File) {
    Thread {
        val msg = runCatching { MediaStorage.exportToGallery(a, f); "Exported to the phone gallery (VeilCam)" }.getOrElse { "Export failed: ${it.message}" }
        a.runOnUiThread { android.widget.Toast.makeText(a, msg, android.widget.Toast.LENGTH_SHORT).show() }
    }.start()
}

/** Full-screen photo. */
class PhotoActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val f = File(intent.getStringExtra("path") ?: return finish())
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val img = ImageView(this).apply { scaleType = ImageView.ScaleType.FIT_CENTER }
        root.addView(img, FrameLayout.LayoutParams(-1, -1))
        Thread {
            val o = BitmapFactory.Options().apply { inSampleSize = 2 }
            val b = BitmapFactory.decodeFile(f.absolutePath, o)
            runOnUiThread { img.setImageBitmap(b) }
        }.start()
        val bar = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        bar.addView(G.capsule(this, "‹ Gallery") { finish() })
        bar.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        bar.addView(G.capsule(this, "Export") { exportAsync(this, f) }, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) })
        bar.addView(G.capsule(this, "Share") { ClipProvider.share(this, f) }, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) })
        bar.addView(G.capsule(this, "Delete", red = true) { G.confirm(this, "Delete", "Delete this photo?", "Delete") { f.delete(); finish() } })
        val holder = FrameLayout(this)
        holder.addView(bar, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        root.addView(holder, FrameLayout.LayoutParams(-1, -1))
        G.insets(holder)
        setContentView(root)
    }
}

/**
 * Player and editor: scrub with thumbnails, frame step, mark parts to remove (drag
 * on the timeline in Cut mode, or In/Out at the playhead), Auto-trim pauses, preview
 * the edit, save as a new clip.
 */
class PlayerActivity : Activity() {
    private lateinit var file: File
    private var player: MediaPlayer? = null
    private lateinit var surface: SurfaceView
    private lateinit var timeline: TimelineView
    private lateinit var time: TextView
    private lateinit var playBtn: TextView
    private lateinit var cutBtn: TextView
    private lateinit var status: TextView
    private val main = Handler(Looper.getMainLooper())
    private var durationUs = 1L
    private var markIn = -1L
    private var previewEdit = true
    private var videoW = 16; private var videoH = 9
    private var fps = 30

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        file = File(intent.getStringExtra("path") ?: return finish())
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surface = SurfaceView(this)
        root.addView(surface, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        val ui = FrameLayout(this)

        val top = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        top.addView(G.capsule(this, "‹ Gallery") { finish() })
        top.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
        top.addView(G.capsule(this, "Export") { exportAsync(this, file) }, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) })
        top.addView(G.capsule(this, "Share") { ClipProvider.share(this, file) }, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(8f) })
        top.addView(G.capsule(this, "Delete", red = true) { G.confirm(this, "Delete", "Delete this clip?", "Delete") { release(); file.delete(); finish() } })
        ui.addView(top, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))

        val bottom = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        status = TextView(this).apply { setTextColor(Theme.DIM); textSize = 12f; gravity = Gravity.CENTER; setPadding(0, 0, 0, dp(6f)) }
        bottom.addView(status)
        // Edit capsule
        val edit = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            background = Theme.pill(Theme.SURFACE, Theme.dp(this@PlayerActivity, 28f))
            setPadding(dp(8f), dp(8f), dp(8f), dp(8f))
        }
        cutBtn = G.capsule(this, "Cut") { setCutMode(!timeline.cutMode) }
        val row = listOf(
            cutBtn,
            G.capsule(this, "In") { markIn = posUs(); toast("In at ${fmtFine(markIn)}") },
            G.capsule(this, "Out") { addOut() },
            G.capsule(this, "Auto-trim") { autoTrim() },
            G.capsule(this, "Undo") { if (timeline.cuts.isNotEmpty()) { timeline.cuts.removeAt(timeline.cuts.size - 1); cutsChanged() } },
            G.capsule(this, "Save edit", red = true) { save() },
        )
        val scroll = android.widget.HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false }
        val inner = LinearLayout(this)
        row.forEach { inner.addView(it, LinearLayout.LayoutParams(-2, -2).apply { rightMargin = dp(6f) }) }
        scroll.addView(inner)
        edit.addView(scroll, LinearLayout.LayoutParams(-1, -2))
        bottom.addView(edit, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8f) })
        // Transport capsule (as the camera's control capsule)
        val transport = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            background = Theme.pill(Theme.SURFACE, Theme.dp(this@PlayerActivity, 36f))
            setPadding(dp(10f), dp(6f), dp(14f), dp(6f))
        }
        val circle = { label: String, onClick: () -> Unit ->
            TextView(this).apply {
                text = label; textSize = 16f; gravity = Gravity.CENTER; setTextColor(Theme.TEXT); typeface = Theme.mono
                background = Theme.pill(Theme.SURFACE3, Theme.dp(this@PlayerActivity, 24f))
                setOnClickListener { onClick() }
            }
        }
        transport.addView(circle("‹") { step(-1) }, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { rightMargin = dp(6f) })
        playBtn = circle("▶") { togglePlay() }
        transport.addView(playBtn, LinearLayout.LayoutParams(dp(52f), dp(52f)).apply { rightMargin = dp(6f) })
        transport.addView(circle("›") { step(1) }, LinearLayout.LayoutParams(dp(44f), dp(44f)).apply { rightMargin = dp(10f) })
        timeline = TimelineView(this)
        timeline.onScrub = { us, done -> player?.seekTo(us / 1000, if (done) MediaPlayer.SEEK_CLOSEST else MediaPlayer.SEEK_PREVIOUS_SYNC); updateTime() }
        timeline.onCutsChanged = { cutsChanged() }
        transport.addView(timeline, LinearLayout.LayoutParams(0, -2, 1f))
        time = TextView(this).apply { setTextColor(Theme.TEXT); textSize = 13f; typeface = Theme.mono; setPadding(dp(10f), 0, 0, 0) }
        transport.addView(time)
        bottom.addView(transport, LinearLayout.LayoutParams(-1, -2))
        ui.addView(bottom, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        root.addView(ui, FrameLayout.LayoutParams(-1, -1))
        G.insets(ui)
        setContentView(root)

        MediaMetadataRetriever().use { r ->
            r.setDataSource(file.absolutePath)
            durationUs = (r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 1) * 1000
            videoW = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 16
            videoH = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 9
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

    private fun fitSurface(root: View) {
        val k = minOf(root.width.toFloat() / videoW, root.height.toFloat() / videoH)
        surface.layoutParams = FrameLayout.LayoutParams((videoW * k).toInt(), (videoH * k).toInt(), Gravity.CENTER)
    }

    private fun startPlayer(h: SurfaceHolder) {
        val mp = MediaPlayer()
        mp.setDataSource(file.absolutePath)
        mp.setDisplay(h)
        mp.setOnPreparedListener { it.seekTo(0, MediaPlayer.SEEK_CLOSEST); tick() }
        mp.setOnCompletionListener { playBtn.text = "▶" }
        mp.prepareAsync()
        player = mp
    }

    private fun release() { main.removeCallbacksAndMessages(null); player?.release(); player = null }

    override fun onPause() { player?.takeIf { it.isPlaying }?.pause(); playBtn.text = "▶"; super.onPause() }
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

    private fun updateTime() { time.text = "${fmt(timeline.positionUs)} / ${fmt(durationUs)}" }

    private fun fmtFine(us: Long): String {
        val f = ((us % 1_000_000L) * fps / 1_000_000L)
        return "${fmt(us)}:%02d".format(f)
    }

    private fun togglePlay() {
        val p = player ?: return
        if (p.isPlaying) { p.pause(); playBtn.text = "▶" } else { p.start(); playBtn.text = "❚❚" }
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
        cutBtn.background = Theme.pill(if (on) Theme.ACCENT else Theme.SURFACE2, Theme.dp(this, 20f))
        cutBtn.setTextColor(if (on) Theme.ON_LIGHT else Theme.TEXT)
        status.text = if (on) "Drag across the timeline to remove that part · tap a red part to keep it" else statusText()
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
        return if (timeline.cuts.isEmpty()) "No cuts · full clip ${fmt(durationUs)}" else "${timeline.cuts.size} cut${if (timeline.cuts.size == 1) "" else "s"} · new length ${fmt(keep)}"
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
                toast("Marked ${found.size} pause${if (found.size == 1) "" else "s"} to remove · tap any red part to keep it")
            }
        }.start()
    }

    private fun save() {
        if (timeline.cuts.isEmpty()) { toast("Mark the parts to remove first"); return }
        val keep = Spans.keep(timeline.cuts, durationUs)
        if (keep.isEmpty()) { toast("That would remove the whole clip"); return }
        player?.takeIf { it.isPlaying }?.pause()
        val out = MediaStorage.uniqueFile(File(file.parentFile, file.nameWithoutExtension + "_edit.mp4"))
        val trimmer = Trimmer(file, out)
        val dlg = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert).setTitle("Saving edit")
            .setMessage("Preparing…").setNegativeButton("Cancel") { _, _ -> trimmer.cancelled = true }.setCancelable(false).show()
        Thread {
            val err = runCatching { trimmer.run(keep) { p -> runOnUiThread { dlg.setMessage("${(p * 100).roundToInt()} %") } } }.exceptionOrNull()
            runOnUiThread {
                dlg.dismiss()
                if (err != null) toast("Not saved: ${err.message}") else {
                    out.setLastModified(System.currentTimeMillis())
                    toast("Saved ${out.name} (original kept)")
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
                    val n = 10
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
