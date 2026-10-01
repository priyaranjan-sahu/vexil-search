package com.vexil.app

import android.Manifest
import android.content.ActivityNotFoundException
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
import java.io.File
import java.net.URLConnection
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
    val resolved = resolveTreePath(uri)
    if (resolved == null) {
      emit(
        "vexil:folder-pick-error",
        "{}",
        "Could not resolve the selected folder into a readable path"
      )
      return@registerForActivityResult
    }
    try {
      contentResolver.takePersistableUriPermission(
        uri,
        Intent.FLAG_GRANT_READ_URI_PERMISSION
      )
    } catch (ignored: SecurityException) {
      // The grant may already be held or not required; path reads still work
      // when all-files access is granted, so continue regardless.
    }
    val name = resolved.substringAfterLast('/').ifEmpty { resolved }
    emit("vexil:folder-picked", JSONObject().put("path", resolved).put("name", name).toString(), null)
  }

  private val legacyPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) {
    emit("vexil:all-files-access", JSONObject().put("granted", hasAllFilesAccess()).toString(), null)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
      val file = File(path)
      if (!file.isFile) return "File not found: $path"

      val uri = try {
        FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
      } catch (_: IllegalArgumentException) {
        return "This file is outside the folders Vexil can share: $path"
      }

      // MIME type must be on the Intent itself; Android resolves the handler from
      // setDataAndType, and many players never register a bare content:// filter.
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, mimeTypeFor(file.name))
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

      var error = "No app on this device can open ${file.name}"
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
      if (!done.await(3, TimeUnit.SECONDS)) return "Timed out opening ${file.name}"
      return error
    }
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
