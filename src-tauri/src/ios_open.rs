#[cfg(target_os = "ios")]
use std::path::PathBuf;
use tauri::plugin::Builder;
#[cfg(target_os = "ios")]
use tauri::plugin::PluginHandle;
use tauri::plugin::TauriPlugin;
use tauri::{Manager, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_vexil);

/// Handle to the iOS half of the plugin.
///
/// The Swift `VexilPlugin` owns a `UIDocumentInteractionController`; this side
/// only forwards the request and surfaces whatever the plugin reported.
pub struct Vexil<R: Runtime> {
    #[cfg(target_os = "ios")]
    handle: PluginHandle<R>,
    #[cfg(not(target_os = "ios"))]
    _marker: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> Vexil<R> {
    /// Hands a local file to iOS so the user can open it in another app.
    #[cfg(target_os = "ios")]
    pub fn open_file(&self, path: PathBuf) -> Result<(), String> {
        self.handle
            .run_mobile_plugin("openFile", serde_json::json!({ "path": path }))
            .map_err(|e| e.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vexil")
        .setup(|app, api| {
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_vexil)?;
            #[cfg(not(target_os = "ios"))]
            let _ = &api;

            app.manage(Vexil::<R> {
                #[cfg(target_os = "ios")]
                handle,
                #[cfg(not(target_os = "ios"))]
                _marker: std::marker::PhantomData,
            });
            Ok(())
        })
        .build()
}
