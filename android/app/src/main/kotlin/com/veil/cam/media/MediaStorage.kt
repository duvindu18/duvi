package com.veil.cam.media

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import java.io.File
import java.io.FileDescriptor
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Where recordings go. "Private" files live in the app's own storage, which the
 * phone gallery never scans; the in-app gallery shows them and can export any
 * clip to the phone gallery. Otherwise files go straight to Movies/VeilCam.
 */
class MediaOutput(val uri: Uri, val file: File?, private val pfd: ParcelFileDescriptor?, private val context: Context) {
    val fd: FileDescriptor get() = pfd?.fileDescriptor ?: error("no descriptor")
    val path: String? get() = file?.absolutePath

    fun finish(ok: Boolean) {
        runCatching { pfd?.close() }
        if (file != null) { if (!ok) file.delete(); return }
        val r = context.contentResolver
        if (ok) r.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        else r.delete(uri, null, null)
    }
}

object MediaStorage {
    private fun stamp() = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())

    fun videoDir(ctx: Context): File = privateDir(ctx, Environment.DIRECTORY_MOVIES)
    fun photoDir(ctx: Context): File = privateDir(ctx, Environment.DIRECTORY_PICTURES)

    private fun privateDir(ctx: Context, type: String): File {
        val d = File(ctx.getExternalFilesDir(type) ?: File(ctx.filesDir, type), "VeilCam")
        d.mkdirs()
        // App storage is not indexed by the media scanner; .nomedia makes sure of it on every device.
        File(d, ".nomedia").let { if (!it.exists()) runCatching { it.createNewFile() } }
        return d
    }

    fun newVideo(ctx: Context, private: Boolean, suffix: String = ""): MediaOutput {
        val name = "VeilCam_${stamp()}$suffix.mp4"
        if (private) {
            val f = uniqueFile(File(videoDir(ctx), name))
            val pfd = ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_TRUNCATE)
            return MediaOutput(Uri.fromFile(f), f, pfd, ctx)
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "video/mp4")
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_MOVIES + "/VeilCam")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = ctx.contentResolver.insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, values) ?: error("Cannot create the video file")
        return MediaOutput(uri, null, ctx.contentResolver.openFileDescriptor(uri, "rw"), ctx)
    }

    /** Writes a JPEG; returns where it went. */
    fun savePhoto(ctx: Context, private: Boolean, write: (java.io.OutputStream) -> Unit): Uri {
        val name = "VeilCam_${stamp()}.jpg"
        if (private) {
            val f = uniqueFile(File(photoDir(ctx), name))
            f.outputStream().use(write)
            return Uri.fromFile(f)
        }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/VeilCam")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val r = ctx.contentResolver
        val uri = r.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: error("Cannot create the photo")
        r.openOutputStream(uri)!!.use(write)
        r.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        return uri
    }

    /** Copy a private clip or photo into the phone gallery (Movies/VeilCam or Pictures/VeilCam). */
    fun exportToGallery(ctx: Context, f: File): Uri {
        val video = f.extension.lowercase() == "mp4"
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, f.name)
            put(MediaStore.MediaColumns.MIME_TYPE, if (video) "video/mp4" else "image/jpeg")
            put(MediaStore.MediaColumns.RELATIVE_PATH, (if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES) + "/VeilCam")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val r = ctx.contentResolver
        val coll = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val uri = r.insert(coll, values) ?: error("Cannot export")
        r.openOutputStream(uri)!!.use { out -> f.inputStream().use { it.copyTo(out, 1 shl 20) } }
        r.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        return uri
    }

    /** Clips and photos in the private gallery, newest first. */
    fun list(ctx: Context): List<File> =
        (videoDir(ctx).listFiles().orEmpty().filter { it.extension == "mp4" && it.length() > 0 } +
            photoDir(ctx).listFiles().orEmpty().filter { it.extension == "jpg" && it.length() > 0 })
            .sortedByDescending { it.lastModified() }

    fun uniqueFile(f: File): File {
        if (!f.exists()) return f
        var i = 2
        while (true) {
            val c = File(f.parentFile, "${f.nameWithoutExtension}_$i.${f.extension}")
            if (!c.exists()) return c
            i++
        }
    }
}
