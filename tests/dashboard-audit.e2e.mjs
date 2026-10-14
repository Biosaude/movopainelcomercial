import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { auditDataset, auditGroup } from "./support/audit-dataset.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const base = process.env.DASHBOARD_TEST_URL ?? "http://127.0.0.1:3001";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const fixture = "http://127.0.0.1:54329";
async function request(path, data = {}, actor) {
  const response = await fetch(`${fixture}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(actor ? { Authorization: `Bearer fixture-${actor}-token` } : {}),
    },
    body: JSON.stringify(data),
  });
  assert.ok(response.ok, `${path}: ${await response.clone().text()}`);
  return response.json();
}
const rpc = (name, data, actor) => request(`/rest/v1/rpc/${name}`, data, actor);
async function publish(records, name) {
  const previous = await rpc("dashboard_read_manifest");
  const id = randomUUID();
  const plan = [],
    payloads = [];
  for (const kind of ["faturamento", "metas"]) {
    for (let start = 0; start < records[kind].length; start += 250) {
      const rows = records[kind].slice(start, start + 250),
        payload = JSON.stringify(rows);
      assert.ok(Buffer.byteLength(payload) < 500000);
      plan.push({
        kind,
        start,
        count: rows.length,
        hash: createHash("sha256").update(payload).digest("hex"),
      });
      payloads.push(payload);
    }
  }
  await rpc(
    "dashboard_upload_begin",
    {
      p_request_id: id,
      p_expected_version: previous.manifest?.import.id ?? null,
      p_file_name: name,
      p_revenue_count: records.faturamento.length,
      p_target_count: records.metas.length,
      p_plan: plan,
    },
    "admin",
  );
  for (let index = 0; index < payloads.length; index++)
    await rpc(
      "dashboard_upload_chunk",
      { p_request_id: id, p_chunk_index: index, p_payload: payloads[index] },
      "admin",
    );
  await rpc("dashboard_upload_commit", { p_request_id: id }, "admin");
  return id;
}
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
});
const errors = [],
  consoleErrors = [];
const newPage = async (mobile = false) => {
  const page = await browser.newPage({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1100 },
  });
  page.setDefaultTimeout(60000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().startsWith("Failed to load resource:"))
      consoleErrors.push(m.text());
  });
  // Provider fixture: test map rendering without relying on external network availability.
  await page.route("**/servicodados.ibge.gov.br/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        features: [
          "11",
          "12",
          "13",
          "14",
          "15",
          "16",
          "17",
          "21",
          "22",
          "23",
          "24",
          "25",
          "26",
          "27",
          "28",
          "29",
          "31",
          "32",
          "33",
          "35",
          "41",
          "42",
          "43",
          "50",
          "51",
          "52",
          "53",
        ].map((codarea) => ({
          properties: { codarea },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [-50, -10],
                [-49, -10],
                [-49, -11],
                [-50, -10],
              ],
            ],
          },
        })),
      }),
    }),
  );
  return page;
};
const kpi = (page, name) =>
  page
    .locator("p")
    .filter({ hasText: new RegExp(`^${name}$`) })
    .locator("..")
    .locator("p")
    .nth(1);
const money = (value) => Number(value.replace(/R\$|\s|\./g, "").replace(",", "."));
const management = [
  "Baixar Modelo da Base",
  "Selecionar Nova Base",
  "Atualizar Dashboard temporariamente",
  "Publicar base permanentemente",
];
async function ready(page) {
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll("button")].find((b) =>
        b.textContent.includes("Recarregar base compartilhada"),
      )?.disabled,
  );
  await page.getByText("Reconciliação OK", { exact: true }).waitFor();
  await page.getByRole("img", { name: "Mapa do faturamento FY26 por UF do Hospital" }).waitFor();
}
async function login(page, actor = "admin") {
  await page
    .getByLabel("E-mail administrativo")
    .fill(`${actor === "admin" ? "admin" : "visitor"}@example.test`);
  await page.getByLabel("Senha administrativa").fill("fixture-password");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page
    .getByText(
      actor === "admin" ? "admin@example.test · Administrador" : "Sem permissão administrativa",
      { exact: false },
    )
    .waitFor();
  await ready(page);
}
async function choose(page, label, option) {
  await page
    .locator("label")
    .filter({ hasText: new RegExp(`^${label}(?:\\s*\\(\\d+\\))?$`) })
    .locator("..")
    .getByRole("button")
    .click();
  await page
    .locator('[role="dialog"][data-state="open"]')
    .getByRole("button", { name: option, exact: true })
    .click();
  await page.keyboard.press("Escape");
}
const normalizeText = (text) => text.replace(/\s+/g, " ").trim();
async function analytic(page) {
  // Exclude only the final management card; compare every analytical section.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(1700);
  return page.locator("main > *:not(:last-child)").evaluateAll((els) =>
    els.map((el) => {
      const copy = el.cloneNode(true);
      copy
        .querySelectorAll(".recharts-tooltip-wrapper, [role=tooltip]")
        .forEach((node) => node.remove());
      return copy.textContent.replace(/\s+/g, " ").trim();
    }),
  );
}
const dimensions = {
  Ano: (r) => r.periodo.slice(-4),
  QUARTER: (r) => r.periodo.slice(0, 2),
  Mês: (r) => (r.mes === "02" ? "Fevereiro" : "Agosto"),
  GR: (r) => r.gr,
  UF: (r) => r.uf,
  "UF do Cliente": (r) => r.ufCliente,
  "UF do Hospital": (r) => r.ufHospital,
  Marca: (r) => r.marca,
  "Tópico do Produto": (r) => r.topico,
  "Tipo do Produto": (r) => r.tipo,
  Cliente: (r) => r.cliente,
  Médico: (r) => r.medico,
  Representante: (r) => r.rep,
  Assessor: (r) => r.assessor,
};
const targetOnly = new Set(["UF do Cliente", "UF do Hospital", "Cliente", "Médico", "Assessor"]);
const groupKey = (r) => [r.periodo.slice(0, 2), r.gr, r.rep, r.uf, r.marca, r.topico].join("|");
function expected(records, selections) {
  const fat = records.faturamento.filter((r) =>
    Object.entries(selections).every(([key, values]) => values.includes(dimensions[key](r))),
  );
  const keys = new Set(fat.map(groupKey));
  const quarters = { Q1: ["Janeiro", "Fevereiro", "Março"], Q3: ["Julho", "Agosto", "Setembro"] };
  const metas = records.metas
    .flatMap((r) =>
      selections["Mês"]?.length
        ? quarters[r.periodo.slice(0, 2)].map((month) => ({
            ...r,
            month,
            meta: r.meta / 3,
            metaFinanceira: r.metaFinanceira / 3,
          }))
        : [r],
    )
    .filter(
      (r) =>
        Object.entries(selections).every(([key, values]) =>
          targetOnly.has(key)
            ? true
            : values.includes(key === "Mês" ? r.month : dimensions[key](r)),
        ) &&
        (!Object.keys(selections).some((key) => targetOnly.has(key)) || keys.has(groupKey(r))),
    );
  const fy25 = fat.filter((r) => r.periodo.endsWith("2025")),
    fy26 = fat.filter((r) => r.periodo.endsWith("2026"));
  return {
    fat,
    metas,
    fy25,
    fy26,
    total25: fy25.reduce((s, r) => s + r.valor, 0),
    total26: fy26.reduce((s, r) => s + r.valor, 0),
    mv: metas.reduce((s, r) => s + r.meta, 0),
    mf: metas.reduce((s, r) => s + r.metaFinanceira, 0),
  };
}
async function verifyValues(page, values) {
  for (const [label, amount] of [
    ["FY 25", values.total25],
    ["FY 26", values.total26],
    ["MV 2026", values.mv],
    ["MF 2026", values.mf],
  ]) {
    const element = kpi(page, label),
      title = await element.getAttribute("title");
    if (label === "MF 2026" && values.mf === 0) assert.equal(await element.innerText(), "Sem meta");
    else if (label === "MV 2026" && values.mv === 0)
      assert.equal(money(await element.innerText()), 0);
    else assert.ok(Math.abs(money(title) - amount) < 0.011, `${label}: ${title} vs ${amount}`);
    assert.ok(!(await element.innerText()).includes("milhões"));
  }
  for (const [label, denominator] of [
    ["Cobertura MV", values.mv],
    ["Cobertura MF", values.mf],
  ])
    assert.equal(
      await kpi(page, label).innerText(),
      denominator
        ? `${((values.total26 / denominator) * 100).toFixed(2).replace(".", ",")}%`
        : "Sem meta",
    );
  const fy26count = page
    .locator("p")
    .filter({ hasText: /^FY 26$/ })
    .locator("..")
    .locator("p")
    .nth(2);
  assert.equal(
    normalizeText(await fy26count.innerText()),
    `${values.fy26.length.toLocaleString("pt-BR")} registros`,
  );
  assert.equal(
    await page.locator("[data-map-reconciled]").getAttribute("data-map-reconciled"),
    "true",
  );
  // Reconciliation covers the actual sums backing GR/topic/type charts.
  for (const label of ["KPI FY 26:", "Soma GR:", "Soma Tópico:", "Soma Tipo:"]) {
    const amount = await page.getByText(label, { exact: true }).locator("..").innerText();
    assert.ok(Math.abs(money(amount.replace(label, "")) - values.total26) < 0.011);
  }
  const clients = new Map();
  for (const r of values.fy26) clients.set(r.cliente, (clients.get(r.cliente) ?? 0) + r.valor);
  const ranked = [...clients].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const actual = await page.locator("li[title]").evaluateAll((els) => els.map((el) => el.title));
  assert.deepEqual(
    actual,
    ranked.map(
      ([name, value]) =>
        `${name} · ${value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}`,
    ),
  );
}
try {
  // Exact reported KPI strings, using a small fictional version.
  const group = auditGroup(5);
  const small = {
    faturamento: [
      { ...group, periodo: "Q1 2025", valor: 77500000 },
      { ...group, valor: 82900000 },
    ],
    metas: [
      {
        gr: group.gr,
        rep: group.rep,
        uf: group.uf,
        marca: group.marca,
        topico: group.topico,
        tipo: group.tipo,
        periodo: group.periodo,
        meta: 117400000,
        metaFinanceira: 105700000,
      },
    ],
  };
  await publish(small, "fictional-currency-audit.xlsx");
  const visitor = await newPage();
  await visitor.goto(base, { waitUntil: "networkidle" });
  await ready(visitor);
  assert.equal(await visitor.locator("html").getAttribute("lang"), "pt-BR");
  assert.equal(await visitor.locator("html").getAttribute("translate"), "no");
  assert.equal(await visitor.locator('meta[name="google"]').getAttribute("content"), "notranslate");
  for (const [label, text] of [
    ["FY 25", "R$ 77,5 mi"],
    ["FY 26", "R$ 82,9 mi"],
    ["MV 2026", "R$ 117,4 mi"],
    ["MF 2026", "R$ 105,7 mi"],
  ])
    assert.equal(await kpi(visitor, label).innerText(), text);
  for (const name of management)
    assert.ok(await visitor.getByRole("button", { name }).isDisabled());
  assert.ok(await visitor.locator('input[type="file"]').isDisabled());
  // Model an extension that ignores translate=no and replaces text nodes.
  await visitor.evaluate(() => {
    const summary = [...document.querySelectorAll("span")].find((el) =>
      el.textContent.startsWith("Exibindo todos os registros"),
    );
    for (const node of [...summary.childNodes])
      if (node.nodeType === Node.TEXT_NODE) {
        const font = document.createElement("font");
        font.textContent = node.textContent;
        node.replaceWith(font);
      }
  });
  await choose(visitor, "UF", "PA");
  await verifyValues(visitor, expected(small, { UF: ["PA"] }));
  assert.equal(await visitor.getByText("This page didn't load", { exact: false }).count(), 0);
  console.log(
    "PASS audit: compact million KPIs, document language, public controls, translated DOM regression and public UF.",
  );
  const records = auditDataset();
  assert.ok(Buffer.byteLength(JSON.stringify(records)) > 3000000);
  const version = await publish(records, "fictional-full-analysis-13759-633.xlsx");
  await visitor.reload({ waitUntil: "networkidle" });
  await ready(visitor);
  const admin = await newPage();
  await admin.goto(base, { waitUntil: "networkidle" });
  await login(admin);
  const metadata = await rpc("dashboard_read_manifest");
  assert.equal(metadata.manifest.import.id, version);
  assert.equal(metadata.manifest.import.revenue_count, 13759);
  assert.equal(metadata.manifest.import.target_count, 633);
  const scenarios = [
    {},
    ...Object.keys(dimensions).map((key) => ({ [key]: [dimensions[key](group)] })),
    { UF: ["AP", "PA"] },
    { Ano: ["2026"], QUARTER: ["Q1"], Mês: ["Fevereiro"], UF: ["PA"] },
    Object.fromEntries(Object.keys(dimensions).map((key) => [key, [dimensions[key](group)]])),
    { "UF do Hospital": ["AP"], UF: ["PA"] },
  ];
  const started = Date.now();
  for (const [index, selections] of scenarios.entries()) {
    for (const page of [visitor, admin]) {
      await page.getByRole("button", { name: "Limpar filtros", exact: true }).click();
      for (const [label, values] of Object.entries(selections))
        for (const value of values) await choose(page, label, value);
      await verifyValues(page, expected(records, selections));
    }
    assert.deepEqual(
      await analytic(visitor),
      await analytic(admin),
      `Analytical difference in scenario ${index}: ${JSON.stringify(selections)}`,
    );
    console.log(
      `PASS analytical parity ${index + 1}/${scenarios.length}: ${Object.keys(selections).join(" + ") || "all records"}`,
    );
  }
  // Drill-down respects the same filtered universe and reconciles both financial totals.
  for (const page of [visitor, admin]) {
    await page.getByRole("button", { name: "Limpar filtros", exact: true }).click();
    await choose(page, "UF", "PA");
    await page
      .locator("p")
      .filter({ hasText: /^FY 26$/ })
      .click();
    const total = await page.getByRole("dialog").locator("tfoot").innerText(),
      values = expected(records, { UF: ["PA"] });
    assert.ok(
      total.includes(
        values.total26.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }),
      ),
    );
  }
  assert.equal(
    await visitor.getByRole("dialog").locator("table").innerText(),
    await admin.getByRole("dialog").locator("table").innerText(),
  );
  await visitor.keyboard.press("Escape");
  await admin.keyboard.press("Escape");
  for (const page of [visitor, admin]) {
    await page.getByPlaceholder("Pesquisar médico…").fill("medico 1");
    const rows = page
      .locator("main table")
      .filter({ has: page.getByRole("columnheader", { name: "Médico", exact: true }) })
      .locator("tbody tr");
    assert.equal(await rows.count(), 1);
    assert.ok((await rows.innerText()).includes("Médico 1"));
    await verifyValues(page, expected(records, { UF: ["PA"] }));
    await page.getByPlaceholder("Pesquisar médico…").fill("");
  }
  const before = await analytic(visitor);
  await request("/__test/fail-page", { offset: 500 });
  await visitor.getByRole("button", { name: "Recarregar base compartilhada" }).click();
  await ready(visitor);
  await visitor.getByRole("status").filter({ hasText: "Não foi possível carregar" }).waitFor();
  assert.deepEqual(
    (await analytic(visitor)).slice(1),
    before,
    "A lost page must retain the complete previous analytics",
  );
  await visitor.getByRole("button", { name: "Recarregar base compartilhada" }).click();
  await ready(visitor);
  await visitor.reload({ waitUntil: "networkidle" });
  await ready(visitor);
  await verifyValues(visitor, expected(records, {}));
  // Authorization RPC cannot be bypassed by replaying the authenticated request.
  const authorizationRequest = admin.waitForRequest(
    (r) => r.method() === "POST" && r.url().includes("/_serverFn/"),
  );
  const download = admin.waitForEvent("download");
  await admin.getByRole("button", { name: "Baixar Modelo da Base" }).click();
  const call = await authorizationRequest;
  const artifact = await download;
  const artifactPath = await artifact.path();
  const artifactBytes = require("node:fs").statSync(artifactPath).size;
  assert.ok(
    artifactBytes < 10000000,
    "The full downloaded template must fit the existing file-selection limit",
  );
  const XLSX = require("xlsx");
  const exported = XLSX.readFile(artifactPath);
  const exportedRows = XLSX.utils
    .sheet_to_json(exported.Sheets.Base, { header: 1, raw: true })
    .slice(1);
  assert.equal(exportedRows.filter((row) => typeof row[15] === "number").length, 13759);
  assert.equal(exportedRows.filter((row) => typeof row[24] === "number").length, 633);
  const totals = expected(records, {});
  for (const [column, total] of [
    [15, totals.total25 + totals.total26],
    [24, totals.mv],
    [25, totals.mf],
  ])
    assert.ok(
      Math.abs(exportedRows.reduce((sum, row) => sum + (Number(row[column]) || 0), 0) - total) <
        0.011,
    );
  console.log(
    `PASS template: ${artifactBytes} bytes, 13,759 revenue and 633 targets, unchanged financial totals.`,
  );
  const headers = await call.allHeaders();
  delete headers.authorization;
  delete headers.cookie;
  for (const actor of [undefined, "visitor", "invalid"]) {
    const r = await fetch(call.url(), {
      method: "POST",
      headers: { ...headers, ...(actor ? { authorization: `Bearer fixture-${actor}-token` } : {}) },
      body: call.postData(),
    });
    const text = await r.text();
    assert.ok(/Entre com uma conta|permissão administrativa|Sessão inválida/.test(text));
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([
      ["GR", "Representante", "Marca", "Tópico do Produto", "Período", "UF do Hospital", "Valor"],
      ["TEST", "REP", "MARCA", "TEST", "Q3 2026", "PA", 999],
    ]),
    "Base",
  );
  await admin.locator('input[type="file"]').setInputFiles({
    name: "fictional-private-preview.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx" }),
  });
  await admin.getByText("Planilha validada:", { exact: false }).waitFor();
  await admin.getByRole("button", { name: "Atualizar Dashboard temporariamente" }).click();
  await admin.getByRole("status").filter({ hasText: "Prévia temporária" }).waitFor();
  await request("/__test/fail-page", { offset: 500 });
  await admin.getByRole("button", { name: "Sair", exact: true }).click();
  await ready(admin);
  assert.equal(await admin.getByRole("status").filter({ hasText: "Prévia temporária" }).count(), 0);
  await verifyValues(admin, expected(records, {}));
  assert.ok((await admin.locator("header").innerText()).includes("13.759 registros"));
  for (const name of management) assert.ok(await admin.getByRole("button", { name }).isDisabled());
  await login(admin);
  await login(visitor, "visitor");
  for (const name of management)
    assert.ok(await visitor.getByRole("button", { name }).isDisabled());
  // A permission denial after login must clear management UI, without changing the active version.
  await request("/__test/deny-management", { deny: true });
  await admin.getByRole("button", { name: "Baixar Modelo da Base" }).click();
  await admin.getByRole("alert").filter({ hasText: "permissão administrativa" }).waitFor();
  for (const name of management) assert.ok(await admin.getByRole("button", { name }).isDisabled());
  await request("/__test/deny-management", { deny: false });
  assert.equal((await rpc("dashboard_read_manifest")).manifest.import.id, version);
  await visitor.getByRole("button", { name: "Sair", exact: true }).click();
  await ready(visitor);
  await visitor.setViewportSize({ width: 390, height: 844 });
  await choose(visitor, "UF", "PA");
  await verifyValues(visitor, expected(records, { UF: ["PA"] }));
  const mobileSelections = {
    UF: ["PA"],
    Ano: ["2026"],
    Mês: ["Fevereiro"],
    "UF do Cliente": ["CE"],
  };
  for (const label of ["Ano", "Mês", "UF do Cliente"])
    await choose(visitor, label, mobileSelections[label][0]);
  await verifyValues(visitor, expected(records, mobileSelections));
  assert.ok(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const cdp = await visitor.context().newCDPSession(visitor);
  await cdp.send("Runtime.enable");
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  const beforeHeap = await cdp.send("Runtime.getHeapUsage");
  for (let cycle = 0; cycle < 3; cycle++) {
    await visitor.getByRole("button", { name: "Recarregar base compartilhada" }).click();
    await ready(visitor);
    await verifyValues(visitor, expected(records, {}));
  }
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = await cdp.send("Runtime.getHeapUsage");
  assert.ok(
    heap.usedSize - beforeHeap.usedSize < 50 * 1048576,
    "Repeated reloads must not retain complete snapshots indefinitely",
  );
  const unavailable = await newPage(true);
  await unavailable.unroute("**/servicodados.ibge.gov.br/**");
  await unavailable.route("**/servicodados.ibge.gov.br/**", (route) => route.abort());
  await unavailable.goto(base, { waitUntil: "networkidle" });
  await unavailable
    .getByText("Não foi possível carregar o mapa neste momento.", { exact: true })
    .waitFor();
  await verifyValues(unavailable, expected(records, {}));
  await unavailable.close();
  console.log(
    `PASS audit: ${scenarios.length} analytical scenarios per actor, paged 13,759/633 data, drill-down, doctor search, read failure/recovery, logout during preview, backend replay denial, role denial, mobile combined filters and provider failure. Analytical loop ${Date.now() - started} ms; visitor heap ${(beforeHeap.usedSize / 1048576).toFixed(1)} -> ${(heap.usedSize / 1048576).toFixed(1)} MiB after three reloads (local Chromium, not a production benchmark).`,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
} finally {
  await browser.close();
}
