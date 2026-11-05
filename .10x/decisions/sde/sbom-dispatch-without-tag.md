# SDE: sbom-dispatch-without-tag
- `.github/workflows/release-sbom.yml`: нова стъпка `Resolve subject ref` (gh api git/ref/tags), checkout на `steps.subject.outputs.ref`.
- `tests/release/desktopRelease.test.ts`: изпълнява скрипта на стъпката с фалшив `gh` (таг има / няма, dispatch / push / release).
- `docs/SUPPLY-CHAIN.md`: описано ръчното пускане без таг.
- Без нови зависимости. Технически дълг: няма.
