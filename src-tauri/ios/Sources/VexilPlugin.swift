import Foundation
import Tauri
import UIKit

struct OpenFileArgs: Decodable {
  let path: String
}

@objc public class VexilPlugin: Plugin {
  /// Held for as long as the interaction is on screen:
  /// UIDocumentInteractionController is weakly retained by UIKit and tears
  /// itself down as soon as the last strong reference goes away.
  private var documentController: UIDocumentInteractionController?

  /// Selector is `openFile:error:`, which is what the iOS runtime looks for.
  @objc public func openFile(_ invoke: Invoke) throws {
    let args: OpenFileArgs
    do {
      args = try invoke.parseArgs(OpenFileArgs.self)
    } catch {
      invoke.reject(error.localizedDescription)
      return
    }

    let url = URL(fileURLWithPath: args.path)
    guard FileManager.default.fileExists(atPath: url.path) else {
      invoke.reject("No such file: \(url.path)")
      return
    }

    DispatchQueue.main.async { [weak self] in
      self?.present(url: url, invoke: invoke)
    }
  }

  private func present(url: URL, invoke: Invoke) {
    guard let host = manager.viewController?.view else {
      invoke.reject("Vexil has no view controller to present from.")
      return
    }

    let controller = UIDocumentInteractionController(url: url)
    controller.delegate = self
    documentController = controller

    // `presentOpenInMenu` hands the file to whichever app iOS has associated
    // with the type, and falls back to the app list when nothing can take it.
    let shown = controller.presentOpenInMenu(
      from: CGRect(x: host.bounds.midX, y: host.bounds.midY, width: 0, height: 0),
      in: host,
      animated: true
    )

    if shown {
      invoke.resolve()
    } else {
      documentController = nil
      invoke.reject("No app on this device can open \(url.lastPathComponent).")
    }
  }
}

extension VexilPlugin: UIDocumentInteractionControllerDelegate {
  public func documentInteractionControllerViewControllerForPreview(
    _ controller: UIDocumentInteractionController
  ) -> UIViewController {
    manager.viewController ?? UIViewController()
  }

  public func documentInteractionControllerDidDismissPreview(
    _ controller: UIDocumentInteractionController
  ) {
    documentController = nil
  }

  public func documentInteractionController(
    _ controller: UIDocumentInteractionController,
    didEndSendingToApplication applicationName: String
  ) {
    documentController = nil
  }
}

@_cdecl("init_plugin_vexil")
func initPlugin() -> Plugin {
  return VexilPlugin()
}
