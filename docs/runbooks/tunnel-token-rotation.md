# Ротация на токена за Cloudflare Tunnel

Сайтът `dyrakarmy.online` се обслужва от компютъра на собственика (Windows):

```
браузър → Cloudflare → тунел (услуга Cloudflared) → http://127.0.0.1:4173 (задача p2p-preview, vite preview) → dist\
```

Токенът на тунела е единственото, което дава право на машина да обслужва адреса. **Който има токена, може да пусне тунела от своя машина и да подменя сайта.** Затова токенът се ротира:

- веднага, ако е изтекъл (чат, скрийншот, файл, споделен екран, лог);
- планово, например веднъж на 6 месеца;
- при смяна или преинсталация на компютъра.

Ротацията не пипа DNS, hostname-а и правилата на тунела. Сменя се само тайната. Прекъсването е няколко секунди, докато услугата се рестартира.

> Никога не поставяй токена в чат, issue, commit, бележка или терминал, който се записва. Където трябва да се пише токен в команда, използвай `<ТОКЕН>`. `node scripts/security/scan-secrets.mjs` търси токени във файловете на репото и се пуска във Web CI.

## Как е устроено при нас

| Част | Какво прави | Пипа ли токена |
|---|---|---|
| `scripts/windows/install-tunnel.ps1` | Пита за токена със скрит вход, преинсталира услугата `Cloudflared` с него, пуска `p2p-preview` и проверява локалния и публичния адрес. Ако услугата вече съществува, първо я спира и деинсталира, така че нов токен влиза в сила. | Да. Единственото място. |
| `scripts/windows/deploy.ps1` | Дърпа `main`, тества, билдва `dist\` и рестартира `p2p-preview`. | Не. Не рестартира и тунела. |
| `scripts/windows/register-preview-task.ps1` | Регистрира задачата `p2p-preview` на порт 4173. | Не. |

**Къде е записан токенът.** Зависи от версията на cloudflared, с която е инсталирана услугата:

| cloudflared | Къде отива токенът от `service install <ТОКЕН>` | Кой може да го прочете |
|---|---|---|
| **2026.7.3 и по-нова** | Файл `%ProgramData%\cloudflared\token`. Услугата се стартира с `tunnel run --token-file C:\ProgramData\cloudflared\token`. | Само Administrators и SYSTEM |
| по-стара | Стартовата команда на услугата: `HKLM\SYSTEM\CurrentControlSet\Services\Cloudflared`, стойност `ImagePath` (`... tunnel run --token ...`) | Всеки локален потребител (`sc qc Cloudflared`) |

`install-tunnel.ps1` предупреждава, ако cloudflared е по-стар от 2026.7.3. `cloudflared service uninstall` изтрива файла `token`, така че при преинсталиране старият токен не остава на диска. В репото, в `%USERPROFILE%\.cloudflared` и в историята на PowerShell няма копие, ако се ползва скриптът.

Затова:

- „обнови записания токен“ = пусни отново `install-tunnel.ps1` с новия токен. Не редактирай файла `token` или `ImagePath` на ръка;
- не показвай `sc qc Cloudflared`, ключа в regedit или файла `token` при споделяне на екрана: при старите версии `sc qc` показва токена в чист текст.

Проверка как е инсталирана услугата, без да се показва токенът:

```powershell
(Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Services\Cloudflared).ImagePath -match '--token-file'
# True  = токенът е в защитения файл
# False = токенът е в командния ред: обнови cloudflared и пусни install-tunnel.ps1 отново
```

Резервно копие на токена дръж само в диспечер на пароли. Не е задължително: при нужда винаги може да се генерира нов.

## Преди да започнеш

- [ ] Достъп до Cloudflare таблото на акаунта на `dyrakarmy.online` (Zero Trust).
- [ ] PowerShell **като администратор** в папката на проекта.
- [ ] `cloudflared --version` показва **2026.7.3 или по-нова**. Ако не, обнови първо: `winget upgrade Cloudflare.cloudflared`.
- [ ] Има `dist\index.html` (ако няма: `npm ci; npm run build`, или пусни `deploy.ps1`).
- [ ] Знаеш името на тунела (в таблото: **Networks → Tunnels**). Тунелът е *remotely-managed* (създаден от таблото и пуснат с токен).

## Стъпка 1. Нов токен

### Вариант А: от таблото (препоръчва се)

1. Отвори [Cloudflare One](https://one.dash.cloudflare.com/) → **Networks → Tunnels** → избери тунела.
2. В раздела **Overview** натисни **Refresh token** (на някои места бутонът е **Rotate token**).
3. Натисни **Add a replica** и копирай показаната команда в нов празен Notepad, **без да я пускаш**.
4. От командата вземи само токена: дългия низ, който започва с `eyJ`. Копирай го в клипборда и затвори Notepad **без запис**.

Какво става веднага след това: старият токен вече не може да отваря **нови** връзки. Връзката, която работи в момента, остава. Сайтът продължава да отговаря, докато не рестартираш услугата. Затова стъпка 2 може да се направи спокойно веднага след това.

### Вариант Б: през API (без копиране от браузъра)

Нужен е API токен на Cloudflare с едно от правата **Cloudflare Tunnel Write** / **Cloudflare One Connector: cloudflared Write**, и ID-тата на акаунта и тунела (от таблото). API токенът също е тайна: въвежда се скрито и се изтрива след това.

```powershell
$acc = "<ACCOUNT_ID>"; $tid = "<TUNNEL_ID>"
$api = Read-Host "Cloudflare API токен" -AsSecureString | ForEach-Object { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($_)) }
$h = @{ Authorization = "Bearer $api" }
$base = "https://api.cloudflare.com/client/v4/accounts/$acc/cfd_tunnel/$tid"

