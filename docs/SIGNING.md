# Подписване на десктоп пакетите и канал за обновления

Докато собственикът не добави секретите по-долу, всичко работи както досега: пакетите са
неподписани, проверката е само със SHA-256, а GitHub Pages публикува само уеб приложението.
Стъпките в CI, които подписват, се **пропускат с бележка** (`::notice`), без грешка.

| Секрет / променлива | Задължително | Какво включва |
|---|---|---|
| `LINUX_GPG_PRIVATE_KEY` (секрет) | за Linux подпис | подпис на `.rpm`, `SHA256SUMS-linux.txt.asc`, публичен ключ, подписано APT + dnf хранилище в `<сайт>/linux/` |
| `LINUX_GPG_PASSPHRASE` (секрет) | само ако ключът има парола | паролата на ключа |
| `LINUX_REPO_URL` (променлива) | не | адрес на хранилището в `.repo` файла; по подразбиране `https://<owner>.github.io/<repo>/linux` |
| `WINDOWS_CERT_PFX_BASE64` (секрет) | за Windows подпис | сертификатът за подпис на код (`.pfx`), кодиран в base64 |
| `WINDOWS_CERT_PASSWORD` (секрет) | заедно с горния | паролата на `.pfx` |
| `WINDOWS_TIMESTAMP_URL` | не | друг сървър за времеви печат (по подразбиране DigiCert) |

Секретите се добавят от **Settings → Secrets and variables → Actions → New repository
secret**. Променливите са в същия екран, раздел **Variables**.

---

## Linux: GPG ключ

### 1. Създаване (на твоя компютър, не в CI)

Ползвай **RSA 4096**: работи навсякъде (apt, dnf на Fedora/RHEL, zypper). Ed25519 е по-модерен,
но по-старите rpm (RHEL 8/9) не го приемат.

```bash
# В отделна папка, за да не смесваш с личните си ключове:
export GNUPGHOME="$HOME/p2p-release-gnupg"; mkdir -m 700 -p "$GNUPGHOME"

# Интерактивно (избери: (1) RSA and RSA, 4096, срок 3y, име "P2P Messenger Release Signing"):
gpg --full-generate-key

# или с една команда (пита за парола):
gpg --quick-generate-key "P2P Messenger Release Signing <ИМЕЙЛ>" rsa4096 sign 3y

gpg --list-secret-keys --with-colons | awk -F: '$1=="fpr"{print $10; exit}'   # отпечатъкът (40 знака)
```

Ключът само **подписва** (`sign`), не шифрова. Срокът (3 години) се удължава по-късно с
`gpg --quick-set-expire ОТПЕЧАТЪК 3y` и ново качване на публичния ключ (CI го прави сам).

### 2. Износ към GitHub

```bash
FPR=<отпечатъкът от горе>
gpg --armor --export-secret-keys "$FPR" > private.asc   # -> секрет LINUX_GPG_PRIVATE_KEY (цялото съдържание)
gpg --armor --export "$FPR"             > public.asc    # публичният ключ (CI го публикува сам)
gpg --output revoke.asc --gen-revoke "$FPR"             # сертификат за отмяна, ако ключът изтече навън

gh secret set LINUX_GPG_PRIVATE_KEY < private.asc        # или през уеб интерфейса
gh secret set LINUX_GPG_PASSPHRASE                       # пита за паролата; пропусни, ако ключът няма
shred -u private.asc
```

`revoke.asc` и цялата папка `$GNUPGHOME` пази **офлайн** (флашка, менажер на пароли). В
секрета трябва да има **точно един** таен ключ, иначе CI спира.

### 3. Какво прави CI при издание (`linux-desktop.yml`, задача `release`)

1. Внася ключа във временна папка (`$RUNNER_TEMP`), която се трие накрая (`if: always()`).
2. `rpm --addsign` на `.rpm` (`scripts/linux/sign-release.sh`).
3. Записва отпечатъка в `install.sh` (`PINNED_FPR_DEFAULT`). От този момент `install.sh`
   **изисква** валиден подпис; липсващ или чужд подпис спира инсталирането.
4. Прави наново `SHA256SUMS-linux.txt` и го подписва → `SHA256SUMS-linux.txt.asc`.
5. Публикува `p2p-messenger-signing-key.asc` и `p2p-messenger-archive-keyring.gpg`.
6. Прави APT хранилище (`apt-ftparchive`, подписани `InRelease` и `Release.gpg`) и dnf
   хранилище (`createrepo_c`, подписан `repomd.xml.asc`) — `scripts/linux/build-repo.sh`.
   Метаданните (без пакетите) отиват в Release-а като `p2p-messenger-linux-repo.tar.gz`.
7. Тества хранилището, преди да е публично: `install.sh --add-repo` с `apt` на Ubuntu и с
   `dnf` във Fedora контейнер.

След успешен Linux workflow `pages.yml` се пуска сам, взима метаданните и пакетите от
най-новото подписано издание (сверява SHA-256) и ги слага в `<сайт>/linux/` до уеб
приложението.

**Защо `.deb` не е подписан вътре.** `dpkg` никога не проверява вграден подпис: `dpkg-sig`
е премахнат от Debian 12, а `debsigs` е изключен по подразбиране. Подпис вътре в `.deb` би бил
само украса. Debian и Ubuntu вярват на пакетите чрез подписания `InRelease` на хранилището
(той съдържа SHA-256 на `Packages`, а той — на всеки `.deb`), а свален на ръка `.deb` се
проверява чрез `SHA256SUMS-linux.txt.asc`. `.rpm` се подписва, защото `dnf`/`zypper`
проверяват подписа на самия пакет (`gpgcheck=1`).

