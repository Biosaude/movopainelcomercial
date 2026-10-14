import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { createClient } from "@supabase/supabase-js";
import {
  FAT_HEADERS,
  META_HEADERS,
  aggregateMetas,
  monthlyMetas,
  normalizeMetaMonth,
  normalizeRowDate,
  parseWorkbook,
} from "../src/lib/dashboard/domain";
import {
  combineParsedFiles,
  normalizePublication,
  publicationSchema,
  type Publication,
} from "../src/lib/dashboard/shared";
import { bearerToken, publishDashboard, readDashboard } from "../src/lib/dashboard/shared.server";

const row = {
  gr: "TEST",
  rep: "REP",
  uf: "AP",
  marca: "MARCA",
  topico: "TEST",
  tipo: "TEST",
  periodo: "Q3 2026",
  valor: 123.45,
  ufHospital: "AP",
  ufCliente: "CE",
  mes: "08",
  cliente: "Cliente fictício",
  hospital: "Hospital fictício",
  medico: "Médico fictício",
  assessor: "Assessor fictício",
};
const target = {
  gr: "TEST",
  rep: "REP",
  uf: "AP",
  marca: "MARCA",
  topico: "TEST",
  tipo: "TEST",
  periodo: "Q3 2026",
  meta: 300,
  metaFinanceira: 270,
};
const publication: Publication = {
  requestId: "10000000-0000-4000-8000-000000000001",
  expectedVersion: null,
  fileName: "fictional.xlsx",
  faturamento: [row],
  metas: [target],
};

function workbook(sheets: Record<string, unknown[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}
const fat = [
  "TEST",
  "REP",
  "Assessor fictício",
  "AP",
  "MARCA",
  "TEST",
  "TEST",
  "Cliente fictício",
  "CE",
  "Hospital fictício",
  "AP",
  "Médico fictício",
  "24/08/2026",
  "08",
  "Q3 2026",
  123.45,
];
const meta = ["TEST", "REP", "AP", "MARCA", "TEST", "TEST", "Q3 2026", 300, 270];

describe("Excel persistence preserves business inputs", () => {
  test("combined template preserves dates, names, hospital UF and both targets", () => {
    const parsed = parseWorkbook(
      workbook({
        Base: [
          [...FAT_HEADERS, "", ...META_HEADERS],
          [...fat, "", ...meta],
        ],
      }),
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.faturamento[0]).toEqual({ ...row, data: "24/08/2026" });
    expect(parsed.metas[0]).toEqual({
      ...target,
      mes: undefined,
      cliente: undefined,
      medico: undefined,
      assessor: undefined,
      ufCliente: undefined,
      ufHospital: undefined,
    });
    const published = normalizePublication(
      publicationSchema.parse({
        ...publication,
        faturamento: parsed.faturamento,
        metas: parsed.metas,
      }),
    );
    const restored = JSON.parse(JSON.stringify(published));
    expect(restored.faturamento.map(normalizeRowDate)).toEqual(parsed.faturamento);
    expect(restored.metas.map(normalizeMetaMonth)).toEqual(parsed.metas);
    const quarters = aggregateMetas(restored.metas);
    const months = monthlyMetas(quarters);
    expect(months.map((m) => m.meta)).toEqual([100, 100, 100]);
    expect(months.map((m) => m.metaFinanceira)).toEqual([90, 90, 90]);
    expect(months.reduce((sum, m) => sum + m.meta, 0)).toBe(300);
  });
  test("separate workbooks keep revenue and targets without inventing absent optional columns", () => {
    const revenue = parseWorkbook(workbook({ Fat: [FAT_HEADERS, fat] }));
    const targets = parseWorkbook(workbook({ Metas: [META_HEADERS, meta] }));
    const combined = combineParsedFiles([revenue, { ...targets, errors: [] }]);
    expect(combined.faturamento).toHaveLength(1);
    expect(combined.metas).toHaveLength(1);
    expect(combined.metas[0].mes).toBeUndefined();
    expect(combined.metas[0].cliente).toBeUndefined();
    expect(combined.faturamento[0].uf).toBe("AP");
    expect(combined.faturamento[0].ufCliente).toBe("CE");
  });
  test("missing headers and invalid values are surfaced, not invented", () => {
    const bad = parseWorkbook(
      workbook({
        Base: [
          ["GR", "Período", "Valor"],
          ["TEST", "Q3 2026", "invalid"],
        ],
      }),
    );
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.faturamento).toEqual([]);
    const invalid = parseWorkbook(
      workbook({ Base: [FAT_HEADERS, [...fat.slice(0, -1), "invalid"]] }),
    );
    expect(invalid.linhasInvalidas).toBe(1);
  });
});

