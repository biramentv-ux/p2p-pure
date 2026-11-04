# P2P Messenger

<a href="assets/promo-bg.mp4"><img src="assets/promo-bg.gif" alt="Промо видео: P2P Messenger и шестте начина за свързване (43 секунди)" width="49%"></a>
<a href="assets/promo-en.mp4"><img src="assets/promo-en.gif" alt="Promo video: P2P Messenger and the six ways to connect (43 seconds)" width="49%"></a>

▶️ Видео със звук: [български](assets/promo-bg.mp4) · [English](assets/promo-en.mp4)

Месинджър без телефонен номер, без акаунт и без сървър по средата. Съобщенията, файловете и
разговорите вървят директно между устройствата, шифровани от край до край.

**Сайт и приложение в браузъра:** https://dyrakarmy.online/ · **Изтегляне:** [Издания](../../releases)

Тук са изданията (Windows, Linux, Android) и сайтът. Изходният код е частен; всяко издание има
контролни суми SHA-256 и подписан SBOM.

**Какво може:** профил без телефон и имейл (passkey или парола), 12 думи за възстановяване, контакт с
QR или отдалеч с код от 5 знака и 3 думи (думите не стигат до сървъра), 12 думи за проверка срещу човек по средата, шифрован чат, файлове до 100 MB, аудио
и видео разговори, групи до 9 души, известия и звуци, местене на нов телефон. Приложението е на
6 езика (български, English, Русский, Deutsch, Español, Português), сайтът е на 8.

**Шест начина за първа връзка:** QR лице в лице (без сървър); кратък код от 5 знака и 3 думи (PAKE, сървърът вижда само номера на стаята и шифрован текст); Bluetooth (само в приложението за Android и iOS); QR + звук; запознаване чрез общ приятел (без сървър); Telegram бот или копиране на поканата. След всеки начин двамата сравняват 12 думи за проверка.

| | Български | English |
|---|---|---|
| Сигурност и поверителност | [SECURITY.bg.md](SECURITY.bg.md) | [SECURITY.md](SECURITY.md) |
| Лиценз (MIT) | [LICENSE.bg.md](LICENSE.bg.md) (превод) | [LICENSE](LICENSE) |
| Windows | [docs/WINDOWS.md](docs/WINDOWS.md) | |
| Linux | [docs/LINUX.md](docs/LINUX.md) | |
| Подписи и проверка | [docs/SIGNING.md](docs/SIGNING.md) | |

---

A messenger with no phone number, no account and no server in the middle. Messages, files and calls
go straight between devices, end-to-end encrypted.

**Website and browser app:** https://dyrakarmy.online/en/ · **Download:** [Releases](../../releases)

This repository holds the releases (Windows, Linux, Android) and the website. The source code is
private; every release ships SHA-256 checksums and a signed SBOM. The encryption has not had an
independent audit yet.

**What it does:** a profile with no phone or email (passkey or password), 12 recovery words, contacts by
QR or, from afar, a code of 5 characters and 3 words (the words never reach the server), 12 words to rule out anyone in the middle, encrypted chat, files up to 100 MB, audio and
video calls, groups of up to 9, notifications and sounds, moving to a new phone. The app speaks
6 languages (Bulgarian, English, Russian, German, Spanish, Portuguese); the site speaks 8.

**Six ways to make the first connection:** QR face to face (no server); a short code of 5 characters and 3 words (PAKE, the server sees only the room id and ciphertext); Bluetooth (Android and iOS app only); QR + sound; introduction by a mutual friend (no server); Telegram bot or copying the invitation. After any of them, both sides compare 12 verification words.

Issues and questions: [Issues](../../issues). Security problems: please report them privately
(Security → Report a vulnerability), not in a public issue.

<!-- Copied from docs/public/README.md in the source repository by .github/workflows/public-docs.yml. Edit it there. -->
