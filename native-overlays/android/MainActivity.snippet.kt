// Add to android/app/src/main/java/com/dyrakarmy/p2pmessenger/MainActivity.kt
// Register the plugin BEFORE super.onCreate (Capacitor 6+ API).

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(PasskeyBridgePlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
