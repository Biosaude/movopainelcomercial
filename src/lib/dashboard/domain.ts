import * as XLSX from "xlsx";

export type Row = {
  rep: string; periodo: string; topico: string;
  marca: string; gr: string; uf: string; tipo: string; valor: number;
  /* Dimensões opcionais — presentes apenas quando a planilha carregada as fornece */
  mes?: string; data?: string; cliente?: string; hospital?: string; medico?: string; assessor?: string;
  ufCliente?: string; ufHospital?: string;
};
export type Meta = {
  gr: string; rep: string; uf: string; marca: string; topico: string; tipo: string; periodo: string; meta: number;
  /* Dimensões opcionais preservadas quando existirem na linha importada. */
  mes?: string; cliente?: string; medico?: string; assessor?: string;
  ufCliente?: string; ufHospital?: string;
  metaFinanceira?: number;
};

export const ALL = "Todos";
export const SEM_UF = "Não informado";

/** "Q1 2026" → "Q1" */
export const periodoQ = (p: string) =>
  (String(p ?? "").match(/Q[1-4]/i)?.[0] ?? String(p ?? "")).toUpperCase();

/** "Q1 2026" → 2026 (ou null) */
export const periodoYear = (p: string) => {
  const m = String(p ?? "").match(/20\d{2}/);
  return m ? Number(m[0]) : null;
};

export const stripAccents = (s: string) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export const normMarca = (s: string) =>
  stripAccents(String(s ?? "")).trim().toUpperCase().replace(/\s+/g, " ");
/** Normaliza siglas de UF; "SOU" é um identificador inválido observado para Amazonas na fonte comercial. */
export const normUF = (s: string) => {
  const uf = normMarca(s);
  return uf === "SOU" ? "AM" : uf;
};
export const normTipo = (s: string) => normMarca(s);

/** Código canônico do tópico: "IC- CARDIO INTERVENTIONAL" → "IC" */
export const topicoCode = (s: string) => {
  const t = stripAccents(String(s ?? "")).trim().toUpperCase().replace(/\s+/g, " ");
  if (!t) return "";
  const m = t.match(/^([A-Z0-9]+)\s*-\s*/);
  return (m ? m[1] : t.replace(/\s+/g, "")).trim();
};

/**
 * Chave canônica do representante. Além de caixa, acentos, pontuação e espaços,
 * reduz letras consecutivas repetidas para reconciliar variações ortográficas da
 * mesma abreviação sem recorrer a correspondência parcial.
 * Ex.: "ALDAIR FREIRE" e "ALDAIR F." → "ALDAIR F".
 */
