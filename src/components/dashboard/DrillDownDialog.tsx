import { useMemo } from "react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { type Meta, type Row, fmtBRLFull, fmtPct, fmtSignedPct, pctAting, pctVar } from "@/lib/dashboard/domain";
import { type DrillMetric, type DrillScope, buildDrillRows } from "@/lib/dashboard/drilldown";

export function DrillDownDialog({
  drill, fat, metas, onClose,
}: {
  drill: { title: string; scope: DrillScope; metric: DrillMetric } | null;
  fat: Row[];
  metas: Meta[];
  onClose: () => void;
}) {
  const rows = useMemo(
    () => (drill ? buildDrillRows(fat, metas, drill.scope, drill.metric) : []),
    [drill, fat, metas],
  );
  const totals = useMemo(
    () => rows.reduce(
      (s, r) => ({ fat25: s.fat25 + r.fat25, fat26: s.fat26 + r.fat26, meta: s.meta + r.meta }),
      { fat25: 0, fat26: 0, meta: 0 },
    ),
    [rows],
  );
  const totalAting = pctAting(totals.fat26, totals.meta);
  const totalVar = pctVar(totals.fat26, totals.fat25);
  const scopeChips = drill ? Object.entries(drill.scope).filter(([, v]) => v) : [];
  const isFinancial = drill?.metric === "MF" || drill?.metric === "COBERTURA_MF";
  const metaLabel = isFinancial ? "Meta Financeira 2026" : "Meta de Venda 2026";
  const coverageLabel = drill?.metric === "COBERTURA_MF" ? "Cobertura MF %" : "Atingimento";
  const gapLabel = isFinancial ? "Gap MF" : "Gap Meta";

  const atingCls = (v: number | null) =>
    v === null ? "text-muted-foreground" : v >= 100 ? "text-emerald-600" : v >= 70 ? "text-amber-600" : "text-red-600";

  return (
    <Dialog open={!!drill} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-6xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{drill?.title ?? "Detalhamento"}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-1.5 pt-1">
            <span>Detalhe por Período · GR · Representante · UF · Marca · Tópico · Tipo (respeita os filtros ativos)</span>
            {scopeChips.length > 0 && (
              <span className="flex flex-wrap gap-1 ml-1">
                {scopeChips.map(([k, v]) => (
                  <span key={k} className="text-[10px] font-semibold uppercase bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                    {k}: {v}
                  </span>
                ))}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-auto flex-1 -mx-6 px-6">
          <table className="w-full text-sm min-w-[1100px]">
            <thead className="sticky top-0 bg-background border-b z-10">
              <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-semibold">Período</th>
                <th className="py-2 pr-3 font-semibold">GR</th>
                <th className="py-2 pr-3 font-semibold">Representante</th>
                <th className="py-2 pr-3 font-semibold">UF</th>
                <th className="py-2 pr-3 font-semibold">Marca</th>
                <th className="py-2 pr-3 font-semibold">Tópico</th>
                <th className="py-2 pr-3 font-semibold">Tipo</th>
                <th className="py-2 pr-3 font-semibold text-right">Fat. 2025</th>
                <th className="py-2 pr-3 font-semibold text-right">Fat. 2026</th>
                <th className="py-2 pr-3 font-semibold text-right">{metaLabel}</th>
                <th className="py-2 pr-3 font-semibold text-right">{coverageLabel}</th>
                <th className="py-2 pr-3 font-semibold text-right">{gapLabel}</th>
                <th className="py-2 pr-3 font-semibold text-right">Var. 25/26</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="text-center text-muted-foreground py-10">
                    Não há dados para os filtros selecionados.
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="py-2 pr-3 text-muted-foreground">{r.periodo}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{r.gr || "—"}</td>
                  <td className="py-2 pr-3">{r.rep || "—"}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{r.uf && r.uf !== "—" ? r.uf : "Não informado"}</td>
                  <td className="py-2 pr-3 font-medium">{r.marca || "—"}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{r.topico || "—"}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{r.tipo}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtBRLFull(r.fat25)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums font-medium">{fmtBRLFull(r.fat26)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.meta > 0 ? fmtBRLFull(r.meta) : "Sem meta"}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums font-semibold ${atingCls(r.ating)}`}>
                    {r.ating === null ? "Sem meta" : fmtPct(r.ating)}
                  </td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${r.meta === 0 ? "text-muted-foreground" : r.gap >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {r.meta === 0 ? "—" : `${r.gap >= 0 ? "+" : ""}${fmtBRLFull(r.gap)}`}
                  </td>
                  <td className={`py-2 pr-3 text-right tabular-nums font-semibold ${r.varPct === null ? "text-muted-foreground" : r.varPct >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {r.varPct === null ? "—" : fmtSignedPct(r.varPct)}
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot className="sticky bottom-0 bg-background border-t-2">
                <tr className="font-bold">
                  <td className="py-2 pr-3" colSpan={7}>Total ({rows.length} linhas)</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtBRLFull(totals.fat25)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtBRLFull(totals.fat26)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{fmtBRLFull(totals.meta)}</td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${atingCls(totalAting)}`}>
                    {totalAting === null ? "Sem meta" : fmtPct(totalAting)}
                  </td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${totals.meta === 0 ? "text-muted-foreground" : totals.fat26 - totals.meta >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {totals.meta === 0 ? "—" : `${totals.fat26 - totals.meta >= 0 ? "+" : ""}${fmtBRLFull(totals.fat26 - totals.meta)}`}
                  </td>
                  <td className={`py-2 pr-3 text-right tabular-nums ${totalVar === null ? "text-muted-foreground" : totalVar >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                    {totalVar === null ? "—" : fmtSignedPct(totalVar)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
