import UIKit
import Capacitor

/// Main.storyboard points its view controller at this class (scripts/mobile/sync-overlays.mjs
/// sets customClass="MainViewController" customModule="App"). It registers app-local
/// Capacitor plugins, which are not discovered automatically.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BlePairingPlugin())
    }
}
