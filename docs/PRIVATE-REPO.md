# Частен код, публични издания

Целта: **кодът е скрит**, а изданията (инсталатори, APK), сайтът и приложението на `dyrakarmy.online`
остават публични и работят както досега. По подразбиране нищо не се променя: всичко по-долу се
включва само когато зададеш променливите.

```
частно репо (код, CI)  ──билдва──▶  публично репо "p2p-pure-releases"
                                       ├─ Releases: .exe, .deb, .rpm, .AppImage, .flatpak, .apk, SHA256SUMS
                                       └─ gh-pages: сайтът + приложението (dyrakarmy.online)
```

## Настройка (веднъж)

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
| Текстове на сайта | `SOURCE_CLOSED=1` маха „отворен код“ и връзките към файлове, които са само в частното репо |
| SBOM | `release: published` не се задейства между репа: пусни **Release SBOM** на ръка с тага. Подписът остава на workflow-а в частното репо |

## Какво спира да работи (честно)

- **F-Droid и Flathub** строят от публичен изходен код: не са възможни.
- **winget** приема манифест, но Microsoft може да поиска достъп до кода за проверка.
- Твърдението „повторими билдове, може да ги провериш“ вече не може да се провери от външен човек.
- Ако токенът изтече, изданията и сайтът спират да се публикуват (старите остават).

## Връщане

Изтрий променливите `RELEASES_REPO`, `SOURCE_CLOSED`, `PAGES_PUBLISH_REPO` и направи репото публично.
