import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as domain from "../src/lib/dashboard/domain";
import rawFat from "../src/data/faturamento.json";
import rawMetas from "../src/data/metas.json";
import setembro from "./fixtures/setembro-filter-sample.json";

// Exercise the route's actual private predicates without changing its exports,
// loading Vite-only UI modules, or duplicating the filtering implementation.
const source = readFileSync(new URL("../src/routes/index.tsx", import.meta.url), "utf8");
const parsed = ts.createSourceFile(
  "index.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const names = new Set([
  "str",
  "NI",
  "label",
  "ufLabel",
  "anoLabel",
  "selectedMonthKeys",
  "EMPTY_FILTERS",
  "matchesFat",
  "matchesMeta",
]);
const statements = parsed.statements.filter((statement) => {
  if (ts.isFunctionDeclaration(statement)) return names.has(statement.name?.text ?? "");
  return (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(
      (declaration) => ts.isIdentifier(declaration.name) && names.has(declaration.name.text),
    )
  );
});
const compiled = ts.transpileModule(
  statements.map((statement) => statement.getText(parsed)).join("\n"),
  {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  },
).outputText;
type Filters = Record<string, string[]>;
const { EMPTY_FILTERS, matchesFat, matchesMeta } = new Function(
  ...Object.keys(domain),
  `${compiled}\nreturn { EMPTY_FILTERS, matchesFat, matchesMeta };`,
)(...Object.values(domain)) as {
  EMPTY_FILTERS: Filters;
  matchesFat: (row: domain.Row, filters: Filters, skip?: string) => boolean;
  matchesMeta: (row: domain.Meta, filters: Filters, skip?: string) => boolean;
};
const fat = (rawFat as domain.Row[]).map(domain.normalizeRowDate);
const metas = (rawMetas as domain.Meta[]).map(domain.normalizeMetaMonth);
const filters = (overrides: Filters = {}) => ({ ...EMPTY_FILTERS, ...overrides });
const sum = <T>(rows: T[], value: (row: T) => number) =>
  rows.reduce((total, row) => total + value(row), 0);

