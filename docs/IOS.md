# iOS: от код до TestFlight и App Store

Приложението е същият React код, опакован с Capacitor (`ios/`). Билдът се прави на macOS машина в
GitHub Actions (`.github/workflows/ios-testflight.yml`): тази среда е Linux и не може да компилира за iOS.

**Състояние:** проектът и workflow-ът са написани, но **не са пускани** с Apple акаунт и не са пробвани
на iPhone. Първото пускане най-вероятно ще иска по една-две поправки.

## Какво прави workflow-ът

| Случай | Резултат |
|---|---|
| PR, който пипа `ios/`, `capacitor.config.ts` или workflow-а | само проверка, че проектът се компилира (без подпис, без Apple секрети) |
| Без секретите по-долу | същото: само компилация |
| Таг `ios-v1.2.3` или ръчно пускане, със секретите | архивира, подписва в облака и качва в TestFlight |

Версията е от тага (`ios-v1.2.3` → 1.2.3), иначе от `package.json`. Номерът на билда е номерът на
пускането, така че всяко качване е по-ново от предишното (App Store Connect го изисква).

## Какво ти трябва (веднъж)

1. **Apple Developer Program** (99 USD/година), на твое име или на фирма.
2. В App Store Connect → Apps → нов app с bundle id `bg.p2pmessenger.app` (същият като в `capacitor.config.ts`).
3. **API ключ:** App Store Connect → Users and Access → Integrations → App Store Connect API → нов ключ с роля *App Manager*.
   Свали `.p8` файла (дава се само веднъж). Запиши Key ID и Issuer ID.
4. В GitHub (Settings → Secrets and variables → Actions) на репото, което пуска workflow-а:
   - Secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64` (`base64 -w0 AuthKey_XXXX.p8`).
     **Тях ги задаваш ти; не ги пращай никъде другаде.**
   - Variable: `APPLE_TEAM_ID` (10 знака, Membership details).
5. **Passkey:** променливата `APPLE_TEAM_ID` се слага и във файла
   `https://dyrakarmy.online/.well-known/apple-app-site-association` при следващото публикуване на сайта.
   Проверка: `curl -sI https://dyrakarmy.online/.well-known/apple-app-site-association` → `200`, `application/json`.
6. Пусни **iOS** от Actions (или `git tag ios-v1.0.0 && git push origin ios-v1.0.0`).
   След 10–30 минути билдът се появява в TestFlight.

Сертификат и профил не се пазят като секрети: `xcodebuild -allowProvisioningUpdates` с API ключа ги
създава и подновява сам. Entitlement-ът `webcredentials:dyrakarmy.online` е в `ios/App/App/App.entitlements`.

Ако репото е частно, macOS минутите се броят с множител 10. Това е причина да се пуска само при таг.

## Преди първото изпращане за ревю (App Store)

- **Износ на шифроване.** Приложението използва криптография (Double Ratchet, AES, ECDH). App Store Connect ще
  попита за износ. Ключът `ITSAppUsesNonExemptEncryption` умишлено не е зададен, за да отговориш ти (в САЩ и ЕС
  месинджърите с E2EE обикновено попадат в самооценка/документи; провери с юрист или Apple документацията).
- **Правило 4.2 (минимална функционалност).** Само WebView обвивка често се връща. Опиши какво е различно от
  уеб версията (камера за QR, passkey в Keychain, споделяне).
- **Поверителност.** Попълни „App Privacy“: приложението не събира данни за теб, няма акаунт и сървър за съобщения.
  Нужна е връзка към политика за поверителност.
- Снимки на екрана за 6.7" и 6.1" (и iPad, ако `TARGETED_DEVICE_FAMILY` остава `1,2`), описание, възрастова оценка.
- **Разрешения** в `Info.plist` са на български: камера (QR), микрофон, локация. Ревюто гледа дали
  всяко се ползва реално; махни тези, които функциите още не ползват.

## Не е проверено

Нищо от този документ не е изпълнявано на Mac или с Apple акаунт: подписването през API ключ, качването,
Associated Domains на устройство, камерата в WKWebView. Пробвай първо TestFlight на реален iPhone.
