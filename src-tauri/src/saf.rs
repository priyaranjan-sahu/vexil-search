//! Android Storage Access Framework bridge (JNI).
//!
//! A folder chosen through the system picker is a `content://` document tree,
//! not a path the filesystem can read. The indexer therefore drives Android's
//! `ContentResolver` through `com.vexil.app.SafBridge` (a Kotlin object) over
//! JNI: the app `ClassLoader` is reached from the `Context` that `tao` stores
//! with `ndk-context` at startup, and every call attaches the current (native)
//! thread as a daemon for the duration of the walk.
//!
//! The Kotlin side returns plain JSON so this module needs no field IDs or
//! cursor plumbing: `listChildren` gives one decoded entry per descendant and
//! `readBytes` gives the file contents for formats worth extracting text from.

use std::path::Path;

use jni::objects::{JByteArray, JClass, JObject, JString, JValue};
use jni::{JNIEnv, JavaVM};

use crate::IndexRow;

/// Never read more than this many bytes for one document, matching the ceiling
/// the path-based extractor applies to PDFs.
const MAX_READ_BYTES: i64 = 64 * 1024 * 1024;
/// Depth guard so a pathological tree (or a resolver that reports a folder as
/// its own child) cannot recurse without bound.
const MAX_DEPTH: usize = 64;

/// One entry as serialised by `SafBridge.listChildren`.
#[derive(serde::Deserialize)]
struct Child {
    /// Document ID, unique within the tree.
    #[allow(dead_code)]
    id: String,
    /// Full `content://` URI to open this document.
    uri: String,
    name: String,
    #[serde(default, rename = "isDir")]
    is_dir: bool,
    #[serde(default)]
    size: i64,
    /// Last-modified time in milliseconds since the epoch (0 if unknown).
    #[serde(default, rename = "lastModified")]
    last_modified: i64,
}

/// Loads `com.vexil.app.SafBridge` and returns a JNI environment plus the
/// class, both valid for as long as `vm` is borrowed.
///
/// The class is loaded through the application `ClassLoader` because a native
/// thread's `FindClass` only searches the system class path, not app classes.
fn load_bridge(vm: &JavaVM) -> Result<(JNIEnv<'_>, JClass<'_>), String> {
    let mut env = vm
        .attach_current_thread_as_daemon()
        .map_err(|e| e.to_string())?;

    let context = unsafe { JObject::from_raw(ndk_context::android_context().context().cast()) };
    let loader = env
        .call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
        .and_then(|v| v.l())
        .map_err(|e| e.to_string())?;
    let name = env
        .new_string("com.vexil.app.SafBridge")
        .map_err(|e| e.to_string())?;
    let class = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name)],
        )
        .and_then(|v| v.l())
        .map_err(|e| e.to_string())?;

    Ok((env, JClass::from(class)))
}

/// Wraps the process-wide `JavaVM` pointer that `ndk-context` was initialised
/// with. Panics if called before `tao` has installed the Android context, which
/// only happens after the app is running.
fn current_vm() -> Result<JavaVM, String> {
    let raw = ndk_context::android_context().vm();
    unsafe { JavaVM::from_raw(raw.cast()) }.map_err(|e| e.to_string())
}

/// Whether the app currently holds the All Files Access permission, i.e. can
/// read shared storage as raw paths. Treat bridge failures as "no": the raw
/// walker would fail on those same paths anyway.
pub fn has_all_files_access() -> bool {
    let result = (|| -> Result<bool, String> {
        let vm = current_vm()?;
        let (mut env, class) = load_bridge(&vm)?;
        env.call_static_method(&class, "hasAllFilesAccess", "()Z", &[])
            .and_then(|v| v.z())
            .map_err(|e| e.to_string())
    })();
    result.unwrap_or(false)
}

