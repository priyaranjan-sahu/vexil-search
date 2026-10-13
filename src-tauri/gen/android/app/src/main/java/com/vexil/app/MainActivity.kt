package com.vexil.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.URLConnection
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  private val folderPicker = registerForActivityResult(
    ActivityResultContracts.OpenDocumentTree()
  ) { uri: Uri? ->
    if (uri == null) {
      emit("vexil:folder-pick-error", "{}", "User cancelled")
      return@registerForActivityResult
    }
    try {
      contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION
      )
    } catch (ignored: SecurityException) {
      // The grant may already be held or not required.
    }
    // The raw path is only a display label / removable-drive hint; indexing goes
    // through the tree URI, so a provider with no filesystem path (cloud, etc.)
    // is still usable.
    val treeUri = uri.toString()
    val resolved = resolveTreePath(uri)
    val name = resolved?.substringAfterLast('/')?.takeIf { it.isNotEmpty() }
      ?: treeDisplayName(uri)
    emit(
      "vexil:folder-picked",
      JSONObject().put("path", resolved ?: treeUri).put("name", name).put("uri", treeUri).toString(),
      null
    )
  }

  private val legacyPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) {
    emit("vexil:all-files-access", JSONObject().put("granted", hasAllFilesAccess()).toString(), null)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The Rust indexer reads picked folders through SafBridge over JNI, which
    // needs an application Context for the ContentResolver.
    SafBridge.appContext = applicationContext
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(VexilBridge(), "VexilAndroid")
    super.onWebViewCreate(webView)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    // Re-emit after the user returns from All Files Access settings.
    if (hasFocus) {
      emit("vexil:all-files-access", JSONObject().put("granted", hasAllFilesAccess()).toString(), null)
    }
  }

  private fun hasAllFilesAccess(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

  /**
   * Explicit types for the media/document kinds Vexil indexes, because
   * [URLConnection.guessContentTypeFromName] is sparse and platform dependent
   * (it commonly returns null for .mkv, .flac, .md).
   */
  private fun mimeTypeFor(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return MIME_BY_EXTENSION[ext]
      ?: URLConnection.guessContentTypeFromName(name)
      ?: "*/*"
  }

  // Bridge exposed to the WebView as `window.VexilAndroid`.
  private inner class VexilBridge {
    @JavascriptInterface
    fun hasAllFilesAccess(): Boolean = this@MainActivity.hasAllFilesAccess()

    @JavascriptInterface
    fun openAllFilesAccess() {
      runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION)
            .setData(Uri.parse("package:$packageName"))
          try {
            startActivity(intent)
          } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
          }
        } else {
          val needed = mutableListOf<String>()
          if (
            ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.READ_EXTERNAL_STORAGE)
            != PackageManager.PERMISSION_GRANTED
          ) {
            needed.add(Manifest.permission.READ_EXTERNAL_STORAGE)
          }
          if (
            Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
              ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.WRITE_EXTERNAL_STORAGE)
              != PackageManager.PERMISSION_GRANTED
          ) {
            needed.add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
          }
          if (needed.isNotEmpty()) {
            legacyPermissionLauncher.launch(needed.toTypedArray())
          }
        }
      }
    }

    @JavascriptInterface
    fun pickFolder() {
      runOnUiThread { folderPicker.launch(null) }
    }

    /**
     * Opens [path] in whatever app handles its type (video player, image viewer,
     * PDF reader, ...).
     *
     * A raw `file://` intent is rejected on Android 7+ (FileUriExposedException),
     * and a bare path has no scheme for ACTION_VIEW to match on, so the file is
     * shared as a FileProvider `content://` uri with an explicit MIME type.
     *
     * @return "" on success, otherwise a human-readable error for the UI.
     */
    @JavascriptInterface
    fun openFile(path: String): String {
      // SAF-indexed files are stored as `content://` URIs; the persisted tree
      // permission is enough to hand them straight to a viewer.
      if (path.startsWith("content://")) {
        val uri = Uri.parse(path)
        val label = path.substringAfterLast('/')
        return openUri(uri, contentResolver.getType(uri) ?: mimeTypeFor(label), label)
      }

      val file = File(path)
      if (!file.isFile) return "File not found: $path"

      val uri = try {
        FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
      } catch (_: IllegalArgumentException) {
        return "This file is outside the folders Vexil can share: $path"
      }
      return openUri(uri, mimeTypeFor(file.name), file.name)
    }
  }

  /**
   * Launches [uri] in whatever app handles [type].
   *
   * A raw `file://` intent is rejected on Android 7+ (FileUriExposedException),
   * and a bare path has no scheme for ACTION_VIEW to match on, so callers pass
   * a shareable `content://` uri with an explicit MIME type.
   *
   * @return "" on success, otherwise a human-readable error for the UI.
   */
  private fun openUri(uri: Uri, type: String, label: String): String {
    // MIME type must be on the Intent itself; Android resolves the handler from
    // setDataAndType, and many players never register a bare content:// filter.
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, type)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

    var error = "No app on this device can open $label"
    val done = CountDownLatch(1)
    runOnUiThread {
      try {
        startActivity(intent)
        error = ""
      } catch (_: ActivityNotFoundException) {
        // Some viewers only match content:// with no declared type.
        try {
          startActivity(
            Intent(Intent.ACTION_VIEW)
              .setData(uri)
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          )
          error = ""
        } catch (_: ActivityNotFoundException) {
          // keep the original "no app" error
        }
      } catch (e: Exception) {
        error = e.message ?: error
      } finally {
        done.countDown()
      }
    }
    if (!done.await(3, TimeUnit.SECONDS)) return "Timed out opening $label"
    return error
  }

  // Maps a SAF tree document id (e.g. "primary:Documents/Reports") to a real
  // filesystem path the Rust indexer can read. Primary storage lives under
  // /storage/emulated/0, secondary volumes under /storage/<volumeId>.
  private fun resolveTreePath(uri: Uri): String? {
    val docId = DocumentsContract.getTreeDocumentId(uri)
    val parts = docId.split(":", limit = 2)
    if (parts.isEmpty() || parts[0].isEmpty()) return null
    val volume = parts[0]
    val rel = parts.getOrElse(1) { "" }
    return if (volume == "primary") {
      val base = Environment.getExternalStorageDirectory().absolutePath
      if (rel.isEmpty()) base else "$base/$rel"
    } else {
      if (rel.isEmpty()) "/storage/$volume" else "/storage/$volume/$rel"
    }
  }

  // Best-effort folder name for a tree with no resolvable filesystem path
  // (e.g. a cloud provider): the last segment of its document id, decoded.
  private fun treeDisplayName(uri: Uri): String {
    val docId = DocumentsContract.getTreeDocumentId(uri)
    return Uri.decode(docId.substringAfterLast('/')).ifEmpty {
      docId.substringAfter(':').ifEmpty { "Folder" }
    }
  }

  // `detailJson` is embedded as a JSON object literal inside the CustomEvent.
  private fun emit(event: String, detailJson: String, error: String?) {
    val wv = webView ?: return
    val detail = jsString(detailJson)
    if (error != null) {
      val err = jsString(error)
      runOnUiThread {
        wv.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('$event', { detail: { error: '$err' } }));",
          null
        )
      }
    } else {
      runOnUiThread {
        wv.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('$event', { detail: JSON.parse('$detail') }));",
          null
        )
      }
    }
  }

  private fun jsString(s: String): String = s
    .replace("\\", "\\\\")
    .replace("'", "\\'")
    .replace("\u2028", "\\u2028")
    .replace("\u2029", "\\u2029")

  companion object {
    private val MIME_BY_EXTENSION = mapOf(
      // video
      "mp4" to "video/mp4", "m4v" to "video/x-m4v", "mkv" to "video/x-matroska",
      "webm" to "video/webm", "avi" to "video/x-msvideo", "mov" to "video/quicktime",
      "3gp" to "video/3gpp", "ts" to "video/mp2t", "wmv" to "video/x-ms-wmv",
      "flv" to "video/x-flv", "m2ts" to "video/mp2t",
      // audio
      "mp3" to "audio/mpeg", "m4a" to "audio/mp4", "aac" to "audio/aac",
      "flac" to "audio/flac", "wav" to "audio/wav", "ogg" to "audio/ogg",
      "opus" to "audio/opus", "wma" to "audio/x-ms-wma", "mka" to "audio/x-matroska",
      // images
      "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png",
      "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp",
      "svg" to "image/svg+xml", "heic" to "image/heic", "heif" to "image/heif",
      "avif" to "image/avif", "tiff" to "image/tiff", "ico" to "image/x-icon",
      // documents
      "pdf" to "application/pdf", "txt" to "text/plain", "md" to "text/markdown",
      "log" to "text/plain", "csv" to "text/csv", "json" to "application/json",
      "html" to "text/html", "htm" to "text/html", "xml" to "application/xml",
      "rtf" to "application/rtf", "epub" to "application/epub+zip",
      "doc" to "application/msword",
      "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "xls" to "application/vnd.ms-excel",
      "xlsx" to "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "ppt" to "application/vnd.ms-powerpoint",
      "pptx" to "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      // archives / code
      "zip" to "application/zip", "7z" to "application/x-7z-compressed",
      "rar" to "application/vnd.rar", "tar" to "application/x-tar",
      "gz" to "application/gzip", "apk" to "application/vnd.android.package-archive"
    )
  }
}

