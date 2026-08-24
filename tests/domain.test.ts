import { describe, expect, test } from "bun:test";
import { aggregateHospitalRevenue, HOSPITAL_RANKING_UFS, monthLabel, normalizeMetaMonth, normalizeMonth, normalizeRowDate, sortMonths, type Row } from "../src/lib/dashboard/domain";

const row = (overrides: Partial<Row>): Row => ({
  gr: "GR", rep: "REP", marca: "MARCA", uf: "CE", topico: "TOPICO",
  tipo: "TIPO", periodo: "Q3 2026", valor: 1, ...overrides,
});

describe("ranking de faturamento por UF do Hospital", () => {
  test("agrega somente as 12 UFs, ordena dinamicamente e mantém zeros", () => {
    const result = aggregateHospitalRevenue([
      row({ ufHospital: "PA", valor: 10 }),
      row({ ufHospital: "AP", valor: 30 }),
      row({ ufHospital: "PA", valor: 25 }),
      row({ ufHospital: "SP", valor: 1_000 }),
    ]);

    expect(result).toHaveLength(HOSPITAL_RANKING_UFS.length);
    expect(result.slice(0, 2)).toEqual([{ name: "PA", value: 35 }, { name: "AP", value: 30 }]);
    expect(result.find(({ name }) => name === "PB")?.value).toBe(0);
    expect(result.some(({ name }) => name === "SP")).toBe(false);
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
