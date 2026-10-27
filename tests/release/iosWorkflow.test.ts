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
