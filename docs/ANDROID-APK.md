# Android APK: директно инсталиране

## Сваляне
Сглобява се от **Actions → Android APK → Run workflow**. При празно поле `release_tag` APK-то е артефакт от изпълнението. При `android-v0.7.0` (или друг таг, започващ с `android-v`) се закача и към GitHub Release.

Файлът е `P2P-Messenger-<версия>-android.apk`, а до него е `SHA256SUMS-android.txt`.

## Инсталиране на телефона
1. Отвори .apk файла на телефона (от браузъра или от файловия мениджър).
2. Android ще поиска разрешение „Инсталиране на неизвестни приложения“ за този източник. Разреши го само за браузъра или файловия мениджър, които ползваш.
3. Инсталирай. Отключването е с парола. Passkey на Android работи едва когато SHA-256 на ключа е записан в `public/.well-known/assetlinks.json` (виж долу).

Проверка на файла (по желание):
```
sha256sum -c SHA256SUMS-android.txt
```

## Какво проверява CI за всяко APK
- release сглобяване, **не е debuggable** (WebView отладката е изключена);
- подписът минава `apksigner verify`;
- `allowBackup=false` и `data_extraction_rules`: самоличността, контактите и историята **не отиват** в облачно архивиране на Google, нито при прехвърляне към ново устройство;
- няма разрешения извън камера, микрофон, локация и интернет.

## Ключ за подписване
Без secrets всяко сглобяване получава **еднократен ключ**. APK-то работи, но следващото сглобяване не може да обнови вече инсталираното: Android иска първо да го деинсталираш, а това трие данните. Прехвърли ги първо или запиши 12-те думи.

За постоянен ключ (един път, на твоята машина):
```
keytool -genkeypair -keystore p2p-release.jks -storetype PKCS12 -alias p2p -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=P2P Messenger"
```
Пази `p2p-release.jks` и паролата офлайн. Ако ги загубиш, обновяванията спират завинаги.

После в GitHub → Settings → Secrets and variables → Actions добави:

| Secret | Стойност |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | съдържанието на `base64 -w0 p2p-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | паролата на хранилището |
| `ANDROID_KEY_ALIAS` | `p2p` |
| `ANDROID_KEY_PASSWORD` | паролата на ключа (същата, ако не си задал друга) |

SHA-256 на сертификата се изписва в обобщението на всяко изпълнение. С постоянния ключ го сложи в `public/.well-known/assetlinks.json`. Тогава passkey работи и в APK-то.

## Passkey в APK-то
APK-то се сглобява с `VITE_PASSKEY_RP_ID=dyrakarmy.online` (или стойността на променливата `PASSKEY_RP_ID` в Settings → Variables). Passkey работи, когато:
1. APK-то е подписано с постоянния ключ;
2. `https://<този домейн>/.well-known/assetlinks.json` съдържа SHA-256 на ключа (от обобщението на изпълнението).

Докато не е така, създаването на passkey пада и приложението предлага парола.
