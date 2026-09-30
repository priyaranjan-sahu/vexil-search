package com.vexil.app

import android.Manifest
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
}