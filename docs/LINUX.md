# P2P Messenger за Linux

Десктоп версия на същото приложение за 64-битов Linux (x86_64). Цялото уеб приложение е
вътре в пакета, затова работи без твоя компютър, без сайта и без тунела. Пакетите се
събират в GitHub Actions на чиста машина (`.github/workflows/linux-desktop.yml`).

> **Защо Electron, а не Tauri като на Windows?** Tauri ползва WebKitGTK на системата, а в
> Debian и Ubuntu той е събран **без WebRTC**. Без WebRTC няма директна връзка между
> устройствата, а това е целият смисъл на приложението. Затова Linux версията носи свой
> Chromium (Electron). Цената е размерът: около 100 MB вместо 3 MB.

## Файлове за сваляне

| Файл | За кого | Бележка |
|---|---|---|
| `P2P-Messenger-<версия>-amd64.deb` | Debian, Ubuntu, Mint, Pop!_OS | Системен пакет. Препоръчан за Ubuntu 24.04. |
| `P2P-Messenger-<версия>-x86_64.rpm` | Fedora, RHEL, openSUSE | Системен пакет. |
| `P2P-Messenger-<версия>-x86_64.AppImage` | Всяка друга система, без инсталиране | Един файл, само за теб, без root. |
| `P2P-Messenger-<версия>-x86_64.flatpak` | Всяка система с Flatpak | Изолирано, с минимални права. Виж раздела „Flatpak“. |
| `install.sh` | Всички | Сваля, проверява и инсталира сам правилния пакет. |
| `SHA256SUMS-linux.txt` | Проверка | Контролни суми на всички файлове по-горе. |
| `SHA256SUMS-linux.txt.asc` | Проверка | GPG подпис на сумите (само в подписани издания). |
| `p2p-messenger-signing-key.asc`, `p2p-messenger-archive-keyring.gpg` | Проверка, apt | Публичният ключ за подпис (само в подписани издания). |

## Инсталиране с един скрипт (препоръчано)

Скриптът сам избира пакета за твоята система, сваля го от Release-а, **проверява
контролната сума** и чак тогава го инсталира. Прегледай го, преди да го пуснеш:

```bash
curl -fsSLO https://github.com/biramentv-ux/p2p-pure/releases/download/desktop-v0.7.0/install.sh
less install.sh          # прегледай го
bash install.sh
```

