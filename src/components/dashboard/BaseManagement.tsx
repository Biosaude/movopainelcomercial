import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  AlertCircle, CheckCircle2, Database, Download, RefreshCw, Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { SharedDashboard } from "@/hooks/use-shared-dashboard";
import { combineParsedFiles, publicationSchema } from "@/lib/dashboard/shared";
import {
  FAT_HEADERS, META_HEADERS, type Meta, type ParseResult, type Row,
  fmtInt, parseWorkbook,
} from "@/lib/dashboard/domain";

export type LastUpdate = { when: Date; fileName: string; count: number; metaCount: number };

type UploadStatus =
  | { kind: "idle" }
  | { kind: "ready"; fileName: string; result: ParseResult; requestId: string; applied?: boolean }
  | { kind: "error"; message: string; result?: ParseResult }
  | { kind: "success"; fileName: string; count: number; metaCount: number };

export function BaseManagement({
  current, currentMetas, onApply, lastUpdate, setLastUpdate, shared, temporary,
}: {
  current: Row[];
  currentMetas: Meta[];
  onApply: (faturamento: Row[], metas: Meta[], fileName: string) => void;
  lastUpdate: LastUpdate | null;
  setLastUpdate: (v: LastUpdate | null) => void;
  shared: SharedDashboard;
  temporary: boolean;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<UploadStatus>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [published, setPublished] = useState(false);

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

  const handleFiles = async (files: File[]) => {
    setBusy(true);
    setActionError("");
    setPublished(false);
    try {
      if (files.length > 2) throw new Error("Selecione uma base combinada ou uma planilha de faturamento e uma de metas.");
      if (files.some((file) => file.size > 10_000_000)) throw new Error("Cada arquivo deve ter no máximo 10 MB.");
      const results = await Promise.all(files.map(async (file) => parseWorkbook(await file.arrayBuffer())));
      if (results.filter((r) => r.faturamento.length > 0).length > 1 || results.filter((r) => r.metas.length > 0).length > 1) {
        throw new Error("Use somente uma fonte de faturamento e uma fonte de metas para evitar duplicações.");
      }
      const result = combineParsedFiles(results.map((r) => ({
        ...r,
        // A standalone target workbook is valid when paired with revenue.
        errors: r.faturamento.length === 0 && r.metas.length > 0 ? [] : r.errors,
      })));
      if (result.faturamento.length === 0) result.errors.push("Selecione uma planilha com faturamento válido.");
      if (result.errors.length > 0) {
        setStatus({ kind: "error", message: result.errors.join(" "), result });
        return;
      }
      setStatus({ kind: "ready", fileName: files.map((file) => file.name).join(" + "), result, requestId: crypto.randomUUID() });
    } catch (e) {
      setStatus({ kind: "error", message: `Não foi possível ler o arquivo: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const publishUpdate = async () => {
    if (status.kind !== "ready" || !shared.isAdmin || busy || shared.loading) return;
    const { faturamento, metas, linhasInvalidas } = status.result;
    setActionError("");
    if (linhasInvalidas > 0) { setActionError("Corrija as linhas inválidas antes de publicar permanentemente. A prévia temporária continua disponível."); return; }
    const validation = publicationSchema.safeParse({ requestId: status.requestId, expectedVersion: shared.dataset?.import?.id ?? null, fileName: status.fileName, faturamento, metas });
    if (!validation.success) { setActionError(validation.error.issues.map((issue) => issue.message).join(" ")); return; }
    if (!window.confirm(`Substituir a base compartilhada para todos os visitantes?\n${faturamento.length} registros de faturamento e ${metas.length} metas.\nArquivo: ${status.fileName}${metas.length === 0 ? "\nATENÇÃO: a nova base ficará sem metas." : ""}`)) return;
    setBusy(true);
    try {
      await shared.publish({ requestId: status.requestId, fileName: status.fileName, faturamento, metas });
      setPublished(true);
      setStatus({ kind: "success", fileName: status.fileName, count: faturamento.length, metaCount: metas.length });
      if (fileInput.current) fileInput.current.value = "";
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Não foi possível publicar. A base anterior foi preservada.");
    } finally { setBusy(false); }
  };

  const applyUpdate = () => {
    if (status.kind !== "ready") return;
    const { faturamento, metas } = status.result;
    onApply(faturamento, metas, status.fileName);
    setPublished(false);
    setLastUpdate({ when: new Date(), fileName: status.fileName, count: faturamento.length, metaCount: metas.length });
    setStatus({ ...status, applied: true });
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
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
          {shared.session ? (
            <>
              <span>{shared.session.user.email} · {shared.isAdmin ? "Administrador" : "Sem permissão administrativa"}</span>
              <Button variant="outline" size="sm" disabled={busy} onClick={async () => {
                setBusy(true); setActionError("");
                try { await shared.signOut(); } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
              }}>Sair</Button>
            </>
          ) : (
            <form className="flex flex-wrap items-center gap-2" onSubmit={async (event) => {
              event.preventDefault(); setBusy(true); setActionError("");
              try { await shared.signIn(email, password); setPassword(""); } catch (e) { setActionError((e as Error).message); } finally { setBusy(false); }
            }}>
              <span className="font-medium">Acesso administrativo</span>
              <Input aria-label="E-mail administrativo" autoComplete="username" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className="w-56" placeholder="E-mail" disabled={!shared.configured || busy} />
              <Input aria-label="Senha administrativa" autoComplete="current-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required className="w-40" placeholder="Senha" disabled={!shared.configured || busy} />
              <Button size="sm" type="submit" disabled={!shared.configured || busy}>Entrar</Button>
            </form>
          )}
          <Button size="sm" variant="outline" disabled={busy || shared.loading} onClick={() => { void shared.reload(); }}>Recarregar base compartilhada</Button>
        </div>
        {actionError && <p role="alert" className="text-sm text-red-700">{actionError}</p>}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Button variant="outline" onClick={downloadTemplate} className="justify-start h-auto py-3">
            <Download className="h-4 w-4 mr-2 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium">Baixar Modelo da Base</div>
              <div className="text-[11px] text-muted-foreground font-normal">Faturamento + Metas (.xlsx)</div>
            </div>
          </Button>

          <Button variant="outline" disabled={busy || shared.loading || shared.blocked} onClick={() => fileInput.current?.click()} className="justify-start h-auto py-3">
            <Upload className="h-4 w-4 mr-2 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium">Selecionar Nova Base</div>
              <div className="text-[11px] text-muted-foreground font-normal">Base combinada ou Faturamento + Metas (.xlsx)</div>
            </div>
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) void handleFiles(files); }}
          />

          <Button onClick={applyUpdate} disabled={status.kind !== "ready" || busy || shared.loading || shared.blocked} className="justify-start h-auto py-3">
            <RefreshCw className="h-4 w-4 mr-2 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium">Atualizar Dashboard temporariamente</div>
              <div className="text-[11px] opacity-80 font-normal">
                {ready
                  ? `${fmtInt(ready.faturamento.length)} fat · ${fmtInt(ready.metas.length)} metas`
                  : status.kind === "success" ? "Base atualizada" : "Base ativa em uso"}
              </div>
            </div>
          </Button>
        </div>

        {shared.isAdmin && <Button onClick={() => { void publishUpdate(); }} disabled={status.kind !== "ready" || busy || shared.loading}>
          <Database className="h-4 w-4 mr-2" />{busy ? "Publicando..." : "Publicar base permanentemente"}
        </Button>}
        <p className="text-xs text-muted-foreground">A prévia temporária vale apenas neste navegador até recarregar. A publicação permanente exige administrador e substitui faturamento e metas juntos para todos os visitantes.</p>

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
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left"><caption className="text-left font-medium mb-1">Prévia — primeiros 3 registros de faturamento</caption>
                <thead><tr><th>Período</th><th>GR</th><th>Representante</th><th>UF Hospital</th><th>Valor</th></tr></thead>
                <tbody>{ready.faturamento.slice(0, 3).map((r, i) => <tr key={i}><td>{r.periodo}</td><td>{r.gr}</td><td>{r.rep}</td><td>{r.ufHospital || "Não informado"}</td><td>{r.valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</td></tr>)}</tbody>
              </table>
              <table className="w-full text-xs text-left mt-3"><caption className="text-left font-medium mb-1">Prévia — primeiras 3 metas</caption>
                <thead><tr><th>Período</th><th>Mês</th><th>GR</th><th>UF</th><th>Meta de venda</th><th>Meta financeira</th></tr></thead>
                <tbody>{ready.metas.slice(0, 3).map((m, i) => <tr key={i}><td>{m.periodo}</td><td>{m.mes || "Trimestral"}</td><td>{m.gr}</td><td>{m.uf || "Não informado"}</td><td>{m.meta}</td><td>{m.metaFinanceira ?? "Não informada"}</td></tr>)}</tbody>
              </table>
            </div>
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

        {(status.kind === "success" || (status.kind === "ready" && status.applied)) && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm">
            <p className="font-medium text-emerald-700 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" /> {published ? "Base publicada para todos os visitantes" : "Dashboard atualizado temporariamente"}
            </p>
            <p className="text-xs text-muted-foreground">
              {fmtInt(status.kind === "success" ? status.count : status.result.faturamento.length)} registros de faturamento e {fmtInt(status.kind === "success" ? status.metaCount : status.result.metas.length)} metas importados de {status.fileName}.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-6 pt-2 border-t text-xs text-muted-foreground">
          <div>
            <span className="font-semibold text-foreground">Última atualização: </span>
            {temporary && "Prévia temporária · "}
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
        {shared.isAdmin && <div className="overflow-x-auto border-t pt-3">
          <h3 className="text-sm font-semibold mb-2">Histórico de importações (últimas 50 publicações)</h3>
          {shared.history.length === 0 ? <p className="text-xs text-muted-foreground">Nenhuma publicação realizada.</p> : (
            <table className="w-full text-xs text-left">
              <thead><tr><th>Data</th><th>Arquivo</th><th>Responsável</th><th>Faturamento</th><th>Metas</th></tr></thead>
              <tbody>{shared.history.map((item) => <tr key={item.id} className="border-t"><td>{new Date(item.published_at).toLocaleString("pt-BR")}</td><td>{item.file_name}</td><td>{item.created_by_label}</td><td>{fmtInt(item.revenue_count)}</td><td>{fmtInt(item.target_count)}</td></tr>)}</tbody>
            </table>
          )}
        </div>}
      </CardContent>
    </Card>
  );
}
