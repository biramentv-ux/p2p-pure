//! Windows Hello unlock (biometrics / PIN) for the desktop app.
//!
//! WebView2 does not hand the WebAuthn PRF secret to the page, so the passkey cannot protect
//! the seed there. Instead the web code asks this module to sign a fixed 32-byte challenge
//! with a Windows Hello key (KeyCredentialManager). That key is an RSA-2048 key kept by
//! Windows (TPM when present) and every use needs the user's face, fingerprint or PIN.
//! RSA PKCS#1 v1.5 signatures are deterministic, so the same challenge always gives the same
//! bytes; the web code runs them through HKDF to get the AES key that wraps the seed.
//!
//! The surface is kept narrow on purpose: only credentials named `p2p-messenger-<hex>` and
//! only 32-byte challenges, so the window cannot use this as a general Hello signing oracle.

/// Prefix of every credential this app creates; others are refused.
const NAME_PREFIX: &str = "p2p-messenger-";

pub fn validate_request(name: &str, challenge: &[u8]) -> Result<(), String> {
    let suffix = name
        .strip_prefix(NAME_PREFIX)
        .ok_or_else(|| "invalid credential name".to_string())?;
    if suffix.len() < 16 || suffix.len() > 64 || !suffix.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("invalid credential name".into());
    }
    if challenge.len() != 32 {
        return Err("challenge must be 32 bytes".into());
    }
    Ok(())
}

/// "available", "unavailable" (Windows, but no Hello set up / no device) or "unsupported".
#[tauri::command]
pub async fn windows_hello_status() -> String {
    imp::status().await
}

/// Signs `challenge` with the Hello key `name` (creating it first when `create` is true).
/// Shows the Windows Hello prompt. Errors: "cancelled", "unavailable", "not-found", or text.
#[tauri::command]
pub async fn windows_hello_sign(name: String, challenge: Vec<u8>, create: bool) -> Result<Vec<u8>, String> {
    validate_request(&name, &challenge)?;
    imp::sign(name, challenge, create).await
}

#[cfg(windows)]
mod imp {
    use windows::core::HSTRING;
    use windows::Security::Credentials::{
        KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::CryptographicBuffer;

    fn status_error(s: KeyCredentialStatus) -> String {
        match s {
            KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => "cancelled".into(),
            KeyCredentialStatus::NotFound => "not-found".into(),
            KeyCredentialStatus::SecurityDeviceLocked => "locked".into(),
            other => format!("hello-status-{}", other.0),
        }
    }

    pub async fn status() -> String {
        // The WinRT calls block; keep them off the async runtime's worker.
        tauri::async_runtime::spawn_blocking(|| {
            match KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()) {
                Ok(true) => "available".to_string(),
                _ => "unavailable".to_string(),
            }
        })
        .await
        .unwrap_or_else(|_| "unavailable".to_string())
    }

    pub async fn sign(name: String, challenge: Vec<u8>, create: bool) -> Result<Vec<u8>, String> {
        tauri::async_runtime::spawn_blocking(move || sign_blocking(&name, &challenge, create))
            .await
            .map_err(|e| e.to_string())?
    }

    fn sign_blocking(name: &str, challenge: &[u8], create: bool) -> Result<Vec<u8>, String> {
        if !KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()).unwrap_or(false) {
            return Err("unavailable".into());
        }
        let hname = HSTRING::from(name);
        let result = if create {
            KeyCredentialManager::RequestCreateAsync(&hname, KeyCredentialCreationOption::ReplaceExisting)
        } else {
            KeyCredentialManager::OpenAsync(&hname)
        }
        .and_then(|op| op.join())
        .map_err(|e| e.message().to_string())?;
        let st = result.Status().map_err(|e| e.message().to_string())?;
        if st != KeyCredentialStatus::Success {
            return Err(status_error(st));
        }
        let credential = result.Credential().map_err(|e| e.message().to_string())?;
        let buffer = CryptographicBuffer::CreateFromByteArray(challenge).map_err(|e| e.message().to_string())?;
        let op = credential
            .RequestSignAsync(&buffer)
            .and_then(|op| op.join())
            .map_err(|e| e.message().to_string())?;
        let st = op.Status().map_err(|e| e.message().to_string())?;
        if st != KeyCredentialStatus::Success {
            return Err(status_error(st));
        }
        let signed = op.Result().map_err(|e| e.message().to_string())?;
        let mut out = windows::core::Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(&signed, &mut out).map_err(|e| e.message().to_string())?;
        Ok(out.to_vec())
    }
}

#[cfg(not(windows))]
mod imp {
    pub async fn status() -> String {
        "unsupported".to_string()
    }

    pub async fn sign(_name: String, _challenge: Vec<u8>, _create: bool) -> Result<Vec<u8>, String> {
        Err("unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::validate_request;

    #[test]
    fn accepts_app_names_and_32_byte_challenges() {
        assert!(validate_request("p2p-messenger-0123456789abcdef", &[0u8; 32]).is_ok());
    }

    #[test]
    fn rejects_other_names_and_sizes() {
        assert!(validate_request("other-app-0123456789abcdef", &[0u8; 32]).is_err());
        assert!(validate_request("p2p-messenger-short", &[0u8; 32]).is_err());
        assert!(validate_request("p2p-messenger-0123456789ABCDEF", &[0u8; 32]).is_err());
        assert!(validate_request("p2p-messenger-0123456789abcdef", &[0u8; 31]).is_err());
        assert!(validate_request("p2p-messenger-0123456789abcdef", &[0u8; 33]).is_err());
    }
}