(Подмени `0.7.0` с версията от [Releases](https://github.com/biramentv-ux/p2p-pure/releases).
Пакетите са отбелязани като pre-release, затова няма адрес „latest“.) Самият `install.sh`
също е в `SHA256SUMS-linux.txt`.

Полезни параметри: `--version 0.7.0`, `--appimage` (само за теб, без root), `--dry-run`
(само показва), `--uninstall` (премахва; данните и хранилището), `--from-dir ПАПКА` (файловете
вече са свалени), `--add-repo` (добавя хранилището за обновления, виж по-долу).

В **подписано** издание `install.sh` носи вътре отпечатъка на ключа и проверява и GPG
подписа на `SHA256SUMS-linux.txt` с `gpg`. Липсващ, подменен или чужд подпис спира
инсталирането. Ако на системата няма `gpg`, остава проверката на сумата (както досега) с
предупреждение. В неподписано издание всичко е както преди.

## Обновления през apt / dnf (подписано хранилище)

Активно е, след като собственикът добави ключа за подпис (виж [SIGNING.md](SIGNING.md)).
Хранилището е на GitHub Pages, до уеб приложението: `https://biramentv-ux.github.io/p2p-pure/linux/`.
Държи само последната версия; по-старите са в Releases.

Най-лесно, с проверка на ключа срещу отпечатъка в `install.sh`:

```bash
bash install.sh --add-repo
```

На ръка, **Debian / Ubuntu** (ключът е само за това хранилище — `signed-by`, не `apt-key`):

```bash
curl -fsSL https://biramentv-ux.github.io/p2p-pure/linux/p2p-messenger-archive-keyring.gpg \
  | sudo tee /usr/share/keyrings/p2p-messenger-archive-keyring.gpg >/dev/null
gpg --show-keys /usr/share/keyrings/p2p-messenger-archive-keyring.gpg   # сравни отпечатъка!
sudo tee /etc/apt/sources.list.d/p2p-messenger.sources >/dev/null <<'EOF'
Types: deb
URIs: https://biramentv-ux.github.io/p2p-pure/linux/apt
Suites: stable
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/p2p-messenger-archive-keyring.gpg
EOF
sudo apt update && sudo apt install p2p-messenger
```

Старият едноредов формат (Debian 11, Ubuntu 20.04):
`deb [arch=amd64 signed-by=/usr/share/keyrings/p2p-messenger-archive-keyring.gpg] https://biramentv-ux.github.io/p2p-pure/linux/apt stable main`

**Fedora / RHEL** (`gpgcheck` проверява всеки `.rpm`, `repo_gpgcheck` — метаданните):

```bash
sudo dnf config-manager addrepo --from-repofile=https://biramentv-ux.github.io/p2p-pure/linux/rpm/p2p-messenger.repo
# по-стар dnf: sudo curl -fsSLo /etc/yum.repos.d/p2p-messenger.repo <същия адрес>
sudo dnf install p2p-messenger      # при първото пускане dnf показва отпечатъка: сравни го
```

**openSUSE:** `sudo zypper addrepo https://biramentv-ux.github.io/p2p-pure/linux/rpm/p2p-messenger.repo && sudo zypper install p2p-messenger`

После обновленията идват с `sudo apt upgrade` / `sudo dnf upgrade`. Премахване на
хранилището: `bash install.sh --uninstall` (или изтрий файловете в `/etc/apt/sources.list.d/`,
`/usr/share/keyrings/`, `/etc/yum.repos.d/` с име `p2p-messenger`).

## Инсталиране на ръка

```bash
sha256sum -c --ignore-missing SHA256SUMS-linux.txt      # сравнява свалените файлове

sudo apt install ./P2P-Messenger-0.7.0-amd64.deb        # Debian, Ubuntu
sudo dnf install ./P2P-Messenger-0.7.0-x86_64.rpm       # Fedora
sudo zypper --no-gpg-checks install ./P2P-Messenger-0.7.0-x86_64.rpm   # openSUSE

chmod +x P2P-Messenger-0.7.0-x86_64.AppImage && ./P2P-Messenger-0.7.0-x86_64.AppImage   # AppImage
```

Програмата се отваря от менюто като „P2P Messenger“ или с командата `p2p-messenger`.
В подписано издание провери и подписа: `gpg --verify SHA256SUMS-linux.txt.asc` (подробно в
[SIGNING.md](SIGNING.md)). В неподписано контролните суми са единствената проверка.

## Ubuntu 24.04 и AppImage

Ubuntu 23.10 и по-нови забраняват на програми без AppArmor профил да ползват „user
namespaces“, а Chromium (и Electron) ги ползват за своята изолация (sandbox). Затова:

- **`.deb`** работи: пакетът сам слага `chrome-sandbox` с нужните права (setuid), когато
  системата не позволява друго. CI проверява инсталиран `.deb` на Ubuntu 24.04 с истинския sandbox.
- **AppImage** не може да слага setuid и на такава система може да **не се отвори**. Ползвай
  `.deb`. Ако нямаш избор, `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`
  отключва sandbox-а за цялата система. Не стартирай с `--no-sandbox`: това изключва
  изолацията на страницата.

## Изисквания

- 64-битов Linux със скорошно ядро (Debian 12+, Ubuntu 22.04+, Fedora 40+ или еквивалент).
- Графична среда (X11 или Wayland през XWayland). Нужни библиотеки: GTK 3, NSS, ALSA,
  libgbm (пакетите ги изискват и пакетният мениджър ги донася сам).
- За камера и микрофон (QR сканиране, разговори): достъп до `/dev/video*` и PipeWire/Pulse.

## Flatpak

Пакет `bg.p2pmessenger.app` върху `org.freedesktop.Platform` и `org.electronjs.Electron2.BaseApp`
(клон 25.08). Приложението е същото като в `.deb`, но върви в изолация на Flatpak и **без достъп до
файловете ти**.

```bash
sha256sum -c --ignore-missing SHA256SUMS-linux.txt
flatpak install --user ./P2P-Messenger-0.7.0-x86_64.flatpak     # runtime-ът се сваля от Flathub
flatpak run bg.p2pmessenger.app
flatpak uninstall --user bg.p2pmessenger.app                    # (--delete-data изтрива и профила)
```

Права (`finish-args` в `flatpak/bg.p2pmessenger.app.yml`): мрежа; Wayland, а X11 само ако няма Wayland;
звук (микрофон за разговори); `--device=all` за `/dev/video*` (камерата за QR сканиране; Flatpak няма
по-тясно право за камера без портал, а Chromium още не го ползва); известия и
`org.freedesktop.secrets` (Electron пази ключа за бисквитките в libsecret). **Няма** `--filesystem`,
няма достъп до сесийната и системната шина, до ssh/gpg агента. Тест (`tests/desktop/flatpak.test.ts`)
пада, ако някое от тези права се добави.

- **Данни:** `~/.var/app/bg.p2pmessenger.app/config/p2p-messenger`. Не се споделят с `.deb` версията;
  за същата идентичност я възстанови с 12-те думи.
- **Sandbox:** Chromium ползва `zypak` от BaseApp, не setuid `chrome-sandbox` (той не се слага в пакета).
  Затова пакетът работи и на Ubuntu 24.04 с ограничени user namespaces.
- **Какво е вързано:** манифестът няма адреси за сваляне. Единственият му източник е архив на
  разопакованото приложение (от `electron-builder`, със заключените версии), вързан със SHA-256, който
  `scripts/linux/build-flatpak.sh` записва при сглобяване. Runtime-ът и BaseApp идват от Flathub по клон
  (25.08), не по отпечатък на commit.
- **Не е във Flathub.** Пакетът е само файл от Releases; за Flathub трябва ново подаване и сглобяване
  от изходен код без мрежа (flatpak-node-generator).

Сглобяване на твоя машина (нужни са `flatpak`, `flatpak-builder` и runtime-ът от Flathub):

```bash
flatpak install --user flathub org.freedesktop.Platform//25.08 org.freedesktop.Sdk//25.08 org.electronjs.Electron2.BaseApp//25.08
npm run build:desktop && npm --prefix electron ci && npm --prefix electron run dist:dir
bash scripts/linux/build-flatpak.sh out      # -> out/P2P-Messenger-<версия>-x86_64.flatpak
```

CI (`flatpak` в `linux-desktop.yml`) сглобява пакета, инсталира го, проверява правата и го пуска под
Xvfb; при таг `desktop-v*` го качва в същия Release.

## Какво е различно от браузърната версия

- **Отключване:** без passkey. Chromium на Linux няма вграден authenticator и не показва
  прозорец за него, така че заявката за passkey само би увиснала. Приложението тръгва
  направо по пътя с **парола**, същия като във всеки браузър без passkey. Възстановяването
  с 12-те думи работи навсякъде.
- **Данни:** шифрованият профил, контактите и историята са в `~/.config/p2p-messenger`
  (или `$XDG_CONFIG_HOME/p2p-messenger`). Не се споделят с профила в браузъра. За същата
  идентичност възстанови я с 12-те думи.
- **Без service worker:** обновленията идват с нов пакет, не автоматично.
- **Мрежа:** локалният режим (QR) не прави заявки към сървър. Демо режимът (стая с код) и
  краткият код изискват сигналния Worker и интернет.

## Как е защитено

- Страницата няма Node.js, няма preload скрипт и работи в изолиран процес (sandbox,
  `contextIsolation`). Приложението се зарежда от собствен адрес `app://p2p`, който чете
  само от папката на пакета (пътища с `..`, други хостове и невалидни адреси се отказват).
- Страницата не може да отвори прозорец или да навигира навън. Връзка към `https://` се
  отваря в браузъра ти. Разрешени са само камера и микрофон, само за собствените страници.
- Изключени са функциите на Electron, през които външен код може да влезе (`RunAsNode`,
  `NODE_OPTIONS`, `--inspect`), и приложението се зарежда само от запечатан `asar`.
- Строгата политика за съдържание (CSP) на уеб приложението е същата като в браузъра.
- Всичко се събира с точно зададени версии (`electron/package.json`), а пакетът няма
  други зависимости освен самия Electron.
- Тестове, които CI пуска върху **инсталирания** пакет: WebRTC канал, изолация, блокирана
  навигация, създаване на самоличност, рестарт и отключване със същата идентичност.

## Събиране на твоя машина

```bash
npm ci
npm run build:linux          # web приложение + .deb, .rpm, AppImage в electron/release/
npm run test:linux           # проверката по-горе върху проекта (нужен е xvfb-run без дисплей)
```

За `.rpm` е нужен `rpm` (`apt install rpm`). Като root в контейнер добави `NO_SANDBOX=1`
към теста.

## Ново издание

- От GitHub: **Actions → Linux desktop → Run workflow**. Файловете са в артефакта
  `p2p-messenger-linux-x64` (пазят се 30 дни).
- Или с таг: `git tag desktop-v0.7.0 && git push origin desktop-v0.7.0`. Тогава файловете
  се качват в същия GitHub Release като Windows версията (pre-release).
  Изданията са неизменяеми след публикуване, затова файловете първо влизат в **чернова**, а
  Windows и Linux процесите я публикуват, когато са качени и двата комплекта (публикува този, който
  завърши последен; `scripts/release/desktop-release.sh`). Ако едната платформа се провали,
  изданието остава чернова. За вече публикувано издание не могат да се добавят файлове:
  вдигни версията и използвай нов таг.
- Версията е в `electron/package.json` и трябва да е същата като в `src-tauri/tauri.conf.json`
  (има тест за това). Същата версия е и в `flatpak/bg.p2pmessenger.app.metainfo.xml` (проверява се от тест).

## Подпис

GPG подписът (`.rpm`, `SHA256SUMS-linux.txt.asc`) и APT/dnf хранилището се включват сами,
когато собственикът добави секрета `LINUX_GPG_PRIVATE_KEY`. Как се прави ключът, кои секрети
трябват и защо `.deb` не се подписва вътре: [SIGNING.md](SIGNING.md). Flatpak пакетът не се подписва вътре; ползва се `SHA256SUMS-linux.txt` (и подписът му, когато има ключ).
