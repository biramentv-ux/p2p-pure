# P2P Secure Messenger

Личен, децентрализиран месинджър. Съобщенията се шифроват на устройството и се пращат директно между двама души през WebRTC. Няма централен сървър, който пази съобщения, акаунти или телефонни номера.

*Състояние към 21 октомври 2026: работеща PWA версия за уеб, Capacitor проект за Android и iOS, unit и e2e тестове. Native билдовете не са тествани на физически устройства.*

## Какво може приложението

- **Идентичност без регистрация.** Създава се passkey на устройството. От него се извежда `did:key` (`z6Mk…`), който е публичният ти адрес. Няма имейл, няма телефон, няма SMS.
- **Възстановяване с 12 думи (BIP39).** Записваш ги веднъж и ги ползваш, ако смениш устройство.
- **Добавяне на контакт с QR код или кратък код.** Покана се пази в Cloudflare Worker за около 10 минути и се взима еднократно. Кратките кодове са 10 символа без двусмислени знаци.
- **Проверка на събеседника.** И двамата виждат един и същ код от 6 думи, изведен от двата публични ключа. Сравнявате го извън приложението и едва тогава контактът става потвърден.
- **Шифровани чатове.** Съобщенията минават през сесия с Double Ratchet подход. Историята се пази в IndexedDB, шифрована с AES-GCM.
- **Снимки, точна локация и изтриване на чат** от двете страни.
- **Аудио и видео разговори** през WebRTC. Медията е DTLS-SRTP.

## Ограничения, които приемаме

- Използваме само публични STUN сървъри (`stun.l.google.com`). TURN релей не се ползва, затова някои мрежи (строги NAT или корпоративни firewall-и) няма да се свържат.
- Сигналният Worker (`p2p-telegram-signal`) е единственият сървър. Той пази само временни покани и обработва webhook-а на Telegram бота. Съобщения не минават през него.
- Ако събеседникът е офлайн, изтриването на чат не стига до него. Няма сървър, който да пази историята.

## Структура

```
src/
  identity/         passkey, did:key, BIP39
  p2p/              WebRTC канал, сесия, снимки, управляващи съобщения
  call/             сигнализация и контролер за разговори
  history/          шифрована история (IndexedDB)
  contacts/         контакти и потвърждение
  platform/mobile/  Capacitor мост и passkey през Android Credential Manager
  ui/               екрани и компоненти (ConnectScreen, ChatScreen, CallPanel…)
  App.css, index.css  дизайн система (токени, светла и тъмна тема)
worker/             Cloudflare Worker: покани, Telegram webhook, cron
native-overlays/    Java код за Android (PasskeyBridge) и настройки
scripts/mobile/     синхронизация на overlay файлове и проверка за готовност
tests/              unit (Vitest), mock Worker, e2e (Playwright + Chromium)
```

## Инсталация и локално стартиране

Нужни са Node.js LTS и npm.

```bash
npm ci
npm run dev            # разработка на http://localhost:5173
```

За production билд и локален статичен сървър:

```bash
npm run build          # tsc + vite build; генерира PWA service worker
npx vite preview --host 127.0.0.1 --port 4173
```

Адресът на сигналния Worker е по подразбиране `https://tg.dyrakarmy.online`. Можете да го промените при билд с `VITE_INVITE_API`.

## Тестове

| Команда | Какво проверява |
|---|---|
| `npm test` | Unit тестове (Vitest, 24 файла, 226 теста, fake-indexeddb) |
| `npm run lint` | oxlint |
| `npm run test:mock` | API тестове срещу mock Worker (51 проверки) |
| `npm run test:mock-ui` | Ръкостискане с кратък код между две страници (9 проверки) |
| `npm run test:chat` | Локация, отказан достъп до локация, изтриване на чат (11 проверки) |
| `npm run test:call` | Аудио и видео разговор между две браузърни сесии (13 проверки) |
| `npm run test:mobile` | Проверка на overlay файловете и rpId за native среда |
| `npm run mobile:check` | Готовност на Android и iOS проектите (плейсхолдъри, синхронизация) |

e2e тестовете използват системен Chromium (`/opt/pw-browsers/…`) и фалшиви камера и микрофон. Тестът `tests/e2e/ui.mjs` е нестабилен и не се пуска с retry.

## Мобилни приложения (Capacitor 8)

- `appId`: `bg.p2pmessenger.app`
- Android passkey: `PasskeyBridgePlugin.java` ползва Credential Manager. `rpId` трябва да се подаде през `VITE_PASSKEY_RP_ID`, защото WebView има origin `localhost`.
- Разрешения: камера, микрофон, точна локация (Android manifest и iOS `Info.plist` се генерират от `npm run mobile:sync`).

```bash
npm run build
npx cap add android    # или ios, веднъж
npm run mobile:sync
npx cap sync
npx cap open android   # или ios
```

**Какво още трябва да се направи за публикуване:** да се замени SHA-256 отпечатъкът в `assetlinks.json` и Apple Team ID в AASA файла. Да се тестват разрешенията за камера, микрофон и локация на реални устройства, защото navigator.geolocation във WebView може да не показва prompt.

**Ограничение на средата за разработка:** Android SDK и Xcode не са инсталирани в средата, в която се прави разработката. Native билдовете са непроверени.

## Дизайн

Дизайн системата е описана в `docs/design-handoff.md`. Накратко:

- Тъмна и светла тема, цветовете са CSS токени в `src/index.css`.
- Шрифтове: Fraunces (заглавия), Instrument Sans (текст), JetBrains Mono (кодове). Зареждат се от приложението, без Google.
- Илюстрациите са inline SVG и се пускат без мрежа. Аватарите се генерират от DID.
- Анимациите спазват `prefers-reduced-motion`.

## CI

Workflow-ът `Java CI with Gradle` (`.github/workflows/gradle.yml`) вече ползва `android/` като корен на Gradle проекта (PR #9). Резултатът от билда още не е потвърден в CI.

## Сигурност

Виж `SECURITY.md`. Подозрителна уязвимост съобщавайте на собственика на репото, не публично в issue.

## Лиценз

Виж `LICENSE`.
