# Ферма от телефони (Н8)

3–5 употребявани телефона на бюрото, без облак. Препоръчан набор: Android 10, 14 и 16 и iPhone с
iOS 18 и 26. Всеки телефон е в своя мрежа: домашен Wi-Fi, мобилни данни от двама оператори,
мобилни данни само с IPv6, мрежа за гости.

## Подготовка (веднъж)

1. Android: включи **Developer options → USB debugging**, свържи по USB и потвърди ключа.
   `adb devices` трябва да показва `device`.
2. iPhone (на Mac с Xcode 15+): **Settings → Privacy & Security → Developer Mode**, свържи и
   довери се на компютъра. `xcrun devicectl list devices` трябва да го показва.
3. Копирай `scripts/devicefarm/farm.example.json` като `farm.json` и впиши серийните номера и UDID.
   `node scripts/devicefarm/farm.mjs list` ги показва. `farm.json` не се качва в git.

## Билд за фермата

Автоматичният път иска debug билд, направен с `VITE_NATLAB=1`. Той отваря WebView за
DevTools и дава на теста декодера на собствения QR. Издание не става така.

```
VITE_NATLAB=1 npm run build && npx cap sync android && (cd android && ./gradlew assembleDebug)
```

## Пускане

```
node scripts/devicefarm/farm.mjs install --apk android/app/build/outputs/apk/debug/app-debug.apk --ios-app build/App.app
node scripts/devicefarm/farm.mjs run                  # двойки Android телефони по реда във farm.json
node scripts/devicefarm/farm.mjs run --pair android10,android16
node scripts/devicefarm/farm.mjs run --dry-run        # само показва командите
```

`run` изчиства данните на приложението (`pm clear`), пуска го и влиза в WebView-то му през
`adb forward` и Chrome DevTools. После минава през същите стъпки като NAT лабораторията
(`scripts/natlab/steps.mjs`): профил, покана, отговор, 12 думи и съобщение в двете посоки, по
истинските мрежи на телефоните. Резултатът е в `devicefarm-report.json`.

**iPhone**: WebKit няма Chrome DevTools протокол, затова там скриптът само инсталира и пуска приложението.
Проверката е ръчният чеклист ([RELEASE-CHECKLIST-RADIO.md](RELEASE-CHECKLIST-RADIO.md)), а
отчетът го записва като „ръчно“.

## Какво не е проверено тук

Скриптът е тестван без телефони: разбор на `adb`/`devicectl`, командите и примерната конфигурация
(`tests/natlab/devicefarm.test.ts`). Пускането върху истински телефони става на твоето бюро.
