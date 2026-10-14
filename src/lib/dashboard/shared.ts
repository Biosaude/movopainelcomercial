import { z } from "zod";
import { normalizeMetaMonth, normalizeRowDate } from "./domain";

// Payload limits stay below Vercel's 4.5 MB function request limit.
export const MAX_PUBLICATION_BYTES = 3_000_000;
const text = z.string().max(1000);
const dimensions = {
  gr: text,
  rep: text,
  uf: text,
  marca: text,
  topico: text,
  tipo: text,
  periodo: z.string().regex(/^Q[1-4] 20\d{2}$/),
  mes: text.optional(),
  cliente: text.optional(),
  medico: text.optional(),
  assessor: text.optional(),
  ufCliente: text.optional(),
  ufHospital: text.optional(),
};
export const revenueSchema = z
  .object({
    ...dimensions,
    gr: text.min(1),
    valor: z.number().finite(),
    data: text.optional(),
    hospital: text.optional(),
  })
  .strict();
export const targetSchema = z
  .object({
    ...dimensions,
    rep: text.min(1),
    meta: z.number().finite(),
    metaFinanceira: z.number().finite().optional(),
  })
  .strict();
export const publicationSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.string().uuid().nullable(),
    fileName: z.string().trim().min(1).max(255),
    faturamento: z.array(revenueSchema).min(1).max(25000),
    metas: z.array(targetSchema).max(25000),
  })
  .strict();
// Only the retained legacy single-request endpoint has a total-body limit.
export const legacyPublicationSchema = publicationSchema.superRefine((value, context) => {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PUBLICATION_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Base muito grande para publicação (limite de 3 MB).",
    });
  }
});
export type Publication = z.infer<typeof publicationSchema>;
export type ImportRecord = {
  id: string;
  published_at: string;
  file_name: string;
  revenue_count: number;
  target_count: number;
  created_by_label?: string | null;
};
export type SharedSnapshot = {
  import: ImportRecord;
  faturamento: z.infer<typeof revenueSchema>[];
  metas: z.infer<typeof targetSchema>[];
};
export function normalizePublication(value: Publication): Publication {
  // Reuse business normalization. Never aggregate revenue or recalculate targets here.
  return {
    ...value,
    faturamento: value.faturamento.map(normalizeRowDate),
    metas: value.metas.map(normalizeMetaMonth),
  };
}

// Separate workbooks use precisely the same parser as the existing combined template.
export function combineParsedFiles(results: import("./domain").ParseResult[]) {
  const metas = results.flatMap((result) => result.metas);
  return {
    faturamento: results.flatMap((result) => result.faturamento),
    metas,
    totalLinhas: results.reduce((sum, result) => sum + result.totalLinhas, 0),
    linhasValidas: results.reduce((sum, result) => sum + result.linhasValidas, 0),
    linhasInvalidas: results.reduce((sum, result) => sum + result.linhasInvalidas, 0),
    colunasDesconhecidas: [...new Set(results.flatMap((result) => result.colunasDesconhecidas))],
    warnings: results
      .flatMap((result) => result.warnings)
      .filter(
        (warning) =>
          metas.length === 0 || !warning.startsWith("Nenhuma meta encontrada na planilha"),
      ),
    errors: results.flatMap((result) => result.errors),
  };
}