export const normalizeRepresentative = (s: string) => {
  const t = stripAccents(String(s ?? ""))
    .toUpperCase().replace(/[.,]/g, " ").trim().replace(/\s+/g, " ")
    .replace(/([A-Z])\1+/g, "$1");
  if (!t) return "";
  if (t.includes("-")) return t;
  const parts = t.split(" ").filter(Boolean);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}`;
};

/** Alias mantido para os consumidores existentes da chave canônica. */
export const normRep = normalizeRepresentative;

/** "BIOSAUDE" ↔ "BIOSAUDE MATRIZ" */
export const normGR = (s: string) => {
  const t = stripAccents(String(s ?? "")).trim().toUpperCase().replace(/\s+/g, " ");
  return t === "BIOSAUDE" ? "BIOSAUDE MATRIZ" : t;
};

export const metaKey = (m: Meta) => [
  periodoQ(m.periodo), normGR(m.gr), normRep(m.rep), normUF(m.uf),
  normMarca(m.marca), topicoCode(m.topico), normTipo(m.tipo), m.mes ?? "",
  m.cliente ?? "", m.medico ?? "", m.assessor ?? "", normUF(m.ufCliente ?? ""),
  normUF(m.ufHospital ?? ""),
].join("|||");

export const fatKey = (d: Row) => [
  periodoQ(d.periodo), normGR(d.gr), normRep(d.rep), normUF(d.uf),
  normMarca(d.marca), topicoCode(d.topico), normTipo(d.tipo),
].join("|||");

/**
 * Chave de junção tolerante Faturamento × Meta: ignora "tipo" porque a base de
 * faturamento não carrega essa granularidade. Evita meta duplicada e 0% falso.
 */
export const joinKey = (r: { periodo: string; gr: string; rep: string; uf: string; marca: string; topico: string }) => [
  periodoQ(r.periodo), normGR(r.gr), normRep(r.rep), normUF(r.uf),
  normMarca(r.marca), topicoCode(r.topico),
].join("|||");

export function aggregateMetas(rows: Meta[]): Meta[] {
  const map = new Map<string, Meta>();
  rows.forEach((m) => {
    const key = metaKey(m);
    const cur = map.get(key);
    if (cur) {
      cur.meta += m.meta;
      if (m.metaFinanceira !== undefined) cur.metaFinanceira = (cur.metaFinanceira ?? 0) + m.metaFinanceira;
    } else map.set(key, { ...m });
  });
  return Array.from(map.values());
}

/* ---------------- Formatação pt-BR ---------------- */

const safe = (v: number) => (Number.isFinite(v) ? v : 0);

export const fmtBRL = (v: number) =>
  safe(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });

export const fmtBRLFull = (v: number) =>
  safe(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtCompact = (v: number) => {
  const n = safe(v);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `R$ ${(n / 1_000_000).toFixed(1).replace(".", ",")} mi`;
  if (abs >= 1_000) return `R$ ${(n / 1_000).toFixed(0)} mil`;
  return fmtBRL(n);
};

export const fmtPct = (v: number, digits = 1) =>
  `${safe(v).toFixed(digits).replace(".", ",")}%`;

export const fmtSignedPct = (v: number, digits = 1) =>
  `${safe(v) >= 0 ? "+" : ""}${fmtPct(v, digits)}`;

export const fmtInt = (v: number) => safe(v).toLocaleString("pt-BR");

/** Variação percentual segura (nunca NaN/Infinity). null = base zero. */
export const pctVar = (atual: number, anterior: number): number | null =>
  anterior > 0 ? ((atual - anterior) / anterior) * 100 : null;

/** Atingimento seguro. null = sem meta. */
export const pctAting = (fat: number, meta: number): number | null =>
  meta > 0 ? (fat / meta) * 100 : null;

/* ---------------- Cores semânticas ---------------- */
export const COLOR_2025 = "#f59e0b";  // laranja
export const COLOR_2026 = "#0f766e";  // verde/azul petróleo
export const COLOR_META = "#ef4444";  // vermelho
export const COLOR_POS = "#10b981";
export const COLOR_NEG = "#ef4444";
export const COLOR_NEUTRO = "#0284c7";
export const CHART_COLORS = [
  COLOR_2026, COLOR_2025, COLOR_NEUTRO, "#8b5cf6", "#14b8a6",
  "#ec4899", "#64748b", "#84cc16",
];

/* ---------------- Leitura de planilha ---------------- */

const FAT_ALIASES: Record<string, keyof Row> = {
  "gr": "gr", "grupo": "gr", "regiao": "gr", "região": "gr", "empresa": "gr",
  "representante": "rep", "rep": "rep", "representante/assessor": "rep",
  "uf": "uf", "estado": "uf", "uf do faturamento": "uf",
  "uf do cliente": "ufCliente", "uf cliente": "ufCliente",
  "uf do hospital": "ufHospital", "uf hospital": "ufHospital",
  "cliente": "cliente", "hospital": "hospital",
  "medico": "medico", "médico": "medico",
  "assessor": "assessor",
  "mes": "mes", "mês": "mes",
  "data": "data",
  "marca": "marca",
  "topico": "topico", "tópico": "topico", "tópico do produto": "topico", "topico do produto": "topico",
  "tipo": "tipo", "tipo do produto": "tipo", "tipo produto": "tipo",
  "periodo": "periodo", "período": "periodo", "trimestre": "periodo",
  "valor": "valor", "faturamento": "valor", "faturado": "valor",
};
const META_ALIASES: Record<string, keyof Meta> = {
  "gr": "gr", "grupo": "gr",
  "representante": "rep", "rep": "rep", "representante/assessor": "rep",
  "uf": "uf", "estado": "uf", "uf do faturamento": "uf",
  "uf do cliente": "ufCliente", "uf cliente": "ufCliente",
  "uf do hospital": "ufHospital", "uf hospital": "ufHospital",
  "cliente": "cliente", "hospital": "cliente",
  "medico": "medico", "médico": "medico",
  "assessor": "assessor",
  "mes": "mes", "mês": "mes",
  "marca": "marca", "marca do produto": "marca",
  "topico": "topico", "tópico": "topico", "tópico do produto": "topico", "topico do produto": "topico",
  "tipo": "tipo", "tipo do produto": "tipo",
  "periodo": "periodo", "período": "periodo", "trimestre": "periodo", "quarter": "periodo",
  "data": "periodo",
  "meta": "meta", "meta de venda": "meta", "meta de venda (r$)": "meta", "meta 2026": "meta",
  "meta de venda 2026": "meta", "valor (r$)": "meta", "valor": "meta",
  "meta financeira": "metaFinanceira", "meta financeira por uf": "metaFinanceira",
  "meta financeira (r$)": "metaFinanceira", "meta financeira 2026": "metaFinanceira",
};

export const FAT_HEADERS = [
  "GR", "Representante", "Assessor", "UF", "Marca", "Tópico do Produto", "Tipo do Produto",
  "Cliente", "UF do Cliente", "Hospital", "UF do Hospital", "Médico", "Data", "Mês", "Período", "Valor",
];
/**
 * No modelo exportado, a tabela de faturamento ocupa A:P, Q fica vazia e a
 * tabela de metas ocupa R:Z. A importação continua orientada pelo cabeçalho, em
 * vez de assumir posições. Na base validada, Y contém Meta e Z contém Meta
 * Financeira (fórmula Y × 90%); os valores calculados são lidos pelo cabeçalho.
 */
export const META_HEADERS = ["GR", "Representante", "UF", "Marca", "Tópico do Produto", "Tipo do Produto", "Período", "Meta", "Meta Financeira"];

const norm = (s: string) => String(s ?? "").trim().toLowerCase();

export type ParseResult = {
  faturamento: Row[];
  metas: Meta[];
  warnings: string[];
  errors: string[];
  totalLinhas: number;
  linhasValidas: number;
  linhasInvalidas: number;
  colunasDesconhecidas: string[];
};

/** Normaliza período vindo como texto, "Q1 2026", data ou serial de Excel. */
export function parsePeriodo(rawPer: unknown): string {
  if (rawPer instanceof Date) return `Q${Math.floor(rawPer.getMonth() / 3) + 1} ${rawPer.getFullYear()}`;
  const s = String(rawPer ?? "").trim();
  if (!s) return "";
  const q = s.match(/Q\s*([1-4])\s*\/?\s*(20\d{2})/i);
  if (q) return `Q${q[1]} ${q[2]}`;
  const dm = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (dm) {
    const mo = Number(dm[2]);
    const yr = Number(dm[3].length === 2 ? "20" + dm[3] : dm[3]);
    if (mo >= 1 && mo <= 12) return `Q${Math.floor((mo - 1) / 3) + 1} ${yr}`;
  }
  const my = s.match(/^(\d{1,2})[-/](20\d{2})$/);
  if (my) {
    const mo = Number(my[1]);
    if (mo >= 1 && mo <= 12) return `Q${Math.floor((mo - 1) / 3) + 1} ${my[2]}`;
  }
  return s;
}

const isPeriodoValido = (p: string) => /^Q[1-4]\s20\d{2}$/.test(p);

const toNumber = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v ?? "").trim();
  if (!s) return null;
  const cleaned = s.replace(/[R$\s.]/g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

export function parseWorkbook(file: ArrayBuffer): ParseResult {
  const wb = XLSX.read(file, { type: "array" });
  const warnings: string[] = [];
  const errors: string[] = [];
  const colunasDesconhecidas = new Set<string>();
  const faturamento: Row[] = [];
  const metas: Meta[] = [];
  let totalLinhas = 0;
  let linhasInvalidas = 0;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" }) as unknown[][];
    if (grid.length < 2) continue;
    const headerRow = (grid[0] ?? []).map((c) => String(c ?? "").trim());

    // Tabelas lado a lado separadas por colunas vazias
    const tables: { start: number; headers: string[] }[] = [];
    let i = 0;
    while (i < headerRow.length) {
      if (!headerRow[i]) { i++; continue; }
      const start = i;
      while (i < headerRow.length && headerRow[i]) i++;
      tables.push({ start, headers: headerRow.slice(start, i) });
    }

    for (const t of tables) {
      const fatMap: Partial<Record<keyof Row, number>> = {};
      const metaMap: Partial<Record<keyof Meta, number>> = {};
      t.headers.forEach((h, idx) => {
        const k = norm(h);
        const f = FAT_ALIASES[k];
        const m = META_ALIASES[k];
        if (f && fatMap[f] === undefined) fatMap[f] = t.start + idx;
        if (m && metaMap[m] === undefined) metaMap[m] = t.start + idx;
        if (!f && !m) colunasDesconhecidas.add(h);
      });

      const fatReq: (keyof Row)[] = ["gr", "rep", "marca", "topico", "periodo", "valor"];
      const isFat = fatReq.every((k) => fatMap[k] !== undefined);
      const metaReq: (keyof Meta)[] = ["gr", "rep", "marca", "topico", "periodo"];
      const isMeta = !isFat && metaReq.every((k) => metaMap[k] !== undefined)
        && (metaMap.meta !== undefined || metaMap.metaFinanceira !== undefined);

      if (isFat) {
        for (let r = 1; r < grid.length; r++) {
          const row = grid[r] ?? [];
          const gr = String(row[fatMap.gr!] ?? "").trim();
          const periodo = parsePeriodo(row[fatMap.periodo!]);
          const valor = toNumber(row[fatMap.valor!]);
          const anyContent = [fatMap.gr, fatMap.rep, fatMap.marca, fatMap.periodo, fatMap.valor]
            .some((c) => c !== undefined && String(row[c] ?? "").trim() !== "");
          if (!anyContent) continue;
          totalLinhas++;
          if (!gr || !isPeriodoValido(periodo) || valor === null) { linhasInvalidas++; continue; }
          const opt = (idx: number | undefined, upper = false) => {
            if (idx === undefined) return undefined;
            const v = String(row[idx] ?? "").trim();
            if (!v) return undefined;
            return upper ? v.toUpperCase() : v;
          };
          faturamento.push({
            gr,
            rep: String(row[fatMap.rep!] ?? "").trim(),
            uf: String(fatMap.uf !== undefined ? row[fatMap.uf] ?? "" : "").trim().toUpperCase(),
            marca: String(row[fatMap.marca!] ?? "").trim(),
            topico: String(row[fatMap.topico!] ?? "").trim(),
            tipo: String(fatMap.tipo !== undefined ? row[fatMap.tipo] ?? "" : "").trim(),
            periodo,
            valor,
            data: opt(fatMap.data as number | undefined),
            mes: opt(fatMap.mes as number | undefined),
            cliente: opt(fatMap.cliente as number | undefined),
            hospital: opt(fatMap.hospital as number | undefined),
            medico: opt(fatMap.medico as number | undefined),
            assessor: opt(fatMap.assessor as number | undefined),
            ufCliente: opt(fatMap.ufCliente as number | undefined, true),
            ufHospital: opt(fatMap.ufHospital as number | undefined, true),
          });
        }
      } else if (isMeta) {
        for (let r = 1; r < grid.length; r++) {
          const row = grid[r] ?? [];
          const rep = String(row[metaMap.rep!] ?? "").trim();
          const periodo = parsePeriodo(row[metaMap.periodo!]);
          const meta = metaMap.meta !== undefined ? toNumber(row[metaMap.meta]) : null;
          const metaFin = metaMap.metaFinanceira !== undefined ? toNumber(row[metaMap.metaFinanceira]) : null;
          const anyContent = [metaMap.gr, metaMap.rep, metaMap.marca, metaMap.periodo, metaMap.meta, metaMap.metaFinanceira]
            .some((c) => c !== undefined && String(row[c] ?? "").trim() !== "");
          if (!anyContent) continue;
          totalLinhas++;
          if (!rep || !isPeriodoValido(periodo) || (meta === null && metaFin === null)) { linhasInvalidas++; continue; }
          if ((meta ?? 0) === 0 && (metaFin ?? 0) === 0) continue;
          const optMeta = (idx: number | undefined, upper = false) => {
            if (idx === undefined) return undefined;
            const v = String(row[idx] ?? "").trim();
            if (!v) return undefined;
            return upper ? v.toUpperCase() : v;
          };
          metas.push({
            gr: String(row[metaMap.gr!] ?? "").trim(),
            rep,
            uf: String(metaMap.uf !== undefined ? row[metaMap.uf] ?? "" : "").trim().toUpperCase(),
            mes: optMeta(metaMap.mes as number | undefined),
            cliente: optMeta(metaMap.cliente as number | undefined),
            medico: optMeta(metaMap.medico as number | undefined),
            assessor: optMeta(metaMap.assessor as number | undefined),
            ufCliente: optMeta(metaMap.ufCliente as number | undefined, true),
            ufHospital: (() => {
              const idx = metaMap.ufHospital as number | undefined;
              if (idx === undefined) return undefined;
              const v = String(row[idx] ?? "").trim().toUpperCase();
              return v || undefined;
            })(),
            marca: String(row[metaMap.marca!] ?? "").trim(),
            topico: String(row[metaMap.topico!] ?? "").trim(),
            tipo: String(metaMap.tipo !== undefined ? row[metaMap.tipo] ?? "" : "").trim(),
            periodo,
            meta: meta ?? 0,
            metaFinanceira: metaFin === null ? undefined : metaFin,
          });
        }
      } else {
        warnings.push(`Aba "${sheetName}": tabela na coluna ${t.start + 1} ignorada (estrutura não reconhecida).`);
      }
    }
  }

  if (faturamento.length === 0) {
    errors.push("Nenhuma linha válida de Faturamento encontrada. Colunas obrigatórias: GR, Representante, Marca, Tópico do Produto, Período e Valor.");
  }
  if (metas.length === 0) {
    warnings.push("Nenhuma meta encontrada na planilha — o dashboard ficará sem Meta de Venda.");
  }
  if (linhasInvalidas > 0) {
    warnings.push(`${linhasInvalidas} linha(s) ignorada(s) por período inválido, valor não numérico ou campos obrigatórios vazios.`);
  }

  return {
    faturamento,
    metas: aggregateMetas(metas),
    warnings,
    errors,
    totalLinhas,
    linhasValidas: faturamento.length + metas.length,
    linhasInvalidas,
    colunasDesconhecidas: Array.from(colunasDesconhecidas),
  };
}

export function unique(arr: string[]): string[] {
  return Array.from(new Set(arr)).filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export function firstByNorm<T>(rows: T[], getter: (row: T) => string, normalizer: (value: string) => string) {
  const map = new Map<string, string>();
  rows.forEach((row) => {
    const value = getter(row);
    const key = normalizer(value);
    if (key && !map.has(key)) map.set(key, value);
  });
  return map;
}