/**
 * JNI entry point for the Rust indexer. `src-tauri/src/saf.rs` loads this class
 * through the app ClassLoader and calls the `@JvmStatic` methods to walk and
 * read picked folders, which are `content://` document trees rather than
 * filesystem paths.
 *
 * Every method is safe to call from the indexer's background thread and never
 * throws: a failure is reported as an empty list / null so one unreadable folder
 * cannot abort the scan.
 */
object SafBridge {
  @Volatile
  var appContext: Context? = null

  @JvmStatic
  fun hasAllFilesAccess(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()

  @JvmStatic
  fun treeIsReadable(treeUri: String): Boolean {
    val context = appContext ?: return false
    return try {
      val tree = Uri.parse(treeUri)
      val docUri = DocumentsContract.buildDocumentUriUsingTree(
        tree,
        DocumentsContract.getTreeDocumentId(tree)
      )
      context.contentResolver.openInputStream(docUri)?.use { true } ?: false
    } catch (_: Exception) {
      false
    }
  }

  /** One JSON array element per direct child of [documentUri] within [treeUri]. */
  @JvmStatic
  fun listChildren(treeUri: String, documentUri: String): String {
    val context = appContext ?: return "[]"
    val out = JSONArray()
    try {
      val tree = Uri.parse(treeUri)
      val parent = Uri.parse(documentUri)
      val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
        tree,
        DocumentsContract.getDocumentId(parent)
      )
      context.contentResolver.query(
        childrenUri,
        arrayOf(
          DocumentsContract.Document.COLUMN_DOCUMENT_ID,
          DocumentsContract.Document.COLUMN_DISPLAY_NAME,
          DocumentsContract.Document.COLUMN_MIME_TYPE,
          DocumentsContract.Document.COLUMN_SIZE,
          DocumentsContract.Document.COLUMN_LAST_MODIFIED
        ),
        null, null, null
      )?.use { cursor ->
        while (cursor.moveToNext()) {
          val id = cursor.getString(0) ?: continue
          val mime = cursor.getString(2) ?: ""
          out.put(
            JSONObject()
              .put("id", id)
              .put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
              .put("name", cursor.getString(1) ?: "")
              .put("mime", mime)
              .put("size", if (cursor.isNull(3)) 0L else cursor.getLong(3))
              .put("lastModified", if (cursor.isNull(4)) 0L else cursor.getLong(4))
              .put("isDir", mime == DocumentsContract.Document.MIME_TYPE_DIR)
          )
        }
      }
    } catch (_: Exception) {
      // Return whatever was collected; the Rust side logs a partial listing.
    }
    return out.toString()
  }

  /** Reads a whole document, or null when it is missing or over [maxBytes]. */
  @JvmStatic
  fun readBytes(documentUri: String, maxBytes: Long): ByteArray? {
    val context = appContext ?: return null
    return try {
      context.contentResolver.openInputStream(Uri.parse(documentUri))?.use { input ->
        readUpTo(input, maxBytes)
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun readUpTo(input: InputStream, maxBytes: Long): ByteArray? {
    val buffer = ByteArrayOutputStream()
    val chunk = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val read = input.read(chunk)
      if (read < 0) break
      total += read
      // Refuse rather than truncate: a half file would parse as garbage.
      if (maxBytes > 0 && total > maxBytes) return null
      buffer.write(chunk, 0, read)
    }
    return buffer.toByteArray()
  }
}