# Нова тайна на тунела: 32 случайни байта (криптографски генератор), base64.
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$body = @{ tunnel_secret = [Convert]::ToBase64String($bytes) } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri $base -Headers $h -ContentType "application/json" -Body $body | Out-Null

# Новият токен отива направо в клипборда, без да се показва на екрана.
(Invoke-RestMethod -Uri "$base/token" -Headers $h).result | Set-Clipboard
$api = $null; $h = $null; $bytes = $null; $body = $null
```

### За `cloudflared tunnel token`

`cloudflared tunnel token <ИМЕ>` само **показва** текущия токен. Не го сменя. Работи, ако на машината има `cert.pem` от `cloudflared tunnel login`, а ние не ползваме такъв. За ротация използвай вариант А или Б.

## Стъпка 2. Сложи новия токен в услугата

В PowerShell като администратор, в папката на проекта:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-tunnel.ps1
```

1. На въпроса `Tunnel token (въведете скрито)` постави токена (десен бутон или Ctrl+V) и натисни Enter. Нищо не се показва. Това е нормално.
2. Скриптът спира и деинсталира старата услуга, инсталира я с новия токен, пуска `p2p-preview` и проверява адресите.
3. Изчисти клипборда:

```powershell
Set-Clipboard -Value " "
```

Ако скриптът каже `cloudflared не прие токена`, значи е поставено нещо повече от токена (цялата команда, интервал, кавички). Пусни скрипта отново и постави само низа `eyJ...`.

## Стъпка 3. Рестарт и проверка

Скриптът вече рестартира услугата. Провери:

```powershell
Get-Service Cloudflared                                    # Status: Running
(Invoke-WebRequest http://127.0.0.1:4173 -UseBasicParsing).StatusCode   # 200
(Invoke-WebRequest https://dyrakarmy.online -UseBasicParsing).StatusCode # 200
```

В таблото: **Networks → Tunnels** → тунелът е **Healthy**, а в **Connectors** има един конектор от този компютър с ново време на свързване.

Това е и доказателството, че ротацията е минала: след Refresh token старият токен не може да отвори нова връзка. Щом услугата се е рестартирала и тунелът е Healthy, тя работи с новия токен.

Ако услугата е `Running`, но сайтът не отговаря:

| Признак | Вероятна причина | Какво да направиш |
|---|---|---|
| Локално не отговаря на 4173 | Не върви `p2p-preview` | `scripts\windows\deploy.ps1` или `Start-ScheduledTask p2p-preview`; виж `preview.log` |
| Локално 200, публично грешка 1033 | Тунелът не е свързан | `Restart-Service Cloudflared`, изчакай 30 секунди. Ако пак не става, пусни `install-tunnel.ps1` отново. |
| Публично 502 | Тунелът е свързан, но не стига до 127.0.0.1:4173 | Провери `p2p-preview` и hostname-а в таблото (`http://localhost:4173`) |
| Услугата спира веднага | Грешен или стар токен | Повтори стъпка 1 и стъпка 2 |

## Стъпка 4. Старият токен

Самото **Refresh token** прави стария токен невалиден за нови връзки. Остава да се прекъснат връзките, които вече са отворени със стария токен.

- **Планова ротация** (няма съмнение за изтичане): нашата услуга вече е рестартирана в стъпка 2. Други машини няма. Нищо повече не е нужно.
- **Съмнение за изтичане**: прекъсни **всички** връзки на тунела, после рестартирай своята услуга, за да се свърже наново с новия токен:

```powershell
# $h и $base както във вариант Б (въведи API токена скрито отново)
Invoke-RestMethod -Method Delete -Uri "$base/connections" -Headers $h | Out-Null
Restart-Service Cloudflared
```

  След минута в **Connectors** трябва да има само един конектор: твоят компютър. Ако има друг, токенът е бил използван. Виж следващия раздел.

- Изтрий всяко копие на стария токен: бележки, файлове, стари записи в диспечера на пароли, изтеглени логове.

## Ако токенът е изтекъл

Действай веднага, в този ред:

1. **Стъпка 1** (Refresh token). Това спира новите връзки със стария токен.
2. **Стъпка 4, вариантът при изтичане**: прекъсни всички връзки (`DELETE .../connections`).
3. **Стъпка 2 и 3**: новият токен в услугата, проверка, само един конектор.
4. Провери за следи от злоупотреба за времето от изтичането досега:
   - **Connectors** на тунела: непознати IP адреси, OS или версии.
   - **Audit logs** на акаунта (Manage Account → Audit Log): нови тунели, промени по public hostname-и, DNS записи за `dyrakarmy.online`, нови API токени.
   - DNS записът на `dyrakarmy.online` още сочи към нашия тунел (`<TUNNEL_ID>.cfargotunnel.com`).
5. Ако има непознат конектор или промяна, която не си правил: смени паролата на Cloudflare акаунта, включи 2FA, отмени (Roll/Delete) всички API токени. При съмнение изтрий тунела и създай нов с hostname `dyrakarmy.online` → `http://localhost:4173`, после стъпка 2 с неговия токен.
6. Запиши случилото се в `docs/incidents/` (виж `2026-10-tunnel-token-exposed.md` за формат). **Без самия токен.**

Изтриване на тунела и създаване на нов също върши работа като ротация, но сменя ID-то на тунела и DNS записа. Refresh token е по-лекият път и стига, ако акаунтът не е компрометиран.

## Бърз списък

1. Таблото → Tunnels → тунелът → **Refresh token** → **Add a replica** → копирай само `eyJ...`.
2. PowerShell като администратор: `scripts\windows\install-tunnel.ps1` → постави токена скрито.
3. `Set-Clipboard -Value " "`.
4. `Get-Service Cloudflared` = Running; локално и публично 200; в таблото Healthy и един конектор.
5. При изтичане: `DELETE .../connections`, `Restart-Service Cloudflared`, провери Audit logs.

## Източници

- Cloudflare: [Tunnel tokens](https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/): получаване, ротация, ротация при компрометиран токен
- Cloudflare: [Tunnel permissions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/): Refresh token, API (`PATCH tunnel_secret`, `GET .../token`, `DELETE .../connections`)
- Cloudflare: [Run parameters](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/): `--token`, `--token-file`
- cloudflared: [RELEASE_NOTES](https://github.com/cloudflare/cloudflared/blob/master/RELEASE_NOTES), 2026.7.3 „Windows svc: use --token-file instead of --token“; [windows_service.go](https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/windows_service.go): файлът `%ProgramData%\cloudflared\token` и правата му
