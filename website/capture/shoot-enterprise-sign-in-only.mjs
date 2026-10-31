// Shoot the enterprise sign-in-only screen: the Company SSO form a signed-out
// enterprise gateway shows, and the wait after sign-in. Run from website/:
//   node capture/shoot-enterprise-sign-in-only.mjs <outdir>
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import path from 'node:path'

const outDir = process.argv[2] || '/tmp/enterprise-sign-in-only-shots'
const executablePath = process.env.CHROMIUM_PATH

const server = await createServer({
  configFile: 'vite.config.ts',
  server: { port: 5198, strictPort: true, host: '127.0.0.1' },
})
await server.listen()

const browser = await chromium.launch({ executablePath })
const shots = [
  { name: 'sso-form-dark', scene: 'signed-out', theme: 'dark', wait: '[data-testid="kas-login-sso-form"]' },
  { name: 'sso-form-light', scene: 'signed-out', theme: 'light', wait: '[data-testid="kas-login-sso-form"]' },
  { name: 'starting-dark', scene: 'signed-in', theme: 'dark', wait: '[role="status"]' },
  { name: 'stopped-dark', scene: 'stopped', theme: 'dark', wait: '[data-testid="enterprise-gateway-stopped"]' },
]
for (const shot of shots) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  await page.goto(
    `http://127.0.0.1:5198/capture/enterprise-sign-in-only.html?scene=${shot.scene}&theme=${shot.theme}`,
  )
  await page.waitForSelector(shot.wait, { timeout: 45000 })
  if (shot.scene === 'signed-out') {
    await page.fill('#kas-sso-start-url', 'https://your-company.awsapps.com/start')
  }
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(outDir, `${shot.name}.png`) })
  await ctx.close()
}
await browser.close()
await server.close()