**Защо хранилището е в GitHub Pages, а не в клон `gh-pages`.** Pages на този проект се
публикува от Actions (`pages.yml`), а тогава сайтът е **само един артефакт**: отделен клон
не може да се сервира едновременно. Затова хранилището се добавя в същия артефакт, под
`/linux/`, и не пречи на уеб приложението. Пакетите се пазят само в Release-а (не в git), а
Pages държи само **последната** версия (~200 MB; лимитът на сайта е 1 GB). По-старите
версии остават в Releases. Ключът за подпис никога не влиза в `pages.yml`.

### Ръчна проверка на подписа

```bash
gpg --import p2p-messenger-signing-key.asc
gpg --fingerprint "P2P Messenger"              # сравни отпечатъка с README / сайта
gpg --verify SHA256SUMS-linux.txt.asc SHA256SUMS-linux.txt
sha256sum -c --ignore-missing SHA256SUMS-linux.txt
rpm -K P2P-Messenger-*.rpm                     # след: sudo rpm --import p2p-messenger-signing-key.asc
```

Препоръчително: публикувай отпечатъка и в README, за да има втори източник за сравнение.

---

## Windows: сертификат за подпис на код

Без подпис SmartScreen предупреждава при всяко сваляне. С подпис предупреждението изчезва
постепенно, когато подписаните издания натрупат репутация (с OV сертификат) или веднага
(с EV / Azure Trusted Signing).

### Възможности

| Вариант | Цена (приблизително) | Бележка |
|---|---|---|
| **SignPath Foundation** (signpath.org) | безплатно за OSS | За проекти с отворен код и OSI лиценз. Подписва през тяхната услуга (GitHub Action), **не** дава `.pfx`. Ако избереш това, стъпката с `signtool` се заменя с тяхното действие. |
| **Azure Trusted Signing** | ~10 USD/месец | Сертификат, управляван от Microsoft, мигновена репутация в SmartScreen. Изисква проверка на самоличност (физически лица — в част от държавите; провери дали България е включена). Не дава `.pfx`; Tauri го ползва със `signCommand: "trusted-signing-cli ... %1"`. |
| **Certum Open Source Code Signing** | ~25–60 EUR/година | За разработчици на отворен код, на физическо лице. Ключът е на смарт карта/облак (SimplySign), не `.pfx` за CI без допълнителна настройка. |
| **OV сертификат** (Sectigo, SSL.com и др.) | ~70–300 USD/година | От юни 2023 ключът трябва да е в хардуерен модул (HSM/токен) — обикновен `.pfx` вече не се издава. Повечето доставчици имат облачен вариант (напр. SSL.com eSigner) с CLI. |
| **`.pfx` (самоподписан или вътрешен)** | безплатно | Само за тест на CI: подписът ще е „невалиден“ за SmartScreen. |

CI в този проект поддържа директно **`.pfx` + парола** (`signtool`). За облачните варианти
(Azure Trusted Signing, SignPath, eSigner) смени само командата в `scripts/windows/sign.ps1`
или `signCommand`; останалото (проверка със `signtool verify`, суми, winget) остава същото.

### Добавяне на `.pfx`

```powershell
# PowerShell: кодиране в base64 (един ред, без нови редове)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("codesign.pfx")) | Set-Clipboard
```
```bash
# Linux/macOS
base64 -w0 codesign.pfx        # macOS: base64 -i codesign.pfx
gh secret set WINDOWS_CERT_PFX_BASE64 < <(base64 -w0 codesign.pfx)
gh secret set WINDOWS_CERT_PASSWORD
```

Тестов самоподписан `.pfx` (само за проверка, че CI стъпките минават):

```powershell
$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=P2P Messenger Test" -CertStoreLocation Cert:\CurrentUser\My
Export-PfxCertificate -Cert $c -FilePath codesign.pfx -Password (Read-Host -AsSecureString "Парола")
```
(С него `signtool verify /pa` ще откаже, защото коренът не е доверен — очаквано.)

### Какво прави CI (`windows-desktop.yml`, задача `build`)

1. Декодира `.pfx` в `$RUNNER_TEMP`, проверява паролата и че има таен ключ.
2. `tauri build --config <overlay>` с `bundle.windows.signCommand` → `scripts/windows/sign.ps1`:
   `signtool sign /fd SHA256 /tr <timestamp> /td SHA256` на програмата и на инсталатора.
3. Подписва и `p2p-messenger.exe` от портативния zip, ако Tauri не го е подписал.
4. `signtool verify /pa /all` на двата файла; при грешка изданието спира.
5. Едва после се правят `SHA256SUMS.txt` и winget манифестите (с хеша на подписания файл).
6. `.pfx` се трие (`if: always()`).

---

## Какво е проверено и какво не

- Проверено локално с временен ключ: подпис на `.rpm` и на сумите, `install.sh` (валиден,
  подменен, липсващ, чужд подпис), APT хранилище от `file://` с `apt-get update`,
  `install.sh --add-repo`, обновяване 0.7.0 → 0.7.1 с `apt`, сглобяване на `/linux/` за Pages.
- Не е проверено, докато няма истински секрети: стъпките в GitHub Actions с ключа, `dnf`
  срещу хранилището (тества се в CI в Fedora контейнер при първото подписано издание),
  `signtool` с истински сертификат и репутацията в SmartScreen.
