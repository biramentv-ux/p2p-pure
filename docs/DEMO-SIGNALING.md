# Демо сигнализация (WebSocket стая) — публикуване

Демо режимът използва стая на сигналния Worker: единият устройство отваря стая и показва
10-символен код, другият се присъединява с него. Worker-ът пренася кадрите между двамата и
не ги чете. Подписаната покана се проверява на клиента. Локалният режим (QR) не се променя и
не изисква Worker.

Поверителност: кадрите минават само през паметта на Durable Object (не се записват; стаята се затваря след 10 минути). Worker-ът не пише логове: `observability` е изключено във `worker/wrangler.jsonc` и в кода няма `console`. Не го включвай, защото адресите на заявките съдържат кода на стаята. Cloudflare като платформа все пак вижда IP адреси, адреси на заявките и кадрите в явен вид, докато минават през Worker-а. Пълна таблица: [SECURITY.md](../SECURITY.md).

## Какво трябва да е публикувано

| Част | Файл | Бележка |
|---|---|---|
| Relay логика | `worker/room.ts` | Две страни на стая, 16 KB на кадър, 10 минути живот |
| Durable Object | `worker/index.ts` (`SignalRoom`) | Приема WebSocket и пренася кадрите |
| Маршрути | `worker/index.ts` | `POST /ws/rooms` и `GET /ws/rooms/:code` (upgrade) |
| Миграция и binding | `worker/wrangler.jsonc` | `durable_objects` и `migrations` (`v1`, `SignalRoom`) |
| CSP | `vite.config.ts` | `connect-src` позволява `wss://` към същия хост |

## Публикуване от GitHub (препоръчително, без твоя компютър)

Workflow-ът `.github/workflows/worker-deploy.yml` (**Actions → Signalling Worker**) пуска
тестовете на Worker-а, публикува го в Cloudflare и проверява, че `POST /ws/rooms` връща код.
Пуска се сам при промяна в `worker/` на `main`, или ръчно с **Run workflow**.

Еднократна настройка:

1. Cloudflare → **My Profile → API Tokens → Create Token → шаблон „Edit Cloudflare Workers“**.
   Ограничи го до акаунта си и зоната `dyrakarmy.online`. Копирай токена веднъж, директно в
   GitHub. Не го поставяй в чат или файл.
2. Cloudflare → **Workers & Pages → Overview**: копирай **Account ID** от дясната колона.
3. GitHub → **Settings → Secrets and variables → Actions → New repository secret**:
   `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`.
4. **Actions → Signalling Worker → Run workflow**. Зелено и бележка `demo-room` = готово.

Без двата секрета workflow-ът само пуска тестовете и пише предупреждение.

## Публикуване от твоя компютър (алтернатива)

Нужни са: акаунт в Cloudflare с достъп до зоната `dyrakarmy.online`, и вече зададените
секрети `TELEGRAM_BOT_TOKEN` и `TELEGRAM_WEBHOOK_SECRET`. Те не се променят.

```bash
cd worker
npx wrangler login          # еднократно, отваря браузър
npx wrangler deploy         # качва Worker-а и прилага миграцията за SignalRoom
```

След деплоя:

1. Провери, че Worker-ът отговаря: `curl -s https://tg.dyrakarmy.online/` трябва да върне `ok`.
2. Провери стаята:
   ```bash
   curl -s -X POST https://tg.dyrakarmy.online/ws/rooms
   # {"code":"XXXXXXXXXX","ttlSec":600}
   ```
   Без upgrade заглавие `GET /ws/rooms/<код>` връща `426`. Това е очаквано.
3. Публикувай фронтенда (същият билд, който съдържа новия CSP), иначе WebSocket ще е блокиран.

## Ако деплоят се провали

- `durable_objects` грешка: провери, че `class_name` е `SignalRoom` и че миграцията `v1` е в конфигурацията.
- Грешка `10097` („In order to use Durable Objects with a free plan…“): миграцията трябва да е
  `new_sqlite_classes`, не `new_classes`. Така е в `worker/wrangler.jsonc`; безплатният план работи.
- Ако Worker-ът е публикуван без миграцията, `POST /ws/rooms` ще върне `201`, но `GET` ще
  върне `503`, защото binding-ът `SIGNAL_ROOM` липсва.

## Проверка преди публикуване

```bash
npm run test:demo           # два браузъра през локален relay, пълна стая, шифрован обмен
npx vitest run worker tests/worker tests/signaling
```

`test:demo` използва локален relay (`tests/e2e/demoRelay.mjs`), който ползва същите
`worker/room.ts` и `worker/logic.ts`. Той не замества реалния Cloudflare Worker.

## Известни ограничения

- Стаите са в паметта на Durable Object-а. Ако обектът се презапусне, активната стая се губи.
- Кодът на стаята е единственият ключ за присъединяване. Кой го познава, може да се опита
  да влезе. Поканата е подписана, така че подменен отговор се отхвърля, но сървърът
  вижда кадрите (те са публични покани, не съобщения).
- Превключвателят Демо/Локален е в интерфейса; по подразбиране е локален.
