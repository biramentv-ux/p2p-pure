package com.dyrakarmy.p2pmessenger

import androidx.credentials.CredentialManager
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.lifecycle.lifecycleScope
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.launch

/**
 * Bridge between the web code and the Android Credential Manager.
 *
 * The JS side (src/platform/mobile/nativePasskeys.ts) sends WebAuthn options as JSON
 * and gets the response JSON back. Credential Manager checks that this app is allowed
 * to use the rpId (Digital Asset Links, see native-overlays/android/README.md).
 *
 * Not compiled or run in this repository yet: it needs the Capacitor Android project
 * (npx cap add android) and the Gradle dependencies listed in the README.
 */
@CapacitorPlugin(name = "PasskeyBridge")
class PasskeyBridgePlugin : Plugin() {

    private val credentialManager by lazy { CredentialManager.create(context) }

    @PluginMethod
    fun create(call: PluginCall) {
        val requestJson = call.getString("requestJson")
            ?: return call.reject("requestJson is required")
        val activity = activity ?: return call.reject("No activity to show the passkey sheet")

        activity.lifecycleScope.launch {
            try {
                val request = CreatePublicKeyCredentialRequest(requestJson)
                val result = credentialManager.createCredential(activity, request)
                val response = result as? CreatePublicKeyCredentialResponse
                    ?: return@launch call.reject("Unexpected credential type")
                val out = JSObject()
                out.put("responseJson", response.registrationResponseJson)
                call.resolve(out)
            } catch (e: CreateCredentialException) {
                call.reject(e.message ?: "Passkey creation failed", e.type)
            }
        }
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val requestJson = call.getString("requestJson")
            ?: return call.reject("requestJson is required")
        val activity = activity ?: return call.reject("No activity to show the passkey sheet")

        activity.lifecycleScope.launch {
            try {
                val option = GetPublicKeyCredentialOption(requestJson)
                val request = GetCredentialRequest(listOf(option))
                val result = credentialManager.getCredential(activity, request)
                val credential = result.credential as? PublicKeyCredential
                    ?: return@launch call.reject("Unexpected credential type")
                val out = JSObject()
                out.put("responseJson", credential.authenticationResponseJson)
                call.resolve(out)
            } catch (e: GetCredentialException) {
                call.reject(e.message ?: "Passkey sign-in failed", e.type)
            }
        }
    }
}
