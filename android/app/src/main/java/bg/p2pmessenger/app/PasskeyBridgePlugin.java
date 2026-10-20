package bg.p2pmessenger.app;

import androidx.core.content.ContextCompat;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CreatePublicKeyCredentialRequest;
import androidx.credentials.CreatePublicKeyCredentialResponse;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPublicKeyCredentialOption;
import androidx.credentials.PublicKeyCredential;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridge between the web code and the Android Credential Manager (Java port of the
 * earlier Kotlin draft, so no Kotlin toolchain is needed in the Capacitor project).
 *
 * The JS side (src/platform/mobile/nativePasskeys.ts) sends WebAuthn options as JSON
 * and gets the response JSON back. Credential Manager checks that this app may use the
 * rpId (Digital Asset Links, see native-overlays/android/README.md).
 *
 * Copied into android/ by scripts/mobile/sync-overlays.mjs. Compiling it needs the
 * Android SDK; the repository tests check its contract without compiling it.
 */
@CapacitorPlugin(name = "PasskeyBridge")
public class PasskeyBridgePlugin extends Plugin {

    private CredentialManager credentialManager;

    @Override
    public void load() {
        credentialManager = CredentialManager.create(getContext());
    }

    @PluginMethod
    public void create(PluginCall call) {
        String requestJson = call.getString("requestJson");
        if (requestJson == null) {
            call.reject("requestJson is required");
            return;
        }
        if (getActivity() == null) {
            call.reject("No activity to show the passkey sheet");
            return;
        }
        try {
            CreatePublicKeyCredentialRequest request = new CreatePublicKeyCredentialRequest(requestJson);
            credentialManager.createCredentialAsync(
                getActivity(),
                request,
                null,
                ContextCompat.getMainExecutor(getContext()),
                new CredentialManagerCallback<androidx.credentials.CreateCredentialResponse, CreateCredentialException>() {
                    @Override
                    public void onResult(androidx.credentials.CreateCredentialResponse result) {
                        if (!(result instanceof CreatePublicKeyCredentialResponse)) {
                            call.reject("Unexpected credential type");
                            return;
                        }
                        JSObject out = new JSObject();
                        out.put("responseJson", ((CreatePublicKeyCredentialResponse) result).getRegistrationResponseJson());
                        call.resolve(out);
                    }

                    @Override
                    public void onError(CreateCredentialException e) {
                        call.reject(e.getMessage() != null ? e.getMessage() : "Passkey creation failed", e.getType());
                    }
                });
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "Passkey creation failed");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String requestJson = call.getString("requestJson");
        if (requestJson == null) {
            call.reject("requestJson is required");
            return;
        }
        if (getActivity() == null) {
            call.reject("No activity to show the passkey sheet");
            return;
        }
        try {
            GetPublicKeyCredentialOption option = new GetPublicKeyCredentialOption(requestJson);
            GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
            credentialManager.getCredentialAsync(
                getActivity(),
                request,
                null,
                ContextCompat.getMainExecutor(getContext()),
                new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                    @Override
                    public void onResult(GetCredentialResponse result) {
                        if (!(result.getCredential() instanceof PublicKeyCredential)) {
                            call.reject("Unexpected credential type");
                            return;
                        }
                        JSObject out = new JSObject();
                        out.put("responseJson", ((PublicKeyCredential) result.getCredential()).getAuthenticationResponseJson());
                        call.resolve(out);
                    }

                    @Override
                    public void onError(GetCredentialException e) {
                        call.reject(e.getMessage() != null ? e.getMessage() : "Passkey sign-in failed", e.getType());
                    }
                });
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "Passkey sign-in failed");
        }
    }
}
