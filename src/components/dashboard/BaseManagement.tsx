import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  AlertCircle, CheckCircle2, Database, Download, RefreshCw, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FAT_HEADERS, META_HEADERS, type Meta, type ParseResult, type Row,
  fmtInt, parseWorkbook,
} from "@/lib/dashboard/domain";

export type LastUpdate = { when: Date; fileName: string; count: number; metaCount: number };

type UploadStatus =
  | { kind: "idle" }
  | { kind: "ready"; fileName: string; result: ParseResult }
  | { kind: "error"; message: string; result?: ParseResult }
  | { kind: "success"; fileName: string; count: number; metaCount: number };

export function BaseManagement({
  current, currentMetas, onApply, lastUpdate, setLastUpdate,
}: {
  current: Row[];
  currentMetas: Meta[];
  onApply: (faturamento: Row[], metas: Meta[], fileName: string) => void;
  lastUpdate: LastUpdate | null;
  setLastUpdate: (v: LastUpdate | null) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<UploadStatus>({ kind: "idle" });

  const downloadTemplate = () => {
    const fatRows = current;
    const metaRows = currentMetas;
    const maxLen = Math.max(fatRows.length, metaRows.length, 1);
    const aoa: unknown[][] = [[...FAT_HEADERS, "", ...META_HEADERS]];
    for (let i = 0; i < maxLen; i++) {
      const f = fatRows[i];
      const m = metaRows[i];
      aoa.push([
        f?.gr ?? "", f?.rep ?? "", f?.assessor ?? "", f?.uf ?? "", f?.marca ?? "", f?.topico ?? "", f?.tipo ?? "",
        f?.cliente ?? "", f?.ufCliente ?? "", f?.hospital ?? "", f?.ufHospital ?? "", f?.medico ?? "",
        f?.data ?? "", f?.mes ?? "", f?.periodo ?? "", f?.valor ?? "",
        "",
        m?.gr ?? "", m?.rep ?? "", m?.uf ?? "", m?.marca ?? "", m?.topico ?? "", m?.tipo ?? "", m?.periodo ?? "", m?.meta ?? "", m?.metaFinanceira ?? "",
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Base");
    XLSX.writeFile(wb, "modelo_base_dashboard_biosaude.xlsx");
  };

  const handleFile = async (f: File) => {
    try {
      const result = parseWorkbook(await f.arrayBuffer());
      if (result.errors.length > 0) {
        setStatus({ kind: "error", message: result.errors.join(" "), result });
        return;
      }
      setStatus({ kind: "ready", fileName: f.name, result });
    } catch (e) {
      setStatus({ kind: "error", message: `Não foi possível ler o arquivo: ${(e as Error).message}` });
    }
  };

  const applyUpdate = () => {
    if (status.kind !== "ready") return;
    const { faturamento, metas } = status.result;
    onApply(faturamento, metas, status.fileName);
    setLastUpdate({ when: new Date(), fileName: status.fileName, count: faturamento.length, metaCount: metas.length });
    setStatus({ kind: "success", fileName: status.fileName, count: faturamento.length, metaCount: metas.length });
    if (fileInput.current) fileInput.current.value = "";
  };

  const ready = status.kind === "ready" ? status.result : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          Gerenciamento da Base de Dados
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Button variant="outline" onClick={downloadTemplate} className="justify-start h-auto py-3">
            <Download className="h-4 w-4 mr-2 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium">Baixar Modelo da Base</div>
              <div className="text-[11px] text-muted-foreground font-normal">Faturamento + Metas (.xlsx)</div>
            </div>
          </Button>

          <Button variant="outline" onClick={() => fileInput.current?.click()} className="justify-start h-auto py-3">
            <Upload className="h-4 w-4 mr-2 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium">Selecionar Nova Base</div>
              <div className="text-[11px] text-muted-foreground font-normal">Arquivo Excel (.xlsx)</div>
            </div>
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />

          <Button onClick={applyUpdate} disabled={status.kind !== "ready"} className="justify-start h-auto py-3">
            <RefreshCw className="h-4 w-4 mr-2 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium">Atualizar Dashboard</div>
              <div className="text-[11px] opacity-80 font-normal">
                {ready
                  ? `${fmtInt(ready.faturamento.length)} fat · ${fmtInt(ready.metas.length)} metas`
                  : status.kind === "success" ? "Base atualizada" : "Base ativa em uso"}
              </div>
            </div>
          </Button>
        </div>

        {ready && status.kind === "ready" && (
          <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm space-y-2">
            <p className="font-medium text-sky-700 flex items-center gap-2">
              <Upload className="h-4 w-4" /> Planilha validada: {status.fileName}
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <div><span className="text-muted-foreground">Linhas lidas: </span><b>{fmtInt(ready.totalLinhas)}</b></div>
              <div><span className="text-muted-foreground">Linhas válidas: </span><b>{fmtInt(ready.linhasValidas)}</b></div>
              <div><span className="text-muted-foreground">Linhas inválidas: </span><b>{fmtInt(ready.linhasInvalidas)}</b></div>
              <div><span className="text-muted-foreground">Metas: </span><b>{fmtInt(ready.metas.length)}</b></div>
            </div>
            {ready.colunasDesconhecidas.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Colunas não reconhecidas (ignoradas): {ready.colunasDesconhecidas.join(", ")}
              </p>
            )}
            {ready.warnings.length > 0 && (
              <ul className="text-xs text-amber-700 list-disc pl-4 space-y-0.5">
                {ready.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <p className="text-xs text-muted-foreground">
              Confira o resumo e clique em “Atualizar Dashboard” para aplicar. A base atual não foi alterada ainda.
            </p>
          </div>
        )}

        {status.kind === "error" && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm space-y-1">
            <p className="font-medium text-red-700 flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> Planilha rejeitada — a base atual foi preservada
            </p>
            <p className="text-xs text-muted-foreground">{status.message}</p>
            {status.result?.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-700">{w}</p>
            ))}
          </div>
        )}

        {status.kind === "success" && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            <p className="font-medium text-emerald-700 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" /> Dashboard atualizado com sucesso
            </p>
            <p className="text-xs text-muted-foreground">
              {fmtInt(status.count)} registros de faturamento e {fmtInt(status.metaCount)} metas importados de {status.fileName}.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-6 pt-2 border-t text-xs text-muted-foreground">
          <div>
            <span className="font-semibold text-foreground">Última atualização: </span>
            {lastUpdate ? lastUpdate.when.toLocaleString("pt-BR") : "Nenhum upload realizado (base embarcada)"}
          </div>
          <div>
            <span className="font-semibold text-foreground">Arquivo: </span>
            {lastUpdate ? lastUpdate.fileName : "base embarcada"}
          </div>
          <div>
            <span className="font-semibold text-foreground">Faturamento: </span>
            {fmtInt(current.length)} registros
          </div>
          <div>
            <span className="font-semibold text-foreground">Metas: </span>
            {fmtInt(currentMetas.length)} registros
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
