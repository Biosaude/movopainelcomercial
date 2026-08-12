import {
  type Meta, type Row, fatKey, metaKey, normGR, normMarca, normRep, normTipo, normUF,
  pctAting, pctVar, periodoQ, periodoYear, topicoCode,
} from "./domain";

export type DrillScope = {
  gr?: string; uf?: string; marca?: string; topico?: string;
  tipo?: string; rep?: string; periodo?: string;
};

export type DrillRow = {
  periodo: string; gr: string; rep: string; uf: string;
  marca: string; topico: string; tipo: string;
  fat25: number; fat26: number; meta: number;
  ating: number | null; varPct: number | null; gap: number;
};

type Bucket = Omit<DrillRow, "ating" | "varPct" | "gap">;

/**
 * Monta o detalhamento respeitando o recorte clicado. Faturamento e Meta são
 * agrupados pela MESMA chave canônica (período · GR · rep · UF · marca · tópico
 * · tipo), de modo que a meta nunca é somada mais de uma vez.
 */
export function buildDrillRows(fat: Row[], metas: Meta[], scope: DrillScope): DrillRow[] {
  const grK = scope.gr ? normGR(scope.gr) : null;
  const ufK = scope.uf ? normUF(scope.uf) : null;
  const marcaK = scope.marca ? normMarca(scope.marca) : null;
  const topicoK = scope.topico ? topicoCode(scope.topico) : null;
  const tipoK = scope.tipo ? normTipo(scope.tipo) : null;
  const repK = scope.rep ? normRep(scope.rep) : null;
  const perK = scope.periodo ? periodoQ(scope.periodo) : null;

  const match = (r: { gr: string; uf: string; marca: string; topico: string; tipo: string; rep: string; periodo: string }) =>
    (!grK || normGR(r.gr) === grK) &&
    (!ufK || normUF(r.uf) === ufK) &&
    (!marcaK || normMarca(r.marca) === marcaK) &&
    (!topicoK || topicoCode(r.topico) === topicoK) &&
    (!tipoK || normTipo(r.tipo) === tipoK) &&
    (!repK || normRep(r.rep) === repK) &&
    (!perK || periodoQ(r.periodo) === perK);

  const buckets = new Map<string, Bucket>();
  const ensure = (key: string, seed: Bucket) => {
    const cur = buckets.get(key);
    if (cur) return cur;
    buckets.set(key, seed);
    return seed;
  };

  fat.filter(match).forEach((d) => {
    const b = ensure(fatKey(d), {
      periodo: periodoQ(d.periodo), gr: d.gr, rep: d.rep, uf: d.uf || "—",
      marca: d.marca, topico: d.topico, tipo: d.tipo?.trim() || "—",
      fat25: 0, fat26: 0, meta: 0,
    });
    if (periodoYear(d.periodo) === 2025) b.fat25 += d.valor;
    else if (periodoYear(d.periodo) === 2026) b.fat26 += d.valor;
  });

  metas.filter(match).forEach((m) => {
    const b = ensure(metaKey(m), {
      periodo: periodoQ(m.periodo), gr: m.gr, rep: m.rep, uf: m.uf || "—",
      marca: m.marca, topico: m.topico, tipo: m.tipo?.trim() || "—",
      fat25: 0, fat26: 0, meta: 0,
    });
    b.meta += m.meta;
  });

  return Array.from(buckets.values())
    .map((b) => ({
      ...b,
      ating: pctAting(b.fat26, b.meta),
      varPct: pctVar(b.fat26, b.fat25),
      gap: b.fat26 - b.meta,
    }))
    .sort((a, b) => (b.fat26 + b.meta) - (a.fat26 + a.meta));
}
