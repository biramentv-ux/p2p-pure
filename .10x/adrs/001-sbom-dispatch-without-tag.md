# ADR-001: Release SBOM без таг в изходното хранилище при ръчно пускане

**Status:** Accepted
**Date:** 2026-11-05
**Feature:** sbom-dispatch-without-tag

## Context
Ръчно пуснатите Windows/Linux сборки (`release_tag`) правят тага само в хранилището за издания
и записват `github.sha` в черновата (`<!-- source-commit -->`). `release-sbom.yml` при
`workflow_dispatch` правеше checkout на `refs/tags/$TAG` в изходното хранилище и падаше с
„couldn't find remote ref“. Прокси средата не може да създава тагове (403), така че 0.8.0 чакаше
ръчно качен таг.

## Decision
Стъпка „Resolve subject ref“: ако тагът съществува в изходното хранилище → него; иначе, само при
`workflow_dispatch` → `github.sha` (същия commit като ръчните сборки); при push/release → грешка.

## Alternatives Considered
| Алтернатива | Защо не |
|---|---|
| Workflow-ът сам да създава тага | Нужни са `contents: write` в генериращата стъпка; тагът задейства повторни сборки на push |
| Вход `ref` при dispatch | Още едно поле за попълване; клонът вече се избира в „Run workflow“ |

## Consequences
- Изданието се пуска изцяло ръчно (Windows, Linux, SBOM, всички с таг) без таг в изходното хранилище.
- Ако `main` се промени между ръчните пускания, commit-ите ще се различават и `desktop-release.sh`
  ще изтрие черновата като остаряла (съществуваща защита) — пуснете трите отново.
- Подписът на cosign е с идентичност `release-sbom.yml@refs/heads/main`, вече разрешена в SUPPLY-CHAIN.md.