describe("publication validation", () => {
  test("rejects nonfinite amounts, unknown fields, missing dimensions and payload overflow", () => {
    expect(
      publicationSchema.safeParse({ ...publication, faturamento: [{ ...row, valor: Infinity }] })
        .success,
    ).toBe(false);
    expect(
      publicationSchema.safeParse({ ...publication, metas: [{ ...target, actor: "admin" }] })
        .success,
    ).toBe(false);
    expect(
      publicationSchema.safeParse({ ...publication, faturamento: [{ valor: 1 }] }).success,
    ).toBe(false);
    expect(
      publicationSchema.safeParse({ ...publication, faturamento: Array(25001).fill(row) }).success,
    ).toBe(false);
    expect(
      publicationSchema.safeParse({
        ...publication,
        faturamento: Array(4000).fill({ ...row, cliente: "X".repeat(1000) }),
      }).success,
    ).toBe(false);
  });
  test("preserves correction values and repeated revenue, without new financial formulas", () => {
    const normalized = normalizePublication(
      publicationSchema.parse({
        ...publication,
        faturamento: [{ ...row, valor: -123.45 }, row, row],
      }),
    );
    expect(normalized.faturamento.map((r) => r.valor)).toEqual([-123.45, 123.45, 123.45]);
    expect(normalized.metas[0].metaFinanceira).toBe(270);
  });
});

function sdk(
  options: {
    validToken?: boolean;
    admin?: boolean;
    conflict?: boolean;
    publicAccess?: boolean;
  } = {},
) {
  const requests: string[] = [];
  const client = createClient("https://supabase.example.test", "test-public-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        requests.push(path);
        let payload: unknown;
        let status = 200;
        if (path === "/auth/v1/user") {
          if (options.validToken === false) {
            status = 401;
            payload = { message: "Invalid JWT", code: "bad_jwt" };
          } else
            payload = { id: "00000000-0000-4000-8000-000000000001", email: "admin@example.test" };
        } else if (path.endsWith("dashboard_is_admin")) payload = options.admin ?? false;
        else if (path.endsWith("dashboard_read_snapshot"))
          payload = {
            access: options.publicAccess ?? true,
            isAdmin: false,
            snapshot: {
              import: { id: publication.requestId },
              faturamento: [row],
              metas: [target],
            },
          };
        else if (path.endsWith("dashboard_publish")) {
          const sent = JSON.parse(String(init?.body));
          expect(sent.p_faturamento).toEqual([normalizeRowDate(row)]);
          expect(sent.p_metas).toEqual([normalizeMetaMonth(target)]);
          expect(sent.p_expected_version).toBeNull();
          expect(sent.p_actor).toBeUndefined();
          if (options.conflict) {
            status = 409;
            payload = { code: "40001", message: "conflict" };
          } else payload = publication.requestId;
        } else throw new Error(`Unexpected request ${path}`);
        return new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  return { client, requests };
}
describe("backend session and authorization via real Supabase SDK", () => {
  test("public read requires no session and returns matching revenue/targets", async () => {
    const { client, requests } = sdk();
    const state = await readDashboard(client);
    expect(state.snapshot?.faturamento).toEqual([row]);
    expect(state.snapshot?.metas).toEqual([target]);
    expect(requests).toEqual(["/rest/v1/rpc/dashboard_read_snapshot"]);
  });
  test("public access revocation is respected", async () => {
    await expect(readDashboard(sdk({ publicAccess: false }).client)).rejects.toThrow(
      "leitura pública está desativada",
    );
  });
  test("missing or rejected JWT never reaches publication", async () => {
    const missing = sdk();
    await expect(publishDashboard(missing.client, undefined, publication)).rejects.toThrow(
      "Entre com uma conta",
    );
    expect(missing.requests).toEqual([]);
    const invalid = sdk({ validToken: false, admin: true });
    await expect(
      publishDashboard(invalid.client, "untrusted-test-token", publication),
    ).rejects.toThrow("Sessão inválida");
    expect(invalid.requests).toEqual(["/auth/v1/user"]);
  });
  test("authenticated non-admin never reaches publication", async () => {
    const { client, requests } = sdk({ admin: false });
    await expect(publishDashboard(client, "test-token", publication)).rejects.toThrow(
      "permissão administrativa",
    );
    expect(requests).toEqual(["/auth/v1/user", "/rest/v1/rpc/dashboard_is_admin"]);
  });
  test("admin session is remotely verified before atomic RPC, with expected version", async () => {
    const { client, requests } = sdk({ admin: true });
    expect(await publishDashboard(client, "test-token", publication)).toBe(publication.requestId);
    expect(requests).toEqual([
      "/auth/v1/user",
      "/rest/v1/rpc/dashboard_is_admin",
      "/rest/v1/rpc/dashboard_publish",
    ]);
  });
  test("stale publication reports actionable conflict", async () => {
    await expect(
      publishDashboard(sdk({ admin: true, conflict: true }).client, "test-token", publication),
    ).rejects.toThrow("Outro administrador");
  });
  test("malformed authorization headers are rejected", () => {
    expect(bearerToken(null)).toBeUndefined();
    expect(bearerToken("Bearer test-token")).toBe("test-token");
    expect(() => bearerToken("Basic test-token")).toThrow("Sessão inválida");
  });
});
