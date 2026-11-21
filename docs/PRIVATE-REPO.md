# Частен код, публични издания

> **От 21 ноември 2026 репото с кода е публично.** Описаното по-долу остава като справка, ако
> някога пак трябва да е частно. Изданията и сайтът продължават да се публикуват в `p2p-pure-releases`.

Целта: **кодът е скрит**, а изданията (инсталатори, APK), сайтът и приложението на `dyrakarmy.online`
остават публични и работят както досега. По подразбиране нищо не се променя: всичко по-долу се
включва само когато зададеш променливите.

```
частно репо (код, CI)  ──билдва──▶  публично репо "p2p-pure-releases"
                                       ├─ Releases: .exe, .deb, .rpm, .AppImage, .flatpak, .apk, SHA256SUMS
                                       └─ gh-pages: сайтът + приложението (dyrakarmy.online)
```

## Всичко с един скрипт

```
powershell -ExecutionPolicy Bypass -File scripts\windows\go-private.ps1
```

Минава стъпки 1 до 6 по-долу (репо, токен, променливи, сайт, домейн, ново издание `desktop-v<версията в main>`, проверка)
и накрая пита дали да направи репото private (пишеш `PRIVATE`). Може да се пуска пак; `-From 5` започва
от стъпка 5, `-SkipDomain` оставя сайта на github.io. Токенът се въвежда скрито и не се пази никъде.
Основното репо остава публично до последния въпрос.

Ако нещо спре по средата, една команда продължава оттам (сама намира докъде си стигнал и коя версия
е в main):

```
git pull; powershell -ExecutionPolicy Bypass -File scripts\windows\continue-private.ps1
```

## Настройка на ръка (веднъж)

1. Създай **публично** празно репо, напр. `biramentv-ux/p2p-pure-releases` (без код в него).
2. Направи **fine-grained token** само за него: *Contents: Read and write* (и *Pages: Read and write*, ако ползваш домейна).
   Не го пращай никъде освен в тайната по-долу.
3. В **частното** репо: Settings → Secrets and variables → Actions
   - Secret `RELEASES_TOKEN` = токенът;
   - Variables: `RELEASES_REPO` = `biramentv-ux/p2p-pure-releases`, `SOURCE_CLOSED` = `1`,
     `PAGES_PUBLISH_REPO` = `biramentv-ux/p2p-pure-releases`, по желание `PAGES_DOMAIN` = `dyrakarmy.online`.
4. В публичното репо: Settings → Pages → Source: *Deploy from a branch* → `gh-pages` / root.
5. Домейнът: `scripts\windows\point-domain-to-pages.ps1 -PagesRepo biramentv-ux/p2p-pure-releases`.
   Без домейн задай `PAGES_BASE` = `/p2p-pure-releases/`.
6. Чак тогава направи изходното репо private.

## Какво се променя

| Какво | Как работи |
|---|---|
| Издания Windows / Linux / Android | създават се в `RELEASES_REPO` (чернова → качване → публикуване), без `--target` (комит от частното репо не съществува там) |
| Сайт и бутони за сваляне | събират се в частното репо, публикуват се като един комит в `gh-pages` на публичното |
| `install.sh`, winget | сочат към публичното репо (`P2P_REPO`, `RELEASES_REPO`) |
| Текстове на сайта | `SOURCE_CLOSED=1` маха „отворен код“ (и в лентата с факти; проверката не гледа главни/малки букви) и връзките към файлове, които са само в частното репо. Долу на страницата „Сигурност“ и „Лиценз“ сочат към публичните копия |
| Ръководства, лиценз, сигурност | `public-docs.yml` копира `LICENSE`, `LICENSE.bg.md`, `SECURITY.md`, `SECURITY.bg.md`, `docs/WINDOWS.md`, `docs/LINUX.md`, `docs/SIGNING.md` и `docs/public/README.md` (като README) в публичното репо, и поправя бележките на старите издания. `desktop-release.sh` насочва връзките в новите бележки към публичните копия |
| SBOM | **Release SBOM** тръгва от тага `desktop-v*` като Windows и Linux и качва в същата чернова; изданието се публикува, когато и трите са там. Подписът остава на workflow-а в частното репо |

## Какво спира да работи (честно)

- **F-Droid и Flathub** строят от публичен изходен код: не са възможни.
- **winget** приема манифест, но Microsoft може да поиска достъп до кода за проверка.
- Твърдението „повторими билдове, може да ги провериш“ вече не може да се провери от външен човек.
- Ако токенът изтече, изданията и сайтът спират да се публикуват (старите остават).

## Връщане

Изтрий променливите `RELEASES_REPO`, `SOURCE_CLOSED`, `PAGES_PUBLISH_REPO` и направи репото публично.
