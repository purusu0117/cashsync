import UIKit
import Capacitor

/// Capacitor のブリッジVC。Capacitor 8 ではアプリ内カスタムプラグインの自動登録が無いため、
/// capacitorDidLoad() で VisionOcr プラグインを明示登録する（これが無いと JS 側で
/// 「"VisionOcr" plugin is not implemented on ios」になる）。
/// Main.storyboard のルートVCのクラスをこの MainViewController に差し替えて使う。
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(VisionOcrPlugin())
    }
}
