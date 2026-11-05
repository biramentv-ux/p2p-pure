# Верига на доставките: SBOM, контролни суми и подписи

Към всяко публикувано издание (GitHub Release) автоматично се добавят:

| Файл | Какво е |
|---|---|
| `p2p-pure-<таг>-web.cdx.json` | SBOM (CycloneDX 1.5) на уеб приложението: производствените npm зависимости |
| `p2p-pure-<таг>-electron.cdx.json` | SBOM на Electron (Linux) обвивката, всички зависимости от `electron/package-lock.json` |
| `p2p-pure-<таг>-rust.cdx.json` | SBOM на Tauri (Windows) обвивката, от `src-tauri/Cargo.lock`, за целта `x86_64-pc-windows-msvc` (включва Windows Hello зависимостите `windows*`) |
| `SHA256SUMS-sbom.txt` | SHA-256 на трите SBOM файла |
| `SHA256SUMS-sbom.txt.sigstore.json` | подпис (Sigstore bundle) върху `SHA256SUMS-sbom.txt` |

Подписът е **без таен ключ** (cosign keyless): сертификатът е краткотраен и се издава на
GitHub Actions работния процес `release-sbom.yml` чрез OIDC. Затова няма какво да се краде
или да изтече, а проверката доказва *кой процес* е подписал файла, не просто че го е
подписал „някой с ключа“. Записът е и в публичния дневник на Sigstore (Rekor).

Работният процес: `.github/workflows/release-sbom.yml` (стартира при публикуване на
издание и ръчно от Actions → Release SBOM → Run workflow, с таг). При ръчно пускане
тагът не е нужно да съществува в изходното хранилище: тогава SBOM се прави от избрания клон
(същия commit, от който ръчно пуснатите Windows и Linux сборки правят изданието).

> Подписват се SBOM файловете и сумите им. Инсталаторите на десктопа имат свои
> проверки (`SHA256SUMS-linux.txt`, Windows подпис): вижте `docs/SIGNING.md`.

---

## Как да проверите издание

Нужни са [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) v3 или
по-нов и `sha256sum` (Linux/macOS: `shasum -a 256`).

```bash
TAG=desktop-v0.7.0   # заменете с тага на изданието
gh release download "$TAG" --repo biramentv-ux/p2p-pure \
  --pattern '*.cdx.json' --pattern 'SHA256SUMS-sbom.txt*'

# 1. Подписът: файлът е подписан от нашия работен процес, не от друг.
cosign verify-blob \
  --bundle SHA256SUMS-sbom.txt.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/biramentv-ux/p2p-pure/\.github/workflows/release-sbom\.yml@refs/(tags/[^/]+|heads/main)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  SHA256SUMS-sbom.txt
# очаква се: "Verified OK"

# 2. Сумите: SBOM файловете съвпадат с подписания списък.
sha256sum --check SHA256SUMS-sbom.txt
```

Без `gh` свалете файловете ръчно от страницата на изданието. На Windows (PowerShell) за
втората стъпка: `Get-FileHash .\p2p-pure-*-web.cdx.json -Algorithm SHA256` и сравнете
с реда в `SHA256SUMS-sbom.txt`.

Ако първата команда даде грешка, **не** ползвайте файловете: или са променени след
публикуването, или не са подписани от нашия процес. Съобщете на адреса от `SECURITY.md`.

### Какво да правите със SBOM файловете

```bash
# Известни уязвимости в зависимостите (напр. с grype или osv-scanner):
grype sbom:p2p-pure-desktop-v0.7.0-web.cdx.json
osv-scanner --sbom p2p-pure-desktop-v0.7.0-web.cdx.json
```

---

## Възпроизводими компилации (уеб пакетът)

Скриптът `scripts/release/repro-check.sh` копира проследените файлове два пъти в различни
временни папки, прави `npm ci` и `npm run build` с фиксирани `SOURCE_DATE_EPOCH`
(времето на последния commit), `TZ=UTC`, `LC_ALL=C`, и сравнява SHA-256 на всеки файл в
`dist/`. Излиза с код 0 при идентични резултати, 1 при разлика (с списък на файловете).

```bash
scripts/release/repro-check.sh            # уеб (PWA) пакет
scripts/release/repro-check.sh --mode desktop   # пакетът за десктоп
```

**Резултат (Node 22.22.0, npm 10.9.4, Linux):** два независими билда са побайтово
идентични (100 файла). Същото важи и когато единият билд е с `TZ=Asia/Tokyo` и
`LC_ALL=en_US.UTF-8`, т.е. пакетът не зависи нито от часовата зона, нито от локала, нито от
пътя на папката. Не бяха намерени източници на недетерминизъм, затова не са правени
промени в `vite.config.ts`. `repro-check.sh` остава като защита срещу бъдещи регресии
(например нов плъгин, който вгражда дата).

Какво проверката **не** доказва:

- идентичност между различни версии на Node/npm: нужни са същите версии (в CI: Node 22);
- Rust/Tauri и Electron пакетите: те не се проверяват, а SBOM описва зависимостите им;
- че зависимостите в `package-lock.json` са добронамерени: за това са SBOM и `npm audit`.

## Как се генерират SBOM файловете локално

```bash
node scripts/release/sbom.mjs --out release-sbom --version dev --sums
# само част: --only web,electron   (rust иска: cargo install cargo-cyclonedx --version 0.5.9 --locked)
```

Инструментите са с фиксирани версии: `@cyclonedx/cyclonedx-npm` 6.0.1,
`cargo-cyclonedx` 0.5.9, cosign v3.1.4. npm SBOM файловете са без часови печат и случаен
сериен номер; Rust SBOM взима часовия печат от `SOURCE_DATE_EPOCH` (времето на commit-а).
Така от същите lock файлове се получават същите байтове.
Генерира се от lock файловете, без изпълнение на код от зависимостите.

## Ограничения

- Издание, създадено от друг работен процес със стандартния `GITHUB_TOKEN`, не стартира
  това събитие (правило на GitHub): пуснете процеса ръчно с тага.
- Пълната проверка изисква достъп до публичната инфраструктура на Sigstore (Fulcio/Rekor).
