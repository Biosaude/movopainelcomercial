import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const XLSX = require("xlsx");
const base = process.env.DASHBOARD_TEST_URL ?? "http://127.0.0.1:3001";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/); // Never runs against production.
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({ headless: true, executablePath });
const workbook = (value) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      [
        "GR",
        "Representante",
        "Marca",
        "Tópico do Produto",
        "Período",
        "UF do Hospital",
        "Valor",
        "",
        "GR",
        "Representante",
        "UF",
        "Marca",
        "Tópico do Produto",
        "Período",
        "Meta",
        "Meta Financeira",
      ],
      [
        "TEST",
        "REP",
        "MARCA",
        "TEST",
        "Q3 2026",
        "PA",
        value,
        "",
        "TEST",
        "REP",
        "PA",
        "MARCA",
        "TEST",
        "Q3 2026",
        600,
        540,
      ],
    ]),
    "Base",
  );
  return {
    name: `fictional-${value}.xlsx`,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }),
  };
};
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on("pageerror", (error) => errors.push(error.message));
const login = async (email) => {
  await page.getByLabel("E-mail administrativo").fill(email);
  await page.getByLabel("Senha administrativa").fill("fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
};
try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Dashboard Comercial · Biosaude" }).waitFor();
  assert.ok(await page.getByRole("button", { name: "Publicar base permanentemente" }).isDisabled());
  await page.evaluate(() =>
    localStorage.setItem("biosaude.fat.representante.v2", JSON.stringify([{ valor: 999999999 }])),
  );
  await page.reload({ waitUntil: "networkidle" });
  assert.ok(
    !(await page.locator("body").innerText()).includes("999.999.999"),
    "Old browser cache must not override shared snapshot",
  );
  for (const name of [
    "Baixar Modelo da Base",
    "Selecionar Nova Base",
    "Atualizar Dashboard temporariamente",
    "Publicar base permanentemente",
  ]) {
    assert.ok(await page.getByRole("button", { name }).isDisabled());
  }
  assert.ok(await page.locator('input[type="file"]').isDisabled());
  await page.getByLabel("E-mail administrativo").fill("admin@example.test");
  await page.getByLabel("Senha administrativa").fill("wrong-fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Não foi possível entrar" }).waitFor();
  await login("visitor@example.test");
  await page.getByText("Sem permissão administrativa", { exact: false }).waitFor();
  assert.ok(await page.getByRole("button", { name: "Publicar base permanentemente" }).isDisabled());
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await page.getByRole("button", { name: "Entrar", exact: true }).waitFor();
  await login("admin@example.test");
  await page
    .getByRole("heading", { name: "Histórico de importações (últimas 50 publicações)" })
    .waitFor();
  await page.locator('input[type="file"]').setInputFiles(workbook(456));
  await page.getByText("Planilha validada:", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Atualizar Dashboard temporariamente" }).click();
  await page.getByText("Prévia temporária neste navegador.", { exact: false }).waitFor();
  const dialog = new Promise((resolve) =>
    page.once("dialog", async (event) => {
      assert.match(event.message(), /todos os visitantes/);
      await event.accept();
      resolve();
    }),
  );
  await page.getByRole("button", { name: "Publicar base permanentemente" }).click();
  await dialog;
  await page.getByText("Base publicada para todos os visitantes", { exact: false }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: "Histórico de importações (últimas 50 publicações)" })
    .waitFor();
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  const visitor = await browser.newPage();
  await visitor.goto(base, { waitUntil: "networkidle" });
  assert.ok(
    (await visitor.locator("body").innerText()).includes("fictional-456.xlsx"),
    "Fresh visitor must see latest import",
  );
  assert.ok(
    (await visitor.locator("body").innerText()).includes("456,00"),
    "Fresh visitor must see published financial values",
  );
  await visitor.screenshot({ path: "/tmp/movopainel-shared-desktop.png", fullPage: true });
  await visitor.setViewportSize({ width: 390, height: 844 });
  await visitor.screenshot({ path: "/tmp/movopainel-shared-mobile.png", fullPage: true });
  const sizes = await visitor.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  assert.ok(
    sizes.width <= sizes.viewport + 1,
    "Dashboard must not overflow horizontally on mobile",
  );
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(
    "Browser assertions passed: public read, stale localStorage ignored, public management disabled, login, non-admin denial, admin publish, reload persistence, new visitor, desktop/mobile.",
  );
} finally {
  await browser.close();
}
