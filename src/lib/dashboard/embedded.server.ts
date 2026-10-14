import rawFaturamento from "../../data/faturamento.json";
import rawMetas from "../../data/metas.json";
import { normalizeRowDate, normalizeMetaMonth, type Row, type Meta } from "./domain";
const str = (v: unknown) => String(v ?? "").trim();

export const INITIAL_FAT: Row[] = (rawFaturamento as Array<Record<string, unknown>>).map((r) =>
  normalizeRowDate({
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
  }),
);
export const INITIAL_METAS: Meta[] = (rawMetas as Array<Record<string, unknown>>).map((m) =>
  normalizeMetaMonth({
    gr: str(m.gr),
    rep: str(m.rep),
    marca: str(m.marca),
    uf: str(m.uf),
    topico: str(m.topico),
    tipo: str(m.tipo),
    periodo: str(m.periodo),
    meta: Number(m.meta) || 0,
    ufHospital: str(m.ufHospital) || undefined,
    mes: str(m.mes) || undefined,
    cliente: str(m.cliente) || undefined,
    medico: str(m.medico) || undefined,
    assessor: str(m.assessor) || undefined,
    ufCliente: str(m.ufCliente) || undefined,
    metaFinanceira:
      m.metaFinanceira === undefined || m.metaFinanceira === null || m.metaFinanceira === ""
        ? undefined
        : Number(m.metaFinanceira) || 0,
  }),
);
