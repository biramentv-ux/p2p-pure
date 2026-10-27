import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')

describe('iOS project and workflow', () => {
  const wf = read('.github/workflows/ios-testflight.yml')
  const pbx = read('ios/App/App.xcodeproj/project.pbxproj')

  it('uses the same bundle id everywhere', () => {
    expect(read('capacitor.config.ts')).toContain("appId: 'bg.p2pmessenger.app'")
    expect(pbx.match(/PRODUCT_BUNDLE_IDENTIFIER = bg\.p2pmessenger\.app;/g)).toHaveLength(2)
    expect(read('public/.well-known/apple-app-site-association')).toContain('TEAMID.bg.p2pmessenger.app')
  })

  it('has the passkey domain in the entitlements the project signs with', () => {
    const ent = read('ios/App/App/App.entitlements')
    expect(ent).toContain('webcredentials:dyrakarmy.online')
    expect(ent).toBe(read('native-overlays/ios/App.entitlements.template'))
    expect(pbx.match(/CODE_SIGN_ENTITLEMENTS = App\/App\.entitlements;/g)).toHaveLength(2)
  })

  it('pins every action to a commit', () => {
    for (const line of wf.split('\n').filter((l) => /^\s*-?\s*uses:/.test(l))) expect(line, line).toMatch(/@[0-9a-f]{40}\b/)
  })

  it('compiles without secrets, and signs and uploads only with all of them and never on a pull request', () => {
    expect(wf).toContain('CODE_SIGNING_ALLOWED=NO')
    const upload = wf.slice(wf.indexOf('Archive, sign and upload'))
    for (const s of ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_KEY_P8_BASE64', 'APPLE_TEAM_ID']) expect(upload.split('run:')[0]).toContain(`env.${s} != ''`)
    expect(upload.split('run:')[0]).toContain("github.event_name != 'pull_request'")
  })

  it('never prints a secret and removes the key file', () => {
    expect(wf).not.toMatch(/echo[^\n]*(ASC_KEY_P8_BASE64|ASC_KEY_ID|ASC_ISSUER_ID)/)
    expect(wf).toMatch(/trap 'rm -rf "\$key_dir"' EXIT/)
    expect(wf).toContain('chmod 600')
  })

  it('takes the version from the tag and raises the build number every run', () => {
    expect(wf).toContain('ios-v[0-9]*.[0-9]*.[0-9]*')
    expect(wf).toContain('BUILD_NUMBER=$GITHUB_RUN_NUMBER')
  })

  it('builds the web app with the same passkey RP ID as the site', () => {
    expect(wf).toContain("VITE_PASSKEY_RP_ID: ${{ vars.PASSKEY_RP_ID || 'dyrakarmy.online' }}")
  })
})

describe('go-private.ps1', () => {
  const full = readFileSync(resolve(root, 'scripts/windows/go-private.ps1'), 'utf8')
  const ps = full.slice(full.indexOf('$ErrorActionPreference')) // without the comment header
  it('does every step in order and changes the source repo only after the typed word', () => {
    const order = ['RunGh repo create', 'RELEASES_TOKEN', 'pages.yml', 'point-domain-to-pages.ps1', 'refs/tags/', 'release-sbom.yml', 'PRIVATE']
    let at = -1
    for (const t of order) { const i = ps.indexOf(t, at + 1); expect(i, t).toBeGreaterThan(at); at = i }
    expect(ps.match(/--visibility private/g)).toHaveLength(1)
    expect(ps).toContain('-ceq "PRIVATE"')
  })
  it('has no function named like an external command it calls (case-insensitive recursion)', () => {
    for (const [, name] of ps.matchAll(/^function\s+([\w-]+)/gm)) expect(name.toLowerCase(), name).not.toBe('gh')
    expect(ps).not.toMatch(/^\s*Gh\s/m)
  })
  it('never prints or stores the token', () => {
    expect(ps).not.toMatch(/Write-Host[^\n]*\$plain/)
    expect(ps).not.toMatch(/(Out-File|Set-Content|>>?\s)[^\n]*\$plain/)
    expect(ps).toContain('$plain = $null')
  })
  it('matches the version files it waits for', () => {
    expect(read('electron/package.json')).toContain('"version": "0.7.1"')
    expect(read('src-tauri/tauri.conf.json')).toContain('"version": "0.7.1"')
    expect(read('src-tauri/Cargo.toml')).toContain('version = "0.7.1"')
  })
})

describe('continue-private.ps1', () => {
  const full = readFileSync(resolve(root, 'scripts/windows/continue-private.ps1'), 'utf8')
  const ps = full.slice(full.indexOf('$ErrorActionPreference'))
  it('is saved with a BOM, so Windows PowerShell 5.1 reads the Cyrillic text', () => {
    expect(full.charCodeAt(0)).toBe(0xfeff)
  })
  it('has no function named like an external command it calls', () => {
    for (const [, name] of ps.matchAll(/^function\s+([\w-]+)/gm)) expect(['gh', 'git']).not.toContain(name.toLowerCase())
  })
  it('deletes the release tag only when the release is not published, and only after asking', () => {
    const del = ps.indexOf('-X DELETE')
    expect(del).toBeGreaterThan(0)
    const before = ps.slice(0, del)
    expect(before).toContain('$tagSha -and -not $published')
    expect(before.lastIndexOf('Read-Host')).toBeGreaterThan(before.lastIndexOf('$tagSha -and -not $published'))
    expect(ps.match(/-X DELETE/g)).toHaveLength(1)
  })
  it('never makes the repository private itself: that stays the typed step of go-private.ps1', () => {
    expect(ps).not.toContain('--visibility')
    expect(ps).toContain('& $go @params')
  })
  it('makes go-private.ps1 wait only for runs that started after a new tag', () => {
    const go = readFileSync(resolve(root, 'scripts/windows/go-private.ps1'), 'utf8')
    expect(go).toMatch(/Wait-Run "windows-desktop\.yml" \$Tag "push" \$since/)
    expect(go).toContain('function Wait-Run($workflow, $branch, $event, $Since = $null)')
  })
})