describe("filtros com a base real embarcada", () => {
  test("a fonte não contém UF nem mês; não inventa distribuição geográfica ou mensal", () => {
    expect(fat.length).toBeGreaterThan(0);
    expect(metas.length).toBeGreaterThan(0);
    expect(fat.every((row) => !row.uf && !row.mes)).toBe(true);
    expect(metas.every((row) => !row.uf && !row.mes)).toBe(true);
  });

  for (const ufs of [["AP"], ["PA"], ["AP", "PA"], ["AM"], ["CE", "MA"]]) {
    test(`UF ${ufs.join(" + ")} exclui dados sem UF de FY25, FY26, metas e rankings`, () => {
      const f = filters({ ufs });
      const rows = fat.filter((row) => matchesFat(row, f));
      const goals = metas.filter((row) => matchesMeta(row, f));
      expect(rows).toEqual([]);
      expect(goals).toEqual([]);
      expect(sum(rows, (row) => row.valor)).toBe(0);
      expect(domain.aggregateHospitalRevenue(rows).every((row) => row.value === 0)).toBe(true);
      expect(domain.pctVar(0, 0)).toBeNull();
      expect(domain.pctAting(0, 0)).toBeNull();
      for (const quarter of ["Q1", "Q2", "Q3"]) {
        expect(
          fat.filter((row) => matchesFat(row, filters({ ufs, trimestres: [quarter] }))),
        ).toEqual([]);
        expect(
          metas.filter((row) => matchesMeta(row, filters({ ufs, trimestres: [quarter] }))),
        ).toEqual([]);
      }
      expect(fat.filter((row) => matchesFat(row, filters({ ufs, meses: ["Agosto"] })))).toEqual([]);
      expect(metas.filter((row) => matchesMeta(row, filters({ ufs, meses: ["Agosto"] })))).toEqual(
        [],
      );
    });
  }

  test("Todos e limpar filtros preservam os totais gerais sem restringir UF", () => {
    expect(fat.filter((row) => matchesFat(row, filters()))).toEqual(fat);
    expect(metas.filter((row) => matchesMeta(row, filters()))).toEqual(metas);
    expect(fat.filter((row) => matchesFat(row, filters({ ufs: [] })))).toEqual(fat);
    expect(metas.filter((row) => matchesMeta(row, filters({ ufs: [] })))).toEqual(metas);
  });

  for (const quarter of ["Q1", "Q2", "Q3", "Q4"]) {
    test(`${quarter} mantém faturamento e metas exatamente no trimestre da fonte`, () => {
      const f = filters({ trimestres: [quarter] });
      const rows = fat.filter((row) => matchesFat(row, f));
      const goals = metas.filter((row) => matchesMeta(row, f));
      expect(rows).toEqual(fat.filter((row) => domain.periodoQ(row.periodo) === quarter));
      expect(goals).toEqual(metas.filter((row) => domain.periodoQ(row.periodo) === quarter));
      expect(sum(goals, (row) => row.meta)).toBe(
        sum(
          metas.filter((row) => row.periodo === `${quarter} 2026`),
          (row) => row.meta,
        ),
      );
    });
  }

  test("mês sem dados não reaproveita metas trimestrais", () => {
    for (const month of domain.MONTHS_PT) {
      expect(fat.filter((row) => matchesFat(row, filters({ meses: [month] })))).toEqual([]);
      expect(metas.filter((row) => matchesMeta(row, filters({ meses: [month] })))).toEqual([]);
    }
  });

  test("ano, GR, marca e representante continuam combináveis usando dimensões reais", () => {
    const seed = fat[0];
    const f = filters({
      anos: [String(domain.periodoYear(seed.periodo))],
      trimestres: [domain.periodoQ(seed.periodo)],
      grs: [domain.normGR(seed.gr)],
      marcas: [domain.normMarca(seed.marca)],
      reps: [seed.rep],
    });
    const expected = fat.filter(
      (row) =>
        row.periodo === seed.periodo &&
        domain.normGR(row.gr) === domain.normGR(seed.gr) &&
        domain.normMarca(row.marca) === domain.normMarca(seed.marca) &&
        domain.normRep(row.rep) === domain.normRep(seed.rep),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(fat.filter((row) => matchesFat(row, f))).toEqual(expected);
  });

  test("UF principal não substitui UF do Cliente ou UF do Hospital", () => {
    for (const key of ["ufs", "ufsCliente", "ufsHospital"]) {
      const f = filters({ [key]: ["AP"] });
      expect(fat.filter((row) => matchesFat(row, f))).toEqual([]);
      expect(fat.filter((row) => matchesFat(row, f, key))).toEqual(fat);
      for (const other of ["ufs", "ufsCliente", "ufsHospital"].filter((other) => other !== key)) {
        expect(fat.filter((row) => matchesFat(row, f, other))).toEqual([]);
      }
    }
  });
});

describe("metas sem multiplicação por registros operacionais", () => {
  test("a agregação mantém os totais e todas as dimensões da fonte real", () => {
    const aggregated = domain.aggregateMetas(metas);
    expect(aggregated).toHaveLength(metas.length);
    expect(sum(aggregated, (row) => row.meta)).toBe(sum(metas, (row) => row.meta));
    expect(sum(aggregated, (row) => row.metaFinanceira ?? 0)).toBe(
      sum(metas, (row) => row.metaFinanceira ?? 0),
    );
  });

  test("repetir a mesma linha real de meta não duplica MV ou MF", () => {
    const aggregated = domain.aggregateMetas([...metas, ...metas]);
    expect(aggregated).toHaveLength(metas.length);
    expect(sum(aggregated, (row) => row.meta)).toBe(sum(metas, (row) => row.meta));
    expect(sum(aggregated, (row) => row.metaFinanceira ?? 0)).toBe(
      sum(metas, (row) => row.metaFinanceira ?? 0),
    );
    expect(metas).toEqual((rawMetas as domain.Meta[]).map(domain.normalizeMetaMonth));
  });
});

describe("Estado do Hospital e metas mensais com amostra real de setembro", () => {
  const rows = (setembro.fat as domain.Row[]).map(domain.normalizeRowDate);
  const goals = domain.aggregateMetas(setembro.metas as domain.Meta[]);

  test("a UF principal deriva do Hospital, preservando a UF do Cliente", () => {
    expect(rows.every((r) => r.uf === domain.normUF(r.ufHospital ?? ""))).toBe(true);
    const cross = rows.find((r) => r.ufCliente !== r.ufHospital)!;
    expect(cross).toBeDefined();
    expect(matchesFat(cross, filters({ ufs: [cross.ufHospital!] }))).toBe(true);
    expect(matchesFat(cross, filters({ ufs: [cross.ufCliente!] }))).toBe(false);
    expect(matchesFat(cross, filters({ ufsCliente: [cross.ufCliente!] }))).toBe(true);
    expect(matchesFat(cross, filters({ ufsCliente: [cross.ufHospital!] }))).toBe(false);
    expect(setembro.fat.every((r) => r.uf === "")).toBe(true);
  });

  test("AP + PA consolida exatamente os dois estados, em todos os Quarters", () => {
    for (const quarter of ["Q1", "Q2", "Q3", "Q4"]) {
      const total = (ufs: string[]) => {
        const f = filters({ ufs, trimestres: [quarter] });
        return {
          fat: sum(
            rows.filter((r) => matchesFat(r, f)),
            (r) => r.valor,
          ),
          mv: sum(
            goals.filter((m) => matchesMeta(m, f)),
            (m) => m.meta,
          ),
          mf: sum(
            goals.filter((m) => matchesMeta(m, f)),
            (m) => m.metaFinanceira ?? 0,
          ),
        };
      };
      const ap = total(["AP"]),
        pa = total(["PA"]),
        both = total(["AP", "PA"]);
      for (const key of ["fat", "mv", "mf"] as const)
        expect(both[key]).toBeCloseTo(ap[key] + pa[key], 6);
      expect(both.mv).toBeGreaterThan(0);
      expect(both.mf).toBeGreaterThan(0);
    }
  });

  test("Agosto usa somente faturamento do mês e 1/3 das metas de Q3 por Estado", () => {
    const monthly = domain.monthlyMetas(goals);
    for (const ufs of [["AP"], ["PA"], ["AP", "PA"]]) {
      const f = filters({ ufs, meses: ["Agosto"] });
      const quarter = goals.filter((m) => ufs.includes(m.uf) && m.periodo === "Q3 2026");
      const selected = monthly.filter((m) => matchesMeta(m, f));
      expect(sum(selected, (m) => m.meta)).toBeCloseTo(sum(quarter, (m) => m.meta) / 3, 6);
      expect(sum(selected, (m) => m.metaFinanceira ?? 0)).toBeCloseTo(
        sum(quarter, (m) => m.metaFinanceira ?? 0) / 3,
        6,
      );
      expect(rows.filter((r) => matchesFat(r, f))).toEqual(
        rows.filter((r) => ufs.includes(r.uf) && r.mes === "08"),
      );
    }
  });

  test("selecionar todas as UFs e limpar preserva o resultado geral", () => {
    const all = domain.unique([...rows.map((r) => r.uf), ...goals.map((m) => m.uf)]);
    expect(rows.filter((r) => matchesFat(r, filters({ ufs: all })))).toEqual(rows);
    expect(goals.filter((m) => matchesMeta(m, filters({ ufs: all })))).toEqual(goals);
    expect(rows.filter((r) => matchesFat(r, filters()))).toEqual(rows);
  });
});
