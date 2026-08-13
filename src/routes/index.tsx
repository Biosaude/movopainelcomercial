import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, LabelList, Legend, Line,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  AlertCircle, Award, Building2, CheckCircle2, DollarSign, Filter as FilterIcon, Flag,
  MapPin, Package, Search, Stethoscope, Target, TrendingDown, TrendingUp, Users,
} from "lucide-react";
import rawFaturamento from "../data/faturamento.json";
import rawMetas from "../data/metas.json";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MultiSelectFilter } from "@/components/dashboard/MultiSelectFilter";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { BaseManagement, type LastUpdate } from "@/components/dashboard/BaseManagement";
import { DrillDownDialog } from "@/components/dashboard/DrillDownDialog";
import { BrazilHospitalMap, isBrazilUF } from "@/components/dashboard/BrazilHospitalMap";
import { buildDrillRows, type DrillScope } from "@/lib/dashboard/drilldown";
import {
  ALL, CHART_COLORS, COLOR_2025, COLOR_2026, COLOR_META, SEM_UF,
  type Meta, type Row,
  fmtBRL, fmtBRLFull, fmtCompact, fmtInt, fmtPct, fmtSignedPct,
  joinKey, normGR, normMarca, normRep, normTipo, normUF, stripAccents,
  pctAting, pctVar, periodoQ, periodoYear, topicoCode, unique,
} from "@/lib/dashboard/domain";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard Comercial Biosaude · Faturamento e Metas" },
      { name: "description", content: "Visão executiva FY25 vs FY26, meta de venda, cobertura e rankings por GR, representante, assessor, marca, tópico, cliente, médico e UF." },
      { property: "og:title", content: "Dashboard Comercial Biosaude" },
      { property: "og:description", content: "FY25 vs FY26, Meta 2026, cobertura, rankings e análise de médicos por tópico do produto." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const str = (v: unknown) => String(v ?? "").trim();

const INITIAL_FAT: Row[] = (rawFaturamento as Array<Record<string, unknown>>).map((r) => ({
  gr: str(r.gr),
  rep: str(r.rep),
  marca: str(r.marca),
  uf: str(r.uf),
  topico: str(r.topico),
  tipo: str(r.tipo),
  periodo: str(r.periodo),
  valor: Number(r.valor) || 0,
  data: str(r.data) || undefined,
  mes: str(r.mes) || undefined,
  cliente: str(r.cliente) || undefined,
  hospital: str(r.hospital) || undefined,
  medico: str(r.medico) || undefined,
  assessor: str(r.assessor) || undefined,
  ufCliente: str(r.ufCliente) || undefined,
  ufHospital: str(r.ufHospital) || undefined,
}));
const INITIAL_METAS: Meta[] = (rawMetas as Array<Record<string, unknown>>).map((m) => ({
  gr: str(m.gr), rep: str(m.rep), marca: str(m.marca), uf: str(m.uf),
  topico: str(m.topico), tipo: str(m.tipo), periodo: str(m.periodo), meta: Number(m.meta) || 0,
  ufHospital: str(m.ufHospital) || undefined,
  mes: str(m.mes) || undefined,
  cliente: str(m.cliente) || undefined,
  medico: str(m.medico) || undefined,
  assessor: str(m.assessor) || undefined,
  ufCliente: str(m.ufCliente) || undefined,
  metaFinanceira: m.metaFinanceira === undefined || m.metaFinanceira === null || m.metaFinanceira === ""
    ? undefined : Number(m.metaFinanceira) || 0,
}));

const LS_FAT = "biosaude.fat.representante.v2";
const LS_METAS = "biosaude.metas.representante.v2";
const LS_LAST_UPDATE = "biosaude.lastUpdate.v1";

function loadLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as T) : fallback;
  } catch { return fallback; }
}
function loadLastUpdate(): LastUpdate | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LS_LAST_UPDATE);
    if (!raw) return null;
    const p = JSON.parse(raw) as { when: string; fileName: string; count: number; metaCount: number };
    return { ...p, when: new Date(p.when) };
  } catch { return null; }
}

/* ---------------- Filtros ---------------- */

type Filters = {
  anos: string[]; trimestres: string[]; meses: string[];
  grs: string[]; ufs: string[]; ufsCliente: string[]; ufsHospital: string[];
  marcas: string[]; topicos: string[]; tipos: string[];
  clientes: string[]; medicos: string[]; reps: string[]; assessores: string[];
};
const EMPTY_FILTERS: Filters = {
  anos: [], trimestres: [], meses: [], grs: [], ufs: [], ufsCliente: [], ufsHospital: [],
  marcas: [], topicos: [], tipos: [], clientes: [], medicos: [], reps: [], assessores: [],
};
type FilterKey = keyof Filters;

const NI = "Não informado";
const label = (v?: string) => (str(v) ? str(v) : NI);
const ufLabel = (uf?: string) => (str(uf) ? normUF(str(uf)) : SEM_UF);
const anoLabel = (periodo: string) => {
  const y = periodoYear(periodo);
  return y === null ? NI : String(y);
};

/** Dimensões que só existem na base de faturamento (metas não têm essa granularidade). */
const FAT_ONLY: FilterKey[] = ["meses", "ufsCliente", "ufsHospital", "clientes", "medicos", "assessores"];

function matchesFat(r: Row, f: Filters, skip?: FilterKey) {
  const has = (key: FilterKey, values: string[], value: string) =>
    skip === key || values.length === 0 || values.includes(value);
  return (
    has("anos", f.anos, anoLabel(r.periodo)) &&
    has("trimestres", f.trimestres, periodoQ(r.periodo)) &&
    has("meses", f.meses, label(r.mes)) &&
    has("grs", f.grs, normGR(r.gr)) &&
    (skip === "ufs" || f.ufs.length === 0 || !str(r.uf) || f.ufs.includes(ufLabel(r.uf))) &&
    has("ufsCliente", f.ufsCliente, ufLabel(r.ufCliente)) &&
    has("ufsHospital", f.ufsHospital, ufLabel(r.ufHospital)) &&
    has("marcas", f.marcas.map(normMarca), normMarca(r.marca)) &&
    has("topicos", f.topicos.map(topicoCode), topicoCode(r.topico)) &&
    has("tipos", f.tipos.map(normTipo), normTipo(label(r.tipo))) &&
    has("clientes", f.clientes, label(r.cliente)) &&
    has("medicos", f.medicos, label(r.medico)) &&
    has("assessores", f.assessores, label(r.assessor)) &&
    has("reps", f.reps.map(normRep), normRep(r.rep))
  );
}