/// Whether the persisted permission still lets us read this tree.
pub fn tree_is_readable(tree_uri: &str) -> bool {
    let result = (|| -> Result<bool, String> {
        let vm = current_vm()?;
        let (mut env, class) = load_bridge(&vm)?;
        let uri = env.new_string(tree_uri).map_err(|e| e.to_string())?;
        env.call_static_method(
            &class,
            "treeIsReadable",
            "(Ljava/lang/String;)Z",
            &[JValue::Object(&uri)],
        )
        .and_then(|v| v.z())
        .map_err(|e| e.to_string())
    })();
    result.unwrap_or(false)
}

/// Walks a picked folder tree, emitting one index row per entry (folders
/// included, so their names are searchable). Stops early when `emit` returns
/// `false`.
pub fn walk_tree(tree_uri: &str, emit: &mut impl FnMut(IndexRow) -> bool) -> Result<(), String> {
    let vm = current_vm()?;
    let (mut env, class) = load_bridge(&vm)?;
    walk_dir(&mut env, &class, tree_uri, tree_uri, 0, emit)
}

fn walk_dir(
    env: &mut JNIEnv,
    class: &JClass,
    tree_uri: &str,
    document_uri: &str,
    depth: usize,
    emit: &mut impl FnMut(IndexRow) -> bool,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        log::warn!("SAF: depth limit reached below {document_uri}");
        return Ok(());
    }

    for child in list_children(env, class, tree_uri, document_uri)? {
        if child.is_dir && crate::is_junk_dir(&child.name) {
            continue;
        }

        let ext = Path::new(&child.name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let category = crate::get_category(child.is_dir, ext);
        let mtime = child.last_modified / 1000;

        let mut text = String::new();
        if !child.is_dir && crate::content::should_index_content(ext) {
            if let Some(bytes) = read_bytes(env, class, &child.uri, MAX_READ_BYTES)? {
                text = crate::content::extract_text_from_bytes(&bytes, ext);
            }
        }

        let content = format!("{} {} {}", child.name, child.uri, text);
        let row = (
            child.name.clone(),
            child.uri.clone(),
            content,
            mtime,
            child.size,
            category,
        );
        if !emit(row) {
            return Ok(());
        }

        if child.is_dir {
            walk_dir(env, class, tree_uri, &child.uri, depth + 1, emit)?;
        }
    }
    Ok(())
}

/// Lists one folder's direct children, decoded from `SafBridge` JSON.
fn list_children(
    env: &mut JNIEnv,
    class: &JClass,
    tree_uri: &str,
    document_uri: &str,
) -> Result<Vec<Child>, String> {
    let tree = env.new_string(tree_uri).map_err(|e| e.to_string())?;
    let doc = env.new_string(document_uri).map_err(|e| e.to_string())?;
    let json = env
        .call_static_method(
            class,
            "listChildren",
            "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
            &[JValue::Object(&tree), JValue::Object(&doc)],
        )
        .and_then(|v| v.l())
        .map_err(|e| e.to_string())?;

    let json: String = env
        .get_string(&JString::from(json))
        .map_err(|e| e.to_string())?
        .into();
    serde_json::from_str(&json).map_err(|e| format!("SafBridge.listChildren: {e}"))
}

/// Reads a document's bytes, or `None` when it exceeds `max_bytes`.
fn read_bytes(
    env: &mut JNIEnv,
    class: &JClass,
    document_uri: &str,
    max_bytes: i64,
) -> Result<Option<Vec<u8>>, String> {
    let uri = env.new_string(document_uri).map_err(|e| e.to_string())?;
    let array = env
        .call_static_method(
            class,
            "readBytes",
            "(Ljava/lang/String;J)[B",
            &[JValue::Object(&uri), JValue::Long(max_bytes)],
        )
        .and_then(|v| v.l())
        .map_err(|e| e.to_string())?;

    if array.is_null() {
        return Ok(None);
    }
    env.convert_byte_array(JByteArray::from(array))
        .map(Some)
        .map_err(|e| e.to_string())
}
