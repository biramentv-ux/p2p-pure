/**
 * The steps one person takes in the app, shared by the NAT lab (agent.mjs, a browser in a network
 * namespace) and the device farm (scripts/devicefarm/farm.mjs, the WebView of a real phone over
 * CDP). Needs a lab build (VITE_NATLAB=1), which exposes the app's own QR decoder.
 */
export function createSteps(page, { base, password = "natlab parola 2026" }) {
  const PASSWORD = password;
  async function readQr() {
    const end = Date.now() + 40_000;
    for (;;) {
      await page.locator("canvas[aria-label]").first().waitFor({ timeout: 40_000 });
      const text = await page.evaluate(async () => {
        const c = document.querySelector("canvas[aria-label]");
        if (!c || c.width === 0) return null;
        const img = c.getContext("2d").getImageData(0, 0, c.width, c.height);
        // The lab build exposes the decoder (VITE_NATLAB=1) so the agent can read its own QR.
        return window.__natlab?.decodeQr(img.data, img.width, img.height) ?? null;
      });
      if (text) return text;
      if (Date.now() > end) throw new Error("QR could not be decoded");
      await page.waitForTimeout(300);
    }
  }

  async function pasteCode(payload) {
    await page.locator("details summary").click();
    await page.locator('textarea[aria-label="Поканен код"]').fill(payload);
    await page.getByRole("button", { name: "Използвай кода" }).click();
  }

  return {
    async init() {
      // The farm drives an app that is already open (no base); the lab opens its own server.
      if (base) await page.goto(base + "/");
      await page.getByRole("button", { name: "Създай идентичност" }).click();
      const pwd = page.locator('input[type="password"]').first();
      const grid = page.locator("ol.mnemonic-grid");
      // Firefox has no virtual authenticator here: the passkey fails and the app offers a password.
      const usePassword = page.getByRole("button", { name: "Продължи с парола" });
      await Promise.race([pwd.waitFor({ timeout: 30_000 }), grid.waitFor({ timeout: 30_000 }), usePassword.waitFor({ timeout: 30_000 })]);
      if (await usePassword.isVisible()) {
        await usePassword.click();
        await pwd.waitFor({ timeout: 30_000 });
      }
      if (await pwd.isVisible()) {
        await page.locator('input[type="password"]').nth(0).fill(PASSWORD);
        await page.locator('input[type="password"]').nth(1).fill(PASSWORD);
        await page.locator("form button[type=submit]").click();
        await grid.waitFor({ timeout: 30_000 });
      }
      await page.locator('input[type="checkbox"]').check();
      await page.getByRole("button", { name: "Продължи" }).click();
      return {};
    },
    async offer() {
      await page.getByRole("button", { name: "Свържи се" }).click();
      await page.getByRole("button", { name: "Покажи моята покана" }).click();
      return { offer: await readQr() };
    },
    async answer({ offer }) {
      await page.getByRole("button", { name: "Свържи се" }).click();
      await page.getByRole("button", { name: "Сканирай чужда покана" }).click();
      await pasteCode(offer);
      return { answer: await readQr() };
    },
    async accept({ answer }) {
      await page.getByRole("button", { name: "Сканирай отговора" }).click();
      await pasteCode(answer);
      return {};
    },
    async outcome({ timeoutMs = 75_000 }) {
      const safety = page.locator(".safety-code");
      const alert = page.locator('[role="alert"]').filter({ hasText: /./ });
      try {
        await Promise.race([safety.waitFor({ timeout: timeoutMs }), alert.first().waitFor({ timeout: timeoutMs })]);
      } catch {
        return { connected: false, error: null };
      }
      if (await safety.isVisible()) return { connected: true, error: null };
      return { connected: false, error: (await alert.first().innerText()).trim() };
    },
    /** `waitMs`: longer on impaired links (loss + jitter: SCTP retransmits can take tens of seconds). */
    async chat({ name, send, expect, waitMs = 30_000 }) {
      const step = async (what, fn) => {
        try {
          await fn();
        } catch (e) {
          throw new Error(`chat/${what}: ${e.message.split("\n")[0]}`);
        }
      };
      await page.getByPlaceholder("Например: Иван").fill(name);
      await page.getByRole("button", { name: "Думите съвпадат" }).click();
      await step("open", () => page.locator(".chat").waitFor({ timeout: waitMs }));
      if (send) {
        await page.locator(".composer input").fill(send);
        await page.getByRole("button", { name: "Изпрати" }).click();
      }
      if (expect) await step("receive", () => page.locator(".messages .msg.in").filter({ hasText: expect }).waitFor({ timeout: waitMs }));
      return { ok: true };
    },
  };
}