function matchesMeta(m: Meta, f: Filters, skip?: FilterKey) {
  const has = (key: FilterKey, values: string[], value: string) =>
    skip === key || values.length === 0 || values.includes(value);
  return (
    has("anos", f.anos, anoLabel(m.periodo)) &&
    has("trimestres", f.trimestres, periodoQ(m.periodo)) &&
    (skip === "meses" || f.meses.length === 0 || !str(m.mes) || f.meses.includes(label(m.mes))) &&
    has("grs", f.grs, normGR(m.gr)) &&
    has("ufs", f.ufs, ufLabel(m.uf)) &&
    (skip === "ufsCliente" || f.ufsCliente.length === 0 || !str(m.ufCliente) || f.ufsCliente.includes(ufLabel(m.ufCliente))) &&
    (skip === "ufsHospital" || f.ufsHospital.length === 0 || !str(m.ufHospital) || f.ufsHospital.includes(ufLabel(m.ufHospital))) &&
    has("marcas", f.marcas.map(normMarca), normMarca(m.marca)) &&
    has("topicos", f.topicos.map(topicoCode), topicoCode(m.topico)) &&
    has("tipos", f.tipos.map(normTipo), normTipo(label(m.tipo))) &&
    (skip === "clientes" || f.clientes.length === 0 || !str(m.cliente) || f.clientes.includes(label(m.cliente))) &&
    (skip === "medicos" || f.medicos.length === 0 || !str(m.medico) || f.medicos.includes(label(m.medico))) &&
    (skip === "assessores" || f.assessores.length === 0 || !str(m.assessor) || f.assessores.includes(label(m.assessor))) &&
    has("reps", f.reps.map(normRep), normRep(m.rep))
  );
}

const FILTER_LABELS: Record<FilterKey, string> = {
  anos: "Ano", trimestres: "Trimestre", meses: "Mês", grs: "GR", ufs: "UF",
  ufsCliente: "UF do Cliente", ufsHospital: "UF do Hospital", marcas: "Marca",
  topicos: "Tópico do Produto", tipos: "Tipo do Produto", clientes: "Cliente",
  medicos: "Médico", reps: "Representante", assessores: "Assessor",
};

/* ---------------- UI helpers ---------------- */

function EmptyState({ message, height = 240 }: { message: string; height?: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground px-4" style={{ height }}>
      <AlertCircle className="h-5 w-5 opacity-60" />
      {message}
    </div>
  );
}

const tooltipStyle = { background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 };

type RankItem = { name: string; value: number };

