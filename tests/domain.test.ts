import { describe, expect, test } from "bun:test";
import { matchesUF, monthLabel, normalizeMetaMonth, normalizeMonth, normalizeRowDate, sortMonths, type Row } from "../src/lib/dashboard/domain";

const row = (overrides: Partial<Row>): Row => ({
  gr: "GR", rep: "REP", marca: "MARCA", uf: "CE", topico: "TOPICO",
  tipo: "TIPO", periodo: "Q3 2026", valor: 1, ...overrides,
});

describe("filtro da UF principal", () => {
  const values = ["AP", "PA", "AM", "", undefined];

  test("mantém Todos irrestrito e aplica uma única UF de forma estrita", () => {
    expect(values.filter((uf) => matchesUF([], uf))).toEqual(values);
    expect(values.filter((uf) => matchesUF(["AP"], uf))).toEqual(["AP"]);
    expect(values.filter((uf) => matchesUF(["PA"], uf))).toEqual(["PA"]);
  });

  test("consolida somente as UFs selecionadas e normaliza os valores", () => {
    expect(values.filter((uf) => matchesUF(["AP", "PA"], uf))).toEqual(["AP", "PA"]);
    expect(matchesUF(["am"], " AM ")).toBe(true);
    expect(matchesUF(["AP", "PA", "AM"], "")).toBe(false);
  });
});

describe("normalização mensal", () => {
  test("reconhece números, nomes, abreviações e datas com uma única chave", () => {
    for (const value of [8, "08", "Agosto", "AGOSTO", "ago", "ago.", "24/08/2026", "2026-08-24", new Date(2026, 7, 24)]) {
      expect(normalizeMonth(value)).toBe("08");
    }
  });

  test("prioriza Mês válido e usa Data somente como fallback", () => {
    expect(normalizeRowDate(row({ mes: "mar", data: "24/08/2026" })).mes).toBe("03");
    expect(normalizeRowDate(row({ mes: "inconsistente", data: "24/08/2026" })).mes).toBe("08");
    expect(normalizeRowDate(row({ mes: "", data: "46257" })).mes).toBe(normalizeMonth("46257"));
  });

  test("normaliza Meta.mes e mantém a apresentação cronológica em português", () => {
    const meta = normalizeMetaMonth({
      gr: "GR", rep: "REP", uf: "CE", marca: "MARCA", topico: "TOPICO",
      tipo: "TIPO", periodo: "Q3 2026", meta: 1, mes: "AGO",
    });
    expect(meta.mes).toBe("08");
    expect(monthLabel(meta.mes)).toBe("Agosto");
    expect(sortMonths(["Dezembro", "Março", "Janeiro", "08"])).toEqual(["Janeiro", "Março", "Agosto", "Dezembro"]);
  });
});
