# Android: F-Droid и ръчно инсталиране

Приложението е Capacitor обвивка около уеб версията (`dist/`). Идентификатор: `bg.p2pmessenger.app`.
Версията се пази на три места, които трябва да съвпадат (проверява ги `tests/mobile/fdroid.test.ts`):

| Къде | Пример |
|---|---|
| `package.json` `version` | `1.0.0` |
| `android/app/build.gradle` `versionName` | `1.0.0` |
| `android/app/build.gradle` `versionCode` | `10000` = major * 10000 + minor * 100 + patch |

Файлът `fastlane/metadata/android/<език>/changelogs/<versionCode>.txt` трябва да съществува за текущия `versionCode`.

## Инсталиране през F-Droid

Приложението още не е в основното хранилище (виж „Подаване“ по-долу). След приемането:

1. Инсталирай F-Droid от https://f-droid.org.
2. Потърси „P2P Messenger“ и натисни „Инсталирай“.
3. F-Droid сам събира APK от изходния код и го подписва със своя ключ. Обновленията идват през F-Droid.

## Инсталиране на ръка (sideload)

1. Свали `.apk` от „Releases“ в https://github.com/biramentv-ux/p2p-pure/releases.
2. Провери сумата, ако е публикувана (`sha256sum файл.apk`).
3. На телефона разреши инсталиране от непознати източници за браузъра или файловия мениджър.
4. Отвори `.apk` и потвърди.

Внимание: APK от GitHub и APK от F-Droid са подписани с различни ключове. Не могат да се обновяват един върху друг; трябва първо да се махне старата инсталация (това изтрива локалните данни, затова първо запиши 12-те думи за възстановяване).

## Сглобяване от изходния код

```bash
npm ci
npm run build
npx cap sync android
cd android
./gradlew assembleRelease --no-daemon --no-build-cache
```

Нужни са Node.js, JDK 21 и Android SDK 36. Подписването е отделно (виж `docs/SIGNING.md` и CI).

Настройки за възпроизводим билд: фиксирани `versionName`/`versionCode`, без кеш и без демон (`android/gradle.properties`). За F-Droid се изключва и блокът с метаданни за зависимости (`dependenciesInfo`), вижте `docs/fdroid/bg.p2pmessenger.app.yml`.

## Проверка за несвободен код

- Махнат е `com.google.gms:google-services` от `android/build.gradle`. Без `google-services.json` приставката така или иначе не се прилага.
- `androidx.credentials:credentials-play-services-auth` е собствена зависимост (Google Play Services). Тя е в `android/app/build.gradle` и се добавя от `scripts/mobile/sync-overlays.mjs`. Рецептата за F-Droid я маха при билд. Последствие: без Play Services passkey през Credential Manager работи само на Android 14+; на по-стари версии остава паролата.
- Няма Firebase, Google Analytics, Crashlytics, реклами или push през FCM.
- Мрежови услуги: `stun.l.google.com` (само STUN), Cloudflare Worker `tg.dyrakarmy.online` (кратки кодове и демо стая), GIPHY само ако билдът е със `VITE_GIPHY_API_KEY` (F-Droid билдът няма ключ). Затова в рецептата е отбелязано `NonFreeNet`.
- Лиценз: MIT. Зависимостите на уеб частта са MIT, ISC, BSD, Apache-2.0, MPL-2.0, OFL-1.1 (шрифтове IBM Plex), CC-BY-4.0 (caniuse-lite, само данни при билд). Всички са свободни.
- Нужно: подробният одит е в описанието на pull request-а.

## Подаване към F-Droid (fdroiddata)

1. Създай таг `android-v1.0.0` на коммита с версията (формат `android-v%v`, ползва се за автоматичните обновления).
2. Направи fork на https://gitlab.com/fdroid/fdroiddata.
3. Копирай `docs/fdroid/bg.p2pmessenger.app.yml` като `metadata/bg.p2pmessenger.app.yml`.
4. Пусни `fdroid lint bg.p2pmessenger.app` и `fdroid build -v -l bg.p2pmessenger.app`, коригирай (версия на Node.js, пътища).
5. Отвори merge request и следи коментарите на рецензентите.