function RankingCard({
  title, icon: Icon, items, color, empty, onSelect,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  items: RankItem[];
  color: string;
  empty: string;
  onSelect?: (name: string) => void;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary shrink-0" />
          <span className="truncate">{title}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        {items.length === 0 ? (
          <EmptyState message={empty} height={220} />
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(220, items.length * 26)}>
            <BarChart data={items} layout="vertical" margin={{ left: 4, right: 34, top: 4, bottom: 4 }}>
              <XAxis type="number" hide />
              <YAxis
                type="category" dataKey="name" width={92}
                tick={{ fontSize: 9 }} interval={0}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: number) => [fmtBRLFull(v), "Faturamento FY26"]}
              />
              <Bar dataKey="value" fill={color} radius={[0, 3, 3, 0]} cursor={onSelect ? "pointer" : undefined}
                onClick={(e: { name?: string }) => e?.name && onSelect?.(e.name)}>
                <LabelList dataKey="value" position="right" formatter={(v: number) => fmtCompact(v)} className="fill-muted-foreground" fontSize={9} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

function ClientRankingCard({ items }: { items: RankItem[] }) {
  const max = items[0]?.value ?? 0;
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary shrink-0" />
          <span className="truncate">Ranking de Clientes</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-2">
        {items.length === 0 ? (
          <EmptyState message="A base atual não possui a dimensão Cliente." height={220} />
        ) : (
          <ol className="space-y-2 py-1">
            {items.map((c, i) => (
              <li key={c.name} className="grid grid-cols-[20px_minmax(0,1fr)_72px] items-center gap-2 text-[11px]" title={`${c.name} · ${fmtBRLFull(c.value)}`}>
                <span className="text-center font-semibold text-primary tabular-nums">{i + 1}</span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">{c.name}</span>
                  <span className="mt-1 block h-2 rounded bg-muted">
                    <span className="block h-2 rounded bg-primary" style={{ width: `${max > 0 ? (c.value / max) * 100 : 0}%` }} />
                  </span>
                </span>
                <span className="text-right text-[10px] font-medium tabular-nums text-muted-foreground">{fmtCompact(c.value)}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

type TooltipRenderProps = {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ payload?: unknown }>;
};

/* ---------------- Página ---------------- */

function Dashboard() {
  const [data, setData] = useState<Row[]>(() => loadLS<Row[]>(LS_FAT, INITIAL_FAT));
  const [metasData, setMetasData] = useState<Meta[]>(() => loadLS<Meta[]>(LS_METAS, INITIAL_METAS));
  const [lastUpdate, setLastUpdateState] = useState<LastUpdate | null>(() => loadLastUpdate());
  const [f, setF] = useState<Filters>(EMPTY_FILTERS);
  const [drill, setDrill] = useState<{ title: string; scope: DrillScope } | null>(null);
  const [showAllTopicos, setShowAllTopicos] = useState(false);
  const [topicoSel, setTopicoSel] = useState<string | null>(null);
  const [medicoQuery, setMedicoQuery] = useState("");

  const setLastUpdate = (v: LastUpdate | null) => {
    setLastUpdateState(v);
    try {
      if (v) window.localStorage.setItem(LS_LAST_UPDATE, JSON.stringify({ ...v, when: v.when.toISOString() }));
      else window.localStorage.removeItem(LS_LAST_UPDATE);
    } catch { /* ignore */ }
  };
  const set = (key: FilterKey) => (v: string[]) => setF((prev) => ({ ...prev, [key]: v }));
  const clearFilters = () => { setF(EMPTY_FILTERS); setTopicoSel(null); setMedicoQuery(""); };

  /* --------- Universo filtrado --------- */
  const filtered = useMemo(() => data.filter((d) => matchesFat(d, f)), [data, f]);

  const filteredMetas = useMemo(() => {
    const base = metasData.filter((m) => matchesMeta(m, f));
    const metasComUfHospital = metasData.some((m) => str(m.ufHospital));
    const fatOnlyKeys = metasComUfHospital ? FAT_ONLY.filter((k) => k !== "ufsHospital") : FAT_ONLY;
    const fatOnlyActive = fatOnlyKeys.some((k) => f[k].length > 0);
    if (!fatOnlyActive) return base;
    const keys = new Set(filtered.map((d) => joinKey(d)));
    return base.filter((m) => keys.has(joinKey(m)));
  }, [metasData, f, filtered]);

  const filtered2026 = useMemo(() => filtered.filter((d) => periodoYear(d.periodo) === 2026), [filtered]);
  const fat2025Rows = useMemo(() => filtered.filter((d) => periodoYear(d.periodo) === 2025), [filtered]);

  /* --------- Opções (dependentes dos demais filtros) --------- */
  const optionsFor = (key: FilterKey, getter: (r: Row) => string) =>
    unique(data.filter((d) => matchesFat(d, f, key)).map(getter));

  const anoOptions = useMemo(() => optionsFor("anos", (r) => anoLabel(r.periodo)).filter((a) => a !== NI), [data, f]);
  const trimestreOptions = useMemo(() => optionsFor("trimestres", (r) => periodoQ(r.periodo)), [data, f]);
  const mesOptions = useMemo(() => optionsFor("meses", (r) => label(r.mes)).filter((m) => m !== NI), [data, f]);
  const grOptions = useMemo(() => {
    const fromMetas = metasData.filter((m) => matchesMeta(m, f, "grs")).map((m) => normGR(m.gr));
    return unique([...optionsFor("grs", (r) => normGR(r.gr)), ...fromMetas]);
  }, [data, metasData, f]);
  const ufOptions = useMemo(() => {
    const fromFat = optionsFor("ufs", (r) => ufLabel(r.uf));
    const fromMetas = metasData
      .filter((m) => matchesMeta(m, f, "ufs") && str(m.uf))
      .map((m) => ufLabel(m.uf));
    return unique([...fromFat, ...fromMetas]).filter((u) => u !== SEM_UF);
  }, [data, metasData, f]);
  const ufClienteOptions = useMemo(() => optionsFor("ufsCliente", (r) => ufLabel(r.ufCliente)).filter((u) => u !== SEM_UF), [data, f]);
  const ufHospitalOptions = useMemo(() => {
    const fromMetas = metasData
      .filter((m) => matchesMeta(m, f, "ufsHospital") && str(m.ufHospital))
      .map((m) => ufLabel(m.ufHospital));
    return unique([...optionsFor("ufsHospital", (r) => ufLabel(r.ufHospital)), ...fromMetas]).filter((u) => u !== SEM_UF);
  }, [data, metasData, f]);
  const marcaOptions = useMemo(() => optionsFor("marcas", (r) => normMarca(r.marca)), [data, f]);
  const tipoOptions = useMemo(() => optionsFor("tipos", (r) => label(r.tipo)), [data, f]);
  const clienteOptions = useMemo(() => optionsFor("clientes", (r) => label(r.cliente)).filter((c) => c !== NI), [data, f]);
  const medicoOptions = useMemo(() => optionsFor("medicos", (r) => label(r.medico)).filter((c) => c !== NI), [data, f]);
  const assessorOptions = useMemo(() => optionsFor("assessores", (r) => label(r.assessor)).filter((c) => c !== NI), [data, f]);
  const topicoOptions = useMemo(() => {
    const byCode = new Map<string, string>();
    const consider = (raw: string) => {
      const code = topicoCode(raw);
      if (!code) return;
      const cur = byCode.get(code);
      if (!cur || raw.length > cur.length) byCode.set(code, raw.trim());
    };
    data.forEach((d) => { if (matchesFat(d, f, "topicos")) consider(d.topico); });
    metasData.forEach((m) => { if (matchesMeta(m, f, "topicos")) consider(m.topico); });
    return Array.from(byCode.values()).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [data, metasData, f]);
  const repOptions = useMemo(() => {
    const byKey = new Map<string, string>();
    const consider = (raw: string) => {
      const r = str(raw);
      const k = normRep(r);
      if (!k) return;
      const cur = byKey.get(k);
      if (!cur || r.length > cur.length) byKey.set(k, r);
    };
    data.forEach((d) => { if (matchesFat(d, f, "reps")) consider(d.rep); });
    metasData.forEach((m) => { if (matchesMeta(m, f, "reps")) consider(m.rep); });
    return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [data, metasData, f]);

  const activeFilters = useMemo(
    () => (Object.entries(f) as [FilterKey, string[]][]).filter(([, v]) => v.length > 0),
    [f],
  );

  /* --------- KPIs --------- */
  const fat2025 = fat2025Rows.reduce((s, d) => s + d.valor, 0);
  const fat2026 = filtered2026.reduce((s, d) => s + d.valor, 0);
  const metaTotal = filteredMetas.reduce((s, m) => s + m.meta, 0);

  const fatByJoinKey = useMemo(() => {
    const m = new Map<string, { fat25: number; fat26: number }>();
    filtered.forEach((d) => {
      const k = joinKey(d);
      const cur = m.get(k) || { fat25: 0, fat26: 0 };
      if (periodoYear(d.periodo) === 2025) cur.fat25 += d.valor;
      else if (periodoYear(d.periodo) === 2026) cur.fat26 += d.valor;
      m.set(k, cur);
    });
    return m;
  }, [filtered]);
  const metasByJoinKey = useMemo(() => {
    const m = new Map<string, number>();
    filteredMetas.forEach((mt) => m.set(joinKey(mt), (m.get(joinKey(mt)) || 0) + mt.meta));
    return m;
  }, [filteredMetas]);
  const fat2026ComMeta = useMemo(() => {
    let total = 0;
    metasByJoinKey.forEach((_, k) => { total += fatByJoinKey.get(k)?.fat26 || 0; });
    return total;
  }, [metasByJoinKey, fatByJoinKey]);

  const diffAbs = fat2026 - fat2025;
  const diffPct = pctVar(fat2026, fat2025);
  const coberturaMV = pctAting(fat2026, metaTotal);
  const gapMeta = metaTotal > 0 ? fat2026ComMeta - metaTotal : 0;

  /* --------- Séries --------- */
  const metasFinanceirasFiltradas = useMemo(
    () => filteredMetas.filter((m) => periodoYear(m.periodo) === 2026 && m.metaFinanceira !== undefined),
    [filteredMetas],
  );
  const metaFinanceira2026 = metasFinanceirasFiltradas.reduce((total, m) => total + (m.metaFinanceira ?? 0), 0);
  const coberturaMF = pctAting(fat2026, metaFinanceira2026);

  const byPeriodo = useMemo(() => {
    const m = new Map<string, { p: string; v2025: number; v2026: number; meta: number; metaFinanceira: number }>();
    const ensure = (q: string) => {
      const cur = m.get(q) || { p: q, v2025: 0, v2026: 0, meta: 0, metaFinanceira: 0 };
      m.set(q, cur);
      return cur;
    };
    ["Q1", "Q2", "Q3", "Q4"].forEach(ensure);
    filtered.forEach((d) => {
      const cur = ensure(periodoQ(d.periodo));
      if (periodoYear(d.periodo) === 2025) cur.v2025 += d.valor;
      else if (periodoYear(d.periodo) === 2026) cur.v2026 += d.valor;
    });
    filteredMetas.forEach((mt) => { ensure(periodoQ(mt.periodo)).meta += mt.meta; });
    metasFinanceirasFiltradas.forEach((mt) => { ensure(periodoQ(mt.periodo)).metaFinanceira += mt.metaFinanceira ?? 0; });
    return Array.from(m.values()).sort((a, b) => a.p.localeCompare(b.p));
  }, [filtered, filteredMetas, metasFinanceirasFiltradas]);

  const byGR = useMemo(() => {
    const m = new Map<string, number>();
    filtered2026.forEach((d) => m.set(normGR(d.gr), (m.get(normGR(d.gr)) || 0) + d.valor));
    return Array.from(m, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filtered2026]);

  const rank = (getter: (d: Row) => string | undefined, limit: number): RankItem[] => {
    const m = new Map<string, number>();
    filtered2026.forEach((d) => {
      const raw = str(getter(d));
      if (!raw) return;
      m.set(raw, (m.get(raw) || 0) + d.valor);
    });
    return Array.from(m, ([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value).slice(0, limit);
  };

  const topMarcas = useMemo(() => rank((d) => normMarca(d.marca), 10), [filtered2026]);
  const topReps = useMemo(() => {
    const m = new Map<string, { label: string; value: number }>();
    filtered2026.forEach((d) => {
      const k = normRep(d.rep);
      if (!k) return;
      const cur = m.get(k) || { label: d.rep || k, value: 0 };
      if ((d.rep?.length ?? 0) > cur.label.length) cur.label = d.rep;
      cur.value += d.valor;
      m.set(k, cur);
    });
    return Array.from(m.values()).map((v) => ({ name: v.label, value: v.value }))
      .sort((a, b) => b.value - a.value).slice(0, 12);
  }, [filtered2026]);
  const topAssessores = useMemo(() => rank((d) => d.assessor, 12), [filtered2026]);
  const topClientes = useMemo(() => rank((d) => d.cliente, 10), [filtered2026]);
  const topMedicos = useMemo(() => rank((d) => d.medico, 12), [filtered2026]);

  const repPerformance = useMemo(() => {
    const fatMap = new Map<string, number>();
    const metaMap = new Map<string, { meta: number; label: string }>();
    const repJoinKeys = new Map<string, Set<string>>();
    filteredMetas.forEach((m) => {
      const k = normRep(m.rep);
      const cur = metaMap.get(k) || { meta: 0, label: m.rep };
      cur.meta += m.meta;
      cur.label = m.rep.length > cur.label.length ? m.rep : cur.label;
      metaMap.set(k, cur);
      const s = repJoinKeys.get(k) || new Set<string>();
      s.add(joinKey(m));
      repJoinKeys.set(k, s);
    });
    repJoinKeys.forEach((s, k) => {
      let total = 0;
      s.forEach((jk) => { total += fatByJoinKey.get(jk)?.fat26 || 0; });
      fatMap.set(k, total);
    });
    filtered2026.forEach((d) => {
      const k = normRep(d.rep);
      if (!metaMap.has(k)) fatMap.set(k, (fatMap.get(k) || 0) + d.valor);
    });
    const keys = new Set<string>([...fatMap.keys(), ...metaMap.keys()]);
    return Array.from(keys).map((k) => {
      const meta = metaMap.get(k)?.meta || 0;
      const fat = fatMap.get(k) || 0;
      return { name: metaMap.get(k)?.label || k, fat, meta, ating: pctAting(fat, meta), gap: fat - meta };
    }).sort((a, b) => b.fat - a.fat).slice(0, 10);
  }, [filtered2026, filteredMetas, fatByJoinKey]);

  const byTopico = useMemo(() => {
    const m = new Map<string, { name: string; code: string; value: number; medicos: Set<string>; itens: number }>();
    filtered2026.forEach((d) => {
      const code = topicoCode(d.topico);
      if (!code) return;
      const cur = m.get(code) || { name: d.topico || code, code, value: 0, medicos: new Set<string>(), itens: 0 };
      if ((d.topico?.length ?? 0) > cur.name.length) cur.name = d.topico;
      cur.value += d.valor;
      cur.itens += 1;
      if (str(d.medico)) cur.medicos.add(str(d.medico));
      m.set(code, cur);
    });
    return Array.from(m.values())
      .map((t) => ({ ...t, medicosCount: t.medicos.size }))
      .sort((a, b) => b.value - a.value);
  }, [filtered2026]);
  const topicosVisiveis = showAllTopicos ? byTopico : byTopico.slice(0, 10);
  const topicoChartHeight = Math.max(300, topicosVisiveis.length * 34);

  const byTipo = useMemo(() => {
    const m = new Map<string, number>();
    filtered2026.forEach((d) => m.set(label(d.tipo), (m.get(label(d.tipo)) || 0) + d.valor));
    return Array.from(m, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filtered2026]);

  const byUFGeneric = (getter: (d: Row) => string | undefined) => {
    const m = new Map<string, number>();
    filtered2026.forEach((d) => {
      const uf = str(getter(d));
      if (!uf) return;
      m.set(normUF(uf), (m.get(normUF(uf)) || 0) + d.valor);
    });
    return Array.from(m, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  };
  const byUFCliente = useMemo(() => byUFGeneric((d) => d.ufCliente), [filtered2026]);
  const hospitalMapData = useMemo(() => {
    const values = new Map<string, number>();
    let outsideValue = 0;
    let outsideRecords = 0;
    filtered2026.forEach((row) => {
      const uf = normUF(str(row.ufHospital));
      if (!isBrazilUF(uf)) {
        outsideValue += row.valor;
        outsideRecords += 1;
        return;
      }
      values.set(uf, (values.get(uf) ?? 0) + row.valor);
    });
    const rows = Array.from(values, ([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    const representedValue = rows.reduce((total, item) => total + item.value, 0);
    return {
      rows,
      outsideRecords,
      outsideValue,
      reconciled: Math.abs(representedValue + outsideValue - fat2026) < 0.01,
    };
  }, [filtered2026, fat2026]);
  const byUFHospital = hospitalMapData.rows;
  const topUFHospital = byUFHospital.slice(0, 5);

  /** Realizado FY26 × Meta de Venda por UF do Hospital. */
  const ufHospitalPerformance = useMemo(() => {
    const map = new Map<string, { name: string; fat: number; meta: number }>();
    const ensure = (uf: string) => {
      const cur = map.get(uf) || { name: uf, fat: 0, meta: 0 };
      map.set(uf, cur);
      return cur;
    };
    filtered2026.forEach((d) => {
      const uf = str(d.ufHospital);
      if (!uf) return;
      ensure(normUF(uf)).fat += d.valor;
    });
    filteredMetas.forEach((m) => {
      const uf = str(m.ufHospital);
      if (!uf) return;
      ensure(normUF(uf)).meta += m.meta;
    });
    return Array.from(map.values())
      .map((v) => ({ ...v, ating: pctAting(v.fat, v.meta), gap: v.fat - v.meta }))
      .sort((a, b) => (b.meta || b.fat) - (a.meta || a.fat));
  }, [filtered2026, filteredMetas]);

  /* --------- Médicos por tópico --------- */
  const topicoAtivo = topicoSel && byTopico.some((t) => t.code === topicoSel) ? topicoSel : byTopico[0]?.code ?? null;
  const medicoRows = useMemo(() => {
    if (!topicoAtivo) return [];
    const q = stripAccents(medicoQuery).trim().toUpperCase();
    const m = new Map<string, {
      medico: string; rep: string; marca: string; topico: string; tipo: string;
      cliente: string; ufCliente: string; valor: number;
    }>();
    filtered2026.forEach((d) => {
      if (topicoCode(d.topico) !== topicoAtivo) return;
      const key = [d.medico, d.rep, d.marca, d.topico, d.tipo, d.cliente, d.ufCliente].map((v) => str(v)).join("|");
      const cur = m.get(key) || {
        medico: label(d.medico), rep: label(d.rep), marca: label(d.marca),
        topico: d.topico || topicoAtivo, tipo: label(d.tipo),
        cliente: label(d.cliente), ufCliente: str(d.ufCliente) ? normUF(str(d.ufCliente)) : NI,
        valor: 0,
      };
      cur.valor += d.valor;
      m.set(key, cur);
    });
    let rows = Array.from(m.values()).sort((a, b) => b.valor - a.valor);
    if (q) rows = rows.filter((r) => stripAccents(r.medico).toUpperCase().includes(q));
    return rows;
  }, [filtered2026, topicoAtivo, medicoQuery]);
  const temMedico = useMemo(() => data.some((d) => str(d.medico)), [data]);

  /* --------- Tabela analítica --------- */
  const tabelaRows = useMemo(() => buildDrillRows(filtered, filteredMetas, {}).slice(0, 300), [filtered, filteredMetas]);

  /* --------- Reconciliação --------- */
  const reconc = useMemo(() => {
    const sum = (arr: { value: number }[]) => arr.reduce((s, r) => s + r.value, 0);
    const somaGR = sum(byGR);
    const somaTipo = sum(byTipo);
    const somaTopico = byTopico.reduce((s, t) => s + t.value, 0);
    const tol = 1;
    return {
      somaGR, somaTipo, somaTopico,
      ok: Math.abs(somaGR - fat2026) < tol && Math.abs(somaTipo - fat2026) < tol && Math.abs(somaTopico - fat2026) < tol,
    };
  }, [byGR, byTipo, byTopico, fat2026]);

  /* --------- Base --------- */
  const handleApply = (rows: Row[], newMetas: Meta[]) => {
    setData(rows);
    setMetasData(newMetas);
    try {
      window.localStorage.setItem(LS_FAT, JSON.stringify(rows));
      window.localStorage.setItem(LS_METAS, JSON.stringify(newMetas));
    } catch (e) {
      console.warn("Não foi possível persistir a base no navegador:", e);
    }
    clearFilters();
  };

  const openDrill = (title: string, scope: DrillScope = {}) => setDrill({ title, scope });

  const evolutionTooltip = ({ active, payload, label: lbl }: TooltipRenderProps) => {
    if (!active || !payload?.length) return null;
    const d = (payload[0].payload ?? {}) as { v2025: number; v2026: number; meta: number };
    const v = pctVar(d.v2026, d.v2025);
    const a = pctAting(d.v2026, d.meta);
    return (
      <div className="rounded-md border bg-card p-3 text-xs shadow-md space-y-1">
        <p className="font-semibold text-sm">{lbl}</p>
        <p><span className="text-muted-foreground">FY 25: </span>{fmtBRLFull(d.v2025)}</p>
        <p><span className="text-muted-foreground">FY 26: </span>{fmtBRLFull(d.v2026)}</p>
        <p><span className="text-muted-foreground">Meta 2026: </span>{d.meta > 0 ? fmtBRLFull(d.meta) : "Sem meta"}</p>
        <p><span className="text-muted-foreground">Variação: </span>{v === null ? "—" : fmtSignedPct(v)}</p>
        <p><span className="text-muted-foreground">Cobertura: </span>{a === null ? "Sem meta" : fmtPct(a)}</p>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="bg-card border-b sticky top-0 z-30">
        <div className="max-w-[1600px] mx-auto px-6 py-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold tracking-tight">Dashboard Comercial · Biosaude</h1>
            <p className="truncate text-xs text-muted-foreground">
              FY 25 vs FY 26 · Meta de Venda 2026 · Cobertura · Rankings · Médicos por Tópico
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5 text-xs">
            <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
            <div>
              <div className="font-semibold text-foreground">Última atualização da base</div>
              <div className="text-muted-foreground">
                {lastUpdate
                  ? `${lastUpdate.when.toLocaleString("pt-BR")} · ${lastUpdate.fileName} · ${fmtInt(lastUpdate.count)} registros`
                  : `Base embarcada · ${fmtInt(data.length)} registros`}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-5 space-y-4">
        {/* 1 · FILTROS */}
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <FilterIcon className="h-4 w-4 text-primary" />
                Filtros
                {activeFilters.length > 0 ? (
                  <span className="text-xs font-medium bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                    {activeFilters.length} ativo{activeFilters.length > 1 ? "s" : ""}
                  </span>
                ) : (
                  <span className="text-xs font-normal text-muted-foreground">Exibindo {ALL.toLowerCase()} os registros</span>
                )}
              </div>
              <button onClick={clearFilters} className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
                Limpar filtros
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
              <MultiSelectFilter label="Ano" selected={f.anos} options={anoOptions} onChange={set("anos")} />
              <MultiSelectFilter label="Trimestre" selected={f.trimestres} options={trimestreOptions} onChange={set("trimestres")} />
              <MultiSelectFilter label="Mês" selected={f.meses} options={mesOptions} onChange={set("meses")} />
              <MultiSelectFilter label="GR" selected={f.grs} options={grOptions} onChange={set("grs")} />
              <MultiSelectFilter label="UF" selected={f.ufs} options={ufOptions} onChange={set("ufs")} />
              <MultiSelectFilter label="UF do Cliente" selected={f.ufsCliente} options={ufClienteOptions} onChange={set("ufsCliente")} />
              <MultiSelectFilter label="UF do Hospital" selected={f.ufsHospital} options={ufHospitalOptions} onChange={set("ufsHospital")} />
              <MultiSelectFilter label="Marca" selected={f.marcas} options={marcaOptions} onChange={set("marcas")} />
              <MultiSelectFilter label="Tópico do Produto" selected={f.topicos} options={topicoOptions} onChange={set("topicos")} />
              <MultiSelectFilter label="Tipo do Produto" selected={f.tipos} options={tipoOptions} onChange={set("tipos")} />
              <MultiSelectFilter label="Cliente" selected={f.clientes} options={clienteOptions} onChange={set("clientes")} />
              <MultiSelectFilter label="Médico" selected={f.medicos} options={medicoOptions} onChange={set("medicos")} />
              <MultiSelectFilter label="Representante" selected={f.reps} options={repOptions} onChange={set("reps")} />
              <MultiSelectFilter label="Assessor" selected={f.assessores} options={assessorOptions} onChange={set("assessores")} />
            </div>
            {activeFilters.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t">
                {activeFilters.map(([key, values]) => (
                  <span key={key} className="text-[11px] bg-primary/10 text-primary rounded px-2 py-0.5">
                    <b>{FILTER_LABELS[key]}</b>: {values.length <= 2 ? values.join(", ") : `${values.length} selecionados`}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* 2 · KPIs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <KpiCard
            title="FY 25" value={fmtCompact(fat2025)} tooltip={fmtBRLFull(fat2025)}
            icon={DollarSign} sub={`${fmtInt(fat2025Rows.length)} registros`} accent="info"
            onClick={() => openDrill("Detalhe · FY 25")}
          />
          <KpiCard
            title="FY 26" value={fmtCompact(fat2026)} tooltip={fmtBRLFull(fat2026)}
            icon={TrendingUp} sub={`${fmtInt(filtered2026.length)} registros`} accent="primary"
            footer={
              <span className={diffPct === null ? "text-muted-foreground" : diffPct >= 0 ? "text-emerald-600" : "text-red-600"}>
                {diffPct === null ? "Sem FY 25 no recorte" : `${fmtSignedPct(diffPct)} vs FY 25`}
              </span>
            }
            onClick={() => openDrill("Detalhe · FY 26")}
          />
          <KpiCard
            title="MV FY 2026" value={fmtCompact(metaTotal)} tooltip={metaTotal > 0 ? fmtBRLFull(metaTotal) : "Sem meta cadastrada para esta combinação"}
            icon={Target} accent="warning"
            sub={metaTotal > 0 ? `${fmtInt(filteredMetas.length)} metas no recorte` : "Sem meta"}
            onClick={() => openDrill("Detalhe · Meta de Venda 2026")}
          />
          <KpiCard
            title="Meta Financeira 2026"
            value={metaFinanceira2026 > 0 ? fmtCompact(metaFinanceira2026) : "Sem meta"}
            tooltip={metaFinanceira2026 > 0 ? fmtBRLFull(metaFinanceira2026) : "Sem meta financeira cadastrada para 2026"}
            icon={DollarSign}
            accent="info"
            sub={`${fmtInt(metasFinanceirasFiltradas.length)} registros no recorte`}
          />
          <KpiCard
            title="Cobertura MV" value={coberturaMV === null ? "Sem meta" : fmtPct(coberturaMV, 2)}
            icon={Flag} accent={coberturaMV === null ? "info" : coberturaMV >= 100 ? "success" : coberturaMV >= 70 ? "warning" : "danger"}
            sub={`FY 26 ${fmtCompact(fat2026)} · MV ${fmtCompact(metaTotal)}`}
            tooltip={coberturaMV === null ? "Sem meta cadastrada para esta combinação" : `${fmtBRLFull(fat2026)} de ${fmtBRLFull(metaTotal)}`}
            onClick={() => openDrill("Detalhe · Cobertura da Meta")}
          />
          <KpiCard
            title="Cobertura MF" value={coberturaMF === null ? "Sem meta" : fmtPct(coberturaMF, 2)}
            icon={Flag} accent={coberturaMF === null ? "info" : coberturaMF >= 100 ? "success" : coberturaMF >= 70 ? "warning" : "danger"}
            sub={`FY 26 ${fmtCompact(fat2026)} · MF ${fmtCompact(metaFinanceira2026)}`}
            tooltip={coberturaMF === null ? "Sem MF cadastrada para esta combinação" : `${fmtBRLFull(fat2026)} de ${fmtBRLFull(metaFinanceira2026)}`}
          />
          <KpiCard
            title="Diferença 25 / 26" value={`${diffAbs >= 0 ? "+" : "-"}${fmtCompact(Math.abs(diffAbs))}`}
            tooltip={fmtBRLFull(diffAbs)} icon={diffAbs >= 0 ? TrendingUp : TrendingDown}
            sub={diffPct === null ? "Sem FY 25 no recorte" : `${fmtSignedPct(diffPct)} de variação`}
            accent={diffAbs >= 0 ? "success" : "danger"}
            onClick={() => openDrill("Detalhe · Diferença 25 / 26")}
          />
          <KpiCard
            title="Gap para Meta"
            value={metaTotal > 0 ? `${gapMeta >= 0 ? "+" : "-"}${fmtCompact(Math.abs(gapMeta))}` : "Sem meta"}
            tooltip={metaTotal > 0 ? fmtBRLFull(gapMeta) : "Sem meta cadastrada para esta combinação"}
            icon={Target}
            sub={metaTotal === 0 ? "Sem meta" : gapMeta >= 0 ? `${fmtCompact(gapMeta)} acima da meta` : `Faltam ${fmtCompact(Math.abs(gapMeta))}`}
            accent={metaTotal === 0 ? "info" : gapMeta >= 0 ? "success" : "danger"}
            onClick={() => openDrill("Detalhe · Gap para a Meta")}
          />
        </div>

        {/* 3 · Evolução trimestral */}
        <div>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Evolução FY 25 vs FY 26 por Trimestre · Meta de Venda 2026</CardTitle></CardHeader>
            <CardContent>
              {filtered.length === 0 ? (
                <EmptyState message="Não há dados para os filtros selecionados." height={300} />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={byPeriodo} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                    <XAxis dataKey="p" className="text-xs" />
                    <YAxis tickFormatter={fmtCompact} className="text-xs" width={80} />
                    <Tooltip content={evolutionTooltip} />
                    <Legend />
                    <Bar dataKey="v2025" name="FY 25" fill={COLOR_2025} radius={[4, 4, 0, 0]} cursor="pointer"
                      onClick={(e: { p?: string }) => e?.p && openDrill(`Detalhe · ${e.p}`, { periodo: e.p })} />
                    <Bar dataKey="v2026" name="FY 26" fill={COLOR_2026} radius={[4, 4, 0, 0]} cursor="pointer"
                      onClick={(e: { p?: string }) => e?.p && openDrill(`Detalhe · ${e.p}`, { periodo: e.p })} />
                    <Line type="monotone" dataKey="meta" name="Meta de Venda 2026" stroke={COLOR_META} strokeWidth={2.5} dot={{ r: 4 }} />
                    <Line type="monotone" dataKey="metaFinanceira" name="Meta Financeira 2026" stroke="#7c3aed" strokeWidth={2.5} dot={{ r: 4 }} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

        </div>

        {/* 4 · FY 26 por GR */}
        <div>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">FY 26 por GR</CardTitle></CardHeader>
            <CardContent>
              {byGR.length === 0 ? (
                <EmptyState message="Não há dados para os filtros selecionados." />
              ) : (
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={byGR} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={95}
                      label={({ percent }: { percent?: number }) => `${(((percent ?? 0) * 100)).toFixed(0)}%`}
                      onClick={(e: { name?: string }) => e?.name && openDrill(`Detalhe · ${e.name}`, { gr: e.name })}
                      cursor="pointer"
                    >
                      {byGR.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [fmtBRLFull(v), n]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </div>


        {/* 5 · Rankings */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
          <RankingCard title="Ranking de Marcas" icon={Package} items={topMarcas} color={COLOR_2026}
            empty="Não há dados para os filtros selecionados."
            onSelect={(name) => openDrill(`Detalhe · ${name}`, { marca: name })} />
          <RankingCard title="Ranking de Representantes" icon={Users} items={topReps} color="#f59e0b"
            empty="Não há dados para os filtros selecionados."
            onSelect={(name) => openDrill(`Detalhe · ${name}`, { rep: name })} />
          <RankingCard title="Ranking de Assessores" icon={Award} items={topAssessores} color="#14b8a6"
            empty="A base atual não possui a dimensão Assessor." />
          <ClientRankingCard items={topClientes} />
          <RankingCard title="Ranking de Médicos" icon={Stethoscope} items={topMedicos} color="#f97316"
            empty="A base atual não possui a dimensão Médico." />
        </div>

        {/* Faturamento × Meta por Representante (mantido) */}
        <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Faturamento FY 26 × Meta de Venda por Representante</CardTitle></CardHeader>
          <CardContent>
            {repPerformance.length === 0 ? (
              <EmptyState message="Não há dados para os filtros selecionados." />
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(280, repPerformance.length * 34)}>
                <BarChart data={repPerformance} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                  <XAxis type="number" tickFormatter={fmtCompact} className="text-xs" />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 10 }} interval={0} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [fmtBRLFull(v), n]} />
                  <Legend />
                  <Bar dataKey="fat" name="FY 26" fill={COLOR_2026} radius={[0, 3, 3, 0]} cursor="pointer"
                    onClick={(e: { name?: string }) => e?.name && openDrill(`Detalhe · ${e.name}`, { rep: e.name })} />
                  <Bar dataKey="meta" name="Meta de Venda" fill={COLOR_META} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Faturamento × Meta de Venda por UF do Hospital */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Faturamento FY 26 × Meta de Venda por UF do Hospital</CardTitle></CardHeader>
          <CardContent>
            {ufHospitalPerformance.length === 0 ? (
              <EmptyState message="Sem UF do Hospital na base atual. Envie a planilha com a coluna 'UF do Hospital' para habilitar esta análise." />
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(280, ufHospitalPerformance.length * 34)}>
                <BarChart data={ufHospitalPerformance} layout="vertical" margin={{ left: 8, right: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                  <XAxis type="number" tickFormatter={fmtCompact} className="text-xs" />
                  <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 10 }} interval={0} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [fmtBRLFull(v), n]} />
                  <Legend />
                  <Bar dataKey="fat" name="FY 26" fill={COLOR_2026} radius={[0, 3, 3, 0]} cursor="pointer"
                    onClick={(e: { name?: string }) => e?.name && openDrill(`Detalhe · UF do Hospital ${e.name}`)} />
                  <Bar dataKey="meta" name="Meta de Venda" fill={COLOR_META} radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* 6 · Faturamento por Tópico do Produto */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-base">Faturamento por Tópico do Produto</CardTitle>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{fmtInt(byTopico.length)} itens</span>
              {byTopico.length > 10 && (
                <button className="font-medium text-primary hover:underline" onClick={() => setShowAllTopicos((v) => !v)}>
                  {showAllTopicos ? "Ver Top 10" : "Ver todos"}
                </button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {byTopico.length === 0 ? (
              <EmptyState message="Não há dados para os filtros selecionados." />
            ) : (
              <div className="max-h-[520px] overflow-y-auto">
                <ResponsiveContainer width="100%" height={topicoChartHeight}>
                  <BarChart data={topicosVisiveis} layout="vertical" margin={{ left: 8, right: 60 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" horizontal={false} />
                    <XAxis type="number" tickFormatter={fmtCompact} className="text-xs" />
                    <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 10 }} interval={0} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtBRLFull(v), "FY 26"]} />
                    <Bar dataKey="value" fill="#8b5cf6" radius={[0, 4, 4, 0]} cursor="pointer"
                      onClick={(e: { name?: string }) => e?.name && openDrill(`Detalhe · ${e.name}`, { topico: e.name })}>
                      <LabelList dataKey="value" position="right" formatter={(v: number) => fmtCompact(v)} fontSize={10} className="fill-muted-foreground" />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* 7 · UF do Cliente / UF do Hospital / UF */}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><MapPin className="h-4 w-4 text-primary" />Faturamento por UF do Cliente</CardTitle></CardHeader>
            <CardContent>
              {byUFCliente.length === 0 ? (
                <EmptyState message="A base atual não possui a dimensão UF do Cliente." />
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={byUFCliente} margin={{ top: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} />
                    <YAxis tickFormatter={fmtCompact} className="text-xs" width={80} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [fmtBRLFull(v), "FY 26"]} />
                    <Bar dataKey="value" fill={COLOR_2026} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card data-map-reconciled={hospitalMapData.reconciled} data-map-outside-records={hospitalMapData.outsideRecords}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2"><MapPin className="h-4 w-4 text-primary" />Faturamento FY26 por UF do Hospital</CardTitle>
              <p className="text-xs text-muted-foreground">Distribuição geográfica do faturamento por estado</p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_180px] items-center gap-4">
                <BrazilHospitalMap data={byUFHospital} />
                <div className="min-w-0">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Top 5 UFs</p>
                  <ol className="space-y-2">
                    {topUFHospital.map((item, index) => (
                      <li key={item.name} className="grid grid-cols-[20px_28px_1fr] items-center gap-1 text-xs">
                        <span className="text-muted-foreground">{index + 1}.</span><b>{item.name}</b>
                        <span className="text-right tabular-nums">{fmtCompact(item.value)}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 8 · Médicos por Tópico do Produto */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Stethoscope className="h-4 w-4 text-primary" />
              Médicos por Tópico do Produto
            </CardTitle>
            <span className="text-xs text-muted-foreground">{fmtInt(medicoRows.length)} registros</span>
          </CardHeader>
          <CardContent className="space-y-3">
            {!temMedico && (
              <p className="text-xs text-muted-foreground">
                A base atual não possui a dimensão Médico — a análise abaixo exibe o recorte por tópico com “{NI}”
                até que uma planilha com a coluna Médico seja carregada.
              </p>
            )}
            {byTopico.length === 0 ? (
              <EmptyState message="Não há dados para os filtros selecionados." />
            ) : (
              <>
                <p className="text-xs text-muted-foreground">Selecione um tópico para consultar médicos, representantes, clientes e faturamento no recorte atual.</p>
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {byTopico.map((t) => {
                    const active = t.code === topicoAtivo;
                    return (
                      <button
                        key={t.code}
                        onClick={() => setTopicoSel(t.code)}
                        className={`shrink-0 w-[190px] rounded-lg border p-3 text-left transition-colors ${active ? "border-primary bg-primary/5" : "bg-card hover:bg-muted/60"}`}
                      >
                        <div className="truncate text-xs font-semibold" title={t.name}>{t.name}</div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>{t.medicosCount > 0 ? `${fmtInt(t.medicosCount)} médicos` : `${fmtInt(t.itens)} registros`}</span>
                          <span className="font-medium text-foreground">{fmtCompact(t.value)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">
                    Tópico selecionado: <b className="text-foreground">{byTopico.find((t) => t.code === topicoAtivo)?.name ?? "—"}</b>
                  </span>
                  <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                    <Search className="h-3.5 w-3.5 text-muted-foreground" />
                    <input
                      value={medicoQuery}
                      onChange={(e) => setMedicoQuery(e.target.value)}
                      placeholder="Pesquisar médico…"
                      className="w-[200px] bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                </div>

                <div className="max-h-[380px] overflow-auto rounded-md border">
                  <table className="w-full min-w-[900px] text-xs">
                    <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                      <tr className="text-left">
                        {["Médico", "Representante", "Marca", "Tópico do Produto", "Tipo de Produto", "Cliente", "UF do Cliente"].map((h) => (
                          <th key={h} className="px-3 py-2 font-semibold">{h}</th>
                        ))}
                        <th className="px-3 py-2 text-right font-semibold">Faturamento FY 2026</th>
                      </tr>
                    </thead>
                    <tbody>
                      {medicoRows.length === 0 ? (
                        <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">Não há dados para os filtros selecionados.</td></tr>
                      ) : medicoRows.slice(0, 300).map((r, i) => (
                        <tr key={i} className="border-t hover:bg-muted/40">
                          <td className="px-3 py-1.5 font-medium">{r.medico}</td>
                          <td className="px-3 py-1.5">{r.rep}</td>
                          <td className="px-3 py-1.5">{r.marca}</td>
                          <td className="px-3 py-1.5 text-primary">{r.topico}</td>
                          <td className="px-3 py-1.5">{r.tipo}</td>
                          <td className="px-3 py-1.5 max-w-[240px] truncate" title={r.cliente}>{r.cliente}</td>
                          <td className="px-3 py-1.5">{r.ufCliente}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtBRL(r.valor)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* 9 · Tabela analítica detalhada */}
        <Card>
          <CardHeader className="pb-2 flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-base">Tabela Analítica Detalhada</CardTitle>
            <span className="text-xs text-muted-foreground">{fmtInt(tabelaRows.length)} linhas exibidas</span>
          </CardHeader>
          <CardContent>
            {tabelaRows.length === 0 ? (
              <EmptyState message="Não há dados para os filtros selecionados." />
            ) : (
              <div className="max-h-[420px] overflow-auto rounded-md border">
                <table className="w-full min-w-[1000px] text-xs">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr className="text-left">
                      {["Período", "GR", "Representante", "UF", "Marca", "Tópico", "Tipo"].map((h) => (
                        <th key={h} className="px-3 py-2 font-semibold">{h}</th>
                      ))}
                      {["FY 25", "FY 26", "Meta 2026", "Cobertura", "Var. 25/26"].map((h) => (
                        <th key={h} className="px-3 py-2 text-right font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tabelaRows.map((r, i) => (
                      <tr key={i} className="border-t hover:bg-muted/40">
                        <td className="px-3 py-1.5">{r.periodo}</td>
                        <td className="px-3 py-1.5">{r.gr}</td>
                        <td className="px-3 py-1.5">{r.rep}</td>
                        <td className="px-3 py-1.5">{r.uf}</td>
                        <td className="px-3 py-1.5">{r.marca}</td>
                        <td className="px-3 py-1.5 max-w-[200px] truncate" title={r.topico}>{r.topico}</td>
                        <td className="px-3 py-1.5">{r.tipo}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtBRL(r.fat25)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{fmtBRL(r.fat26)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.meta > 0 ? fmtBRL(r.meta) : "Sem meta"}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.ating === null ? "Sem meta" : fmtPct(r.ating)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${r.varPct === null ? "" : r.varPct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                          {r.varPct === null ? "—" : fmtSignedPct(r.varPct)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Reconciliação */}
        <Card>
          <CardContent className="p-4 text-xs flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className={`inline-flex items-center gap-2 font-semibold ${reconc.ok ? "text-emerald-600" : "text-amber-600"}`}>
              {reconc.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
              Reconciliação {reconc.ok ? "OK" : "com divergência"}
            </span>
            <span><span className="text-muted-foreground">KPI FY 26: </span><b>{fmtBRLFull(fat2026)}</b></span>
            <span><span className="text-muted-foreground">Soma GR: </span>{fmtBRLFull(reconc.somaGR)}</span>
            <span><span className="text-muted-foreground">Soma Tópico: </span>{fmtBRLFull(reconc.somaTopico)}</span>
            <span><span className="text-muted-foreground">Soma Tipo: </span>{fmtBRLFull(reconc.somaTipo)}</span>
          </CardContent>
        </Card>

        {/* Gerenciamento da base (preservado) */}
        <BaseManagement
          current={data}
          currentMetas={metasData}
          onApply={handleApply}
          lastUpdate={lastUpdate}
          setLastUpdate={setLastUpdate}
        />
      </main>

      <DrillDownDialog
        drill={drill}
        fat={filtered}
        metas={filteredMetas}
        onClose={() => setDrill(null)}
      />
    </div>
  );
}
