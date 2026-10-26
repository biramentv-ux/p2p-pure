# P2P Messenger за Windows

Десктоп версия на същото приложение, събрана с Tauri 2. Цялото уеб приложение е вътре в
пакета, затова работи без твоя компютър, без сайта и без тунела. Пакетът се събира в
GitHub Actions на чиста Windows машина (`.github/workflows/windows-desktop.yml`).

## Файлове за сваляне

| Файл | За кого | Бележка |
|---|---|---|
| `P2P-Messenger-Setup-x64.exe` | Повечето хора | Инсталатор. Слага програмата само за текущия потребител, без администраторски права. Добавя икона в старт менюто и деинсталация от „Настройки → Приложения“. Ако липсва WebView2, го сваля сам. |
| `P2P-Messenger-portable-x64.zip` | Без инсталиране | Разархивира се и се стартира. Нужен е WebView2 (вграден в Windows 11). |
| `P2P-Messenger-winget-manifests.zip` | winget | Манифести за инсталиране с една команда (виж „Инсталиране с winget“). |
| `SHA256SUMS.txt` | Проверка | Контролни суми на файловете. |

## Инсталиране

1. Свали `P2P-Messenger-Setup-x64.exe` и го стартирай.
2. Windows може да покаже **„Windows protected your PC“**, защото пакетът още не е подписан.
   Натисни **More info** (Повече информация), после **Run anyway** (Изпълни въпреки това).
3. Следвай стъпките на инсталатора. Програмата се отваря от старт менюто като „P2P Messenger“.

Проверка, че файлът не е подменен (PowerShell):

```powershell
Get-FileHash .\P2P-Messenger-Setup-x64.exe -Algorithm SHA256
```

Сравни резултата с реда в `SHA256SUMS.txt`.

## Инсталиране с winget

Идентификатор на пакета: `DyrakArmy.P2PMessenger`. Манифестите са със схема 1.10.0, за да
ги чете и winget 1.11.

**След като пакетът е приет в официалното хранилище** (виж „Публикуване в winget“):

```powershell
winget install DyrakArmy.P2PMessenger
```

Обновяване: `winget upgrade DyrakArmy.P2PMessenger`. Премахване: `winget uninstall DyrakArmy.P2PMessenger`.

**Преди това, от манифестите в Release-а** (еднократно включване, в PowerShell като администратор):

```powershell
winget settings --enable LocalManifestFiles
Expand-Archive .\P2P-Messenger-winget-manifests.zip -DestinationPath .\winget
winget install --manifest .\winget\manifests\d\DyrakArmy\P2PMessenger\0.7.0
```

winget проверява SHA256 на инсталатора спрямо манифеста, преди да го пусне.

## Публикуване в winget

1. Създай таг за изданието (виж „Ново издание“). CI качва инсталатора и манифестите в
   Release-а, после инсталира програмата през winget от самия Release, като проверка.
2. За автоматично изпращане към [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
   добави в репото секрет `WINGET_TOKEN`: GitHub токен (classic) с право `public_repo`.
   **Settings → Secrets and variables → Actions → New repository secret.** Без него CI само
   прикача манифестите и нищо не изпраща.
3. CI отваря pull request с `wingetcreate`. Проверката в хранилището (сканиране на
   инсталатора, тестово инсталиране) и прегледът от модераторите отнемат от часове до
   няколко дни. Едва след сливането работи `winget install DyrakArmy.P2PMessenger`.

Пакетът още не е подписан. Хранилището не забранява неподписани инсталатори, но
сканирането може да ги задържи по-дълго. Ако искаш да изчакаш сертификата, просто не
добавяй `WINGET_TOKEN`.

## Изисквания

- Windows 10 или 11, 64-битов.
- Microsoft Edge WebView2. В Windows 11 е вграден. Инсталаторът го добавя, ако липсва,
  като за това е нужен интернет.

## Какво е различно от браузърната версия

- **Отключване:** вход с passkey (Windows Hello) в десктоп прозореца може да не е наличен.
  Тогава приложението използва парола, както и в браузъри без поддръжка на PRF.
  Възстановяването с 12-те думи работи навсякъде.
- **Данни:** шифрованият профил, контактите и историята са в
  `%LOCALAPPDATA%\bg.p2pmessenger.desktop`. Те не се споделят с профила в браузъра.
  За да ползваш същата идентичност, възстанови я с 12-те думи.
- **Без service worker:** обновленията идват с нов инсталатор, не автоматично.
- **Мрежа:** локалният режим (QR) не прави заявки към сървър. Демо режимът (стая с код) и
  краткият код изискват сигналния Worker и интернет.

## Ново издание

- От GitHub: **Actions → Windows desktop → Run workflow**. Файловете са в артефакта
  `p2p-messenger-windows-x64` (пазят се 30 дни).
- Или с таг: `git tag desktop-v0.7.0 && git push origin desktop-v0.7.0`. Тогава файловете
  се качват и в GitHub Release (отбелязан като pre-release).
- Версията е в `src-tauri/tauri.conf.json` и `src-tauri/Cargo.toml`.

## Подпис (по-късно)

Когато има сертификат, в `tauri.conf.json` се добавя `bundle.windows.certificateThumbprint`
(или команда за подпис), и CI подписва и инсталатора, и самата програма. Тогава
предупреждението на SmartScreen постепенно изчезва, докато подписаните издания натрупват
репутация.
