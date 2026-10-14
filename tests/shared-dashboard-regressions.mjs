import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const XLSX = require("xlsx");
const base = process.env.DASHBOARD_TEST_URL ?? "http://127.0.0.1:3001";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
// The fixture is always local and backed by the runner's disposable database.
const fixture = "http://127.0.0.1:54329";
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
});
const errors = [];
const page = await browser.newPage();
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());

async function request(path, data, authenticated = false) {
  const response = await fetch(`${fixture}${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { Authorization: "Bearer fixture-admin-token" } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  assert.ok(response.ok, `${path} returned ${response.status}`);
  return response.json();
}
const reads = async () => (await request("/__test/metrics")).snapshotReads;
const snapshot = async () => (await request("/rest/v1/rpc/dashboard_read_snapshot", {})).snapshot;
const history = () => request("/rest/v1/dashboard_imports", undefined, true);
const publishButton = () => page.getByRole("button", { name: "Publicar base permanentemente" });
const reloadButton = () => page.getByRole("button", { name: "Recarregar base compartilhada" });

async function ready() {
  await reloadButton().waitFor();
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find((button) =>
        button.textContent.includes("Recarregar base compartilhada"),
      )?.disabled,
  );
  await page.waitForLoadState("networkidle");
}
async function login() {
  await page.getByLabel("E-mail administrativo").fill("admin@example.test");
  await page.getByLabel("Senha administrativa").fill("fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByRole("heading", { name: "Histórico de importações (últimas 50 publicações)" })
    .waitFor();
  await ready();
}
async function selectWorkbook(name, value) {
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
  await page
    .locator('input[type="file"]')
    .setInputFiles({
      name,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }),
    });
  await page.getByText(`Planilha validada: ${name}`, { exact: false }).waitFor();
}
async function commitWithFailedRead(name, value) {
  await selectWorkbook(name, value);
  await request("/__test/fail-read-after-publish", {});
  await publishButton().click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Publicação confirmada, mas a leitura falhou" })
    .waitFor();
  // Recover access after the failed refresh, retaining the selected request ID.
  await reloadButton().click();
  await ready();
  assert.equal(await publishButton().count(), 1);
}

try {
  const anonymousBefore = await reads();
  await page.goto(base, { waitUntil: "networkidle" });
  await ready();
  assert.equal(
    (await reads()) - anonymousBefore,
    1,
    "Anonymous hydration must use the loader snapshot without another read or INITIAL_SESSION reload",
  );
  console.log("PASS: anonymous hydration performs exactly one snapshot read.");

  const manualBefore = await reads();
  await reloadButton().click();
  await ready();
  assert.equal(
    (await reads()) - manualBefore,
    1,
    "Explicit reload must still fetch a fresh snapshot",
  );
  console.log("PASS: explicit refresh performs exactly one additional read.");

  const loginBefore = await reads();
  await login();
  assert.equal(
    (await reads()) - loginBefore,
    1,
    "A new authenticated session must refresh access once",
  );
  const restoredBefore = await reads();
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: "Histórico de importações (últimas 50 publicações)" })
    .waitFor();
  await ready();
  assert.equal(
    (await reads()) - restoredBefore,
    2,
    "Restored authentication needs only the anonymous loader read and one authenticated refresh",
  );
  console.log("PASS: login and restored sessions refresh access without duplicate reads.");

  const logoutBefore = await reads();
  await page.getByRole("button", { name: "Sair", exact: true }).click();
  await page.getByRole("button", { name: "Entrar", exact: true }).waitFor();
  await ready();
  assert.equal((await reads()) - logoutBefore, 1, "Logout must refresh public access once");
  await login();
  console.log("PASS: logout refreshes public access.");

  const activeCount = (await history()).length;
  await commitWithFailedRead("fictional-active-retry.xlsx", 701);
  const active = await snapshot();
  assert.equal(active.import.file_name, "fictional-active-retry.xlsx");
  await publishButton().click();
  await page.getByText("Base publicada para todos os visitantes", { exact: false }).waitFor();
  assert.equal(
    (await history()).length,
    activeCount + 1,
    "An active idempotent retry must not create another import",
  );
  assert.equal(
    (await snapshot()).import.id,
    active.import.id,
    "An active idempotent retry must keep the same import",
  );
  console.log("PASS: retry of the active publication reports success without duplicating data.");

  const supersededCount = (await history()).length;
  await commitWithFailedRead("fictional-superseded-retry.xlsx", 702);
  const superseded = await snapshot();
  const otherId = randomUUID();
  await request(
    "/rest/v1/rpc/dashboard_publish",
    {
      p_request_id: otherId,
      p_expected_version: superseded.import.id,
      p_file_name: "fictional-other-publication.xlsx",
      p_faturamento: superseded.faturamento.map((row) => ({ ...row, valor: 703 })),
      p_metas: superseded.metas,
    },
    true,
  );
  // Retry the original selection; the unchanged SQL RPC returns its historical ID.
  await publishButton().click();
  await page.getByRole("alert").filter({ hasText: "outra base está ativa" }).waitFor();
  assert.equal(
    await page.getByText("Base publicada para todos os visitantes", { exact: false }).count(),
    0,
    "A superseded retry must not announce the old file as the active publication",
  );
  const latest = await snapshot();
  assert.equal(latest.import.id, otherId, "Retry must not change the newer active version");
  assert.equal(latest.faturamento[0].valor, 703);
  assert.equal(
    (await history()).length,
    supersededCount + 2,
    "Retry must not duplicate either import",
  );
  assert.equal((await history()).filter((item) => item.id === superseded.import.id).length, 1);
  assert.ok(
    (await page.locator("body").innerText()).includes("fictional-other-publication.xlsx"),
    "Administrator must see the actual active snapshot",
  );
  console.log(
    "PASS: retry of a superseded publication reports the active-version conflict, without duplicates or pointer changes.",
  );
  assert.deepEqual(errors, [], "No browser runtime errors");
} finally {
  await browser.close();
}
