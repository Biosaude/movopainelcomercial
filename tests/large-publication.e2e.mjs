import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { largeDataset } from "./support/large-dataset.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const XLSX = require("xlsx");
const base = process.env.DASHBOARD_TEST_URL ?? "http://127.0.0.1:3001";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const fixture = "http://127.0.0.1:54329";
async function rpc(path, body) {
  const response = await fetch(`${fixture}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  assert.ok(response.ok);
  return response.json();
}
const active = async () => (await rpc("/rest/v1/rpc/dashboard_read_manifest")).manifest;
const records = largeDataset();
assert.ok(new TextEncoder().encode(JSON.stringify(records)).byteLength > 4_500_000);
const wb = XLSX.utils.book_new();
const revenueHeaders = [
  "GR",
  "Representante",
  "Assessor",
  "UF",
  "Marca",
  "Tópico do Produto",
  "Tipo do Produto",
  "Cliente",
  "UF do Cliente",
  "Hospital",
  "UF do Hospital",
  "Médico",
  "Data",
  "Mês",
  "Período",
  "Valor",
];
const targetHeaders = [
  "GR",
  "Representante",
  "UF",
  "Marca",
  "Tópico do Produto",
  "Tipo do Produto",
  "Período",
  "Meta",
  "Meta Financeira",
];
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    revenueHeaders,
    ...records.faturamento.map((r) => [
      r.gr,
      r.rep,
      r.assessor,
      r.uf,
      r.marca,
      r.topico,
      r.tipo,
      r.cliente,
      r.ufCliente,
      r.hospital,
      r.ufHospital,
      r.medico,
      r.data,
      r.mes,
      r.periodo,
      r.valor,
    ]),
  ]),
  "Faturamento",
);
XLSX.utils.book_append_sheet(
  wb,
  XLSX.utils.aoa_to_sheet([
    targetHeaders,
    ...records.metas.map((r) => [
      r.gr,
      r.rep,
      r.uf,
      r.marca,
      r.topico,
      r.tipo,
      r.periodo,
      r.meta,
      r.metaFinanceira,
    ]),
  ]),
  "Metas",
);
const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx", compression: true });
assert.ok(buffer.length < 10_000_000);
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
});
const page = await browser.newPage();
page.setDefaultTimeout(120000);
const errors = [];
let maxRequest = 0;
let maxResponse = 0;
const responseChecks = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("dialog", (dialog) => dialog.accept());
page.on("request", (request) => {
  if (request.method() === "POST")
    maxRequest = Math.max(maxRequest, request.postDataBuffer()?.length ?? 0);
});
page.on("response", (response) => {
  if (response.url().includes("/_serverFn/"))
    responseChecks.push(
      response
        .body()
        .then((body) => {
          maxResponse = Math.max(maxResponse, body.length);
        })
        .catch(() => {}),
    );
});
try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.getByLabel("E-mail administrativo").fill("admin@example.test");
  await page.getByLabel("Senha administrativa").fill("fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByRole("heading", { name: "Histórico de importações (últimas 50 publicações)" })
    .waitFor();
  const before = await active();
  await page.locator('input[type="file"]').setInputFiles({
    name: "fictional-full-13759-633.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer,
  });
  await page
    .getByText("Planilha validada: fictional-full-13759-633.xlsx", { exact: false })
    .waitFor();
  assert.ok((await page.locator("body").innerText()).includes("13.759"));
  await rpc("/__test/fail-chunk", { index: 2 });
  await page.getByRole("button", { name: "Publicar base permanentemente" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Não foi possível confirmar a transferência" })
    .waitFor();
  assert.equal(
    (await active()).import.id,
    before.import.id,
    "An intermediate failure must keep the previous shared version",
  );
  await page.getByRole("button", { name: "Publicar base permanentemente" }).click();
  await page.getByText("Base publicada para todos os visitantes", { exact: false }).waitFor();
  const published = await active();
  assert.equal(published.import.revenue_count, 13759);
  assert.equal(published.import.target_count, 633);
  assert.equal(published.import.file_name, "fictional-full-13759-633.xlsx");
  await page.reload({ waitUntil: "networkidle", timeout: 120000 });
  await page
    .getByRole("heading", { name: "Histórico de importações (últimas 50 publicações)" })
    .waitFor();
  await page.getByRole("button", { name: "Selecionar Nova Base" }).waitFor({ state: "visible" });
  assert.ok((await page.locator("body").innerText()).includes("13.759 registros"));
  const visitor = await browser.newPage();
  visitor.setDefaultTimeout(120000);
  await visitor.goto(base, { waitUntil: "networkidle", timeout: 120000 });
  await visitor.getByRole("button", { name: "Selecionar Nova Base" }).waitFor({ state: "visible" });
  const text = await visitor.locator("body").innerText();
  assert.ok(text.includes("13.759 registros") && text.includes("633 registros"));
  assert.ok(text.includes("fictional-full-13759-633.xlsx"));
  const metrics = await (await fetch(`${fixture}/__test/metrics`)).json();
  assert.ok(metrics.pageReads > 2, "Large snapshots must use paged transport");
  assert.ok(metrics.maxBatchRequestBytes < 1_100_000);
  assert.ok(metrics.maxPageResponseBytes < 500_000);
  await Promise.all(responseChecks);
  assert.ok(maxRequest < 1_100_000, `Actual function request exceeded budget: ${maxRequest}`);
  assert.ok(
    maxResponse > 0 && maxResponse < 1_100_000,
    `Actual function response exceeded budget: ${maxResponse}`,
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS large E2E: full 13,759 + 633 import, intermediate failure, idempotent resume, successful publication, reload and fresh visitor. Max actual function POST: ${maxRequest} bytes; response: ${maxResponse} bytes.`,
  );
} finally {
  await browser.close();
}
