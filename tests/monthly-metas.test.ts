import { describe, expect, test } from "bun:test";
import {
  aggregateMetas,
  monthlyMetas,
  normalizeMetaMonth,
  type Meta,
} from "../src/lib/dashboard/domain";
import rawMetas from "../src/data/metas.json";

describe("rateio mensal autorizado das metas reais", () => {
  const metas = aggregateMetas((rawMetas as Meta[]).map(normalizeMetaMonth));
  const monthly = monthlyMetas(metas);

  test("cada Quarter gera seus três meses com MV e MF divididas por três", () => {
    expect(monthly).toHaveLength(metas.length * 3);
    for (let index = 0; index < metas.length; index++) {
      const source = metas[index];
      const quarter = Number(source.periodo[1]);
      const months = monthly.slice(index * 3, index * 3 + 3);
      expect(months.map((m) => m.mes)).toEqual(
        Array.from({ length: 3 }, (_, i) => String((quarter - 1) * 3 + i + 1).padStart(2, "0")),
      );
      for (const month of months) {
        expect(month.meta).toBe(source.meta / 3);
        expect(month.metaFinanceira).toBe(
          source.metaFinanceira === undefined ? undefined : source.metaFinanceira / 3,
        );
        expect(month.uf).toBe(source.uf);
        expect(month.gr).toBe(source.gr);
      }
      expect(months.reduce((total, m) => total + m.meta, 0)).toBeCloseTo(source.meta, 6);
    }
  });

  test("os totais anuais são conservados e metas mensais explícitas não duplicam o rateio", () => {
    const sum = (rows: Meta[]) => rows.reduce((total, m) => total + m.meta, 0);
    expect(sum(monthly)).toBeCloseTo(sum(metas), 5);
    const withExplicitMonths = monthlyMetas([...metas, ...monthly]);
    expect(withExplicitMonths).toEqual(monthly);
    expect(sum(withExplicitMonths)).toBeCloseTo(sum(metas), 5);
    expect(rawMetas.every((m) => !("mes" in m))).toBe(true);
  });
});
