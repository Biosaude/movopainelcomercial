import { z } from "zod";
import {
  normalizePublication,
  publicationSchema,
  revenueSchema,
  targetSchema,
  type ImportRecord,
  type Publication,
  type SharedSnapshot,
} from "./shared";

export const MAX_BATCH_BYTES = 500_000;
export const MAX_BATCH_ROWS = 500;
export const SMALL_SNAPSHOT_BYTES = 400_000;
const kind = z.enum(["faturamento", "metas"]);
export const uploadManifestSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedVersion: z.string().uuid().nullable(),
    fileName: z.string().trim().min(1).max(255),
    revenueCount: z.number().int().min(1).max(25000),
    targetCount: z.number().int().min(0).max(25000),
    plan: z
      .array(
        z
          .object({
            kind,
            start: z.number().int().min(0),
            count: z.number().int().min(1).max(MAX_BATCH_ROWS),
            hash: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict()
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_000_000)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Manifesto excede o limite por requisição.",
      });
  });
export const uploadChunkSchema = z
  .object({
    requestId: z.string().uuid(),
    index: z.number().int().min(0).max(9999),
    payload: z.string().superRefine((value, context) => {
      if (new TextEncoder().encode(value).byteLength > MAX_BATCH_BYTES) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Lote excede 500 KB." });
        return;
      }
      try {
        z.array(z.union([revenueSchema, targetSchema]))
          .min(1)
          .max(MAX_BATCH_ROWS)
          .parse(JSON.parse(value));
      } catch {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Lote contém dados inválidos." });
      }
    }),
  })
  .strict();
export const uploadIdSchema = z.object({ requestId: z.string().uuid() }).strict();
export const pageSchema = z
  .object({ importId: z.string().uuid(), kind, offset: z.number().int().min(0).max(25000) })
  .strict();
export type UploadManifest = z.infer<typeof uploadManifestSchema>;
export type ReadManifest = { import: ImportRecord; bytes: number };
export type SnapshotPage = {
  rows: Array<Publication["faturamento"][number] | Publication["metas"][number]>;
  nextOffset: number;
};

function canonicalRow(row: Publication["faturamento"][number] | Publication["metas"][number]) {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(row)
        .sort()
        .map((key) => [key, row[key as keyof typeof row]]),
    ),
  );
}
export async function prepareUpload(input: Publication) {
  const value = normalizePublication(publicationSchema.parse(input));
  const plan: UploadManifest["plan"] = [];
  const payloads: string[] = [];
  for (const kind of ["faturamento", "metas"] as const) {
    const rows = value[kind];
    let start = 0;
    while (start < rows.length) {
      const parts: string[] = [];
      let bytes = 2;
      while (start + parts.length < rows.length && parts.length < MAX_BATCH_ROWS) {
        const part = canonicalRow(rows[start + parts.length]);
        const size = new TextEncoder().encode(part).byteLength + (parts.length ? 1 : 0);
        if (parts.length && bytes + size > MAX_BATCH_BYTES) break;
        if (bytes + size > MAX_BATCH_BYTES)
          throw new Error("Um registro excede o limite por lote.");
        bytes += size;
        parts.push(part);
      }
      const payload = `[${parts.join(",")}]`;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
      const hash = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      plan.push({ kind, start, count: parts.length, hash });
      payloads.push(payload);
      start += parts.length;
    }
  }
  const manifest = uploadManifestSchema.parse({
    requestId: value.requestId,
    expectedVersion: value.expectedVersion,
    fileName: value.fileName,
    revenueCount: value.faturamento.length,
    targetCount: value.metas.length,
    plan,
  });
  return { manifest, payloads };
}
export async function transferUpload(
  input: Publication,
  transport: {
    begin: (manifest: UploadManifest) => Promise<unknown>;
    chunk: (chunk: z.infer<typeof uploadChunkSchema>) => Promise<unknown>;
    commit: (request: z.infer<typeof uploadIdSchema>) => Promise<string>;
  },
) {
  const { manifest, payloads } = await prepareUpload(input);
  await transport.begin(manifest);
  for (let index = 0; index < payloads.length; index++)
    await transport.chunk({ requestId: manifest.requestId, index, payload: payloads[index] });
  return transport.commit({ requestId: manifest.requestId });
}

export async function assembleSnapshot(
  manifest: ReadManifest,
  read: (page: z.infer<typeof pageSchema>) => Promise<SnapshotPage>,
  current: () => boolean = () => true,
): Promise<SharedSnapshot> {
  const snapshot: SharedSnapshot = { import: manifest.import, faturamento: [], metas: [] };
  for (const kind of ["faturamento", "metas"] as const) {
    const count =
      kind === "faturamento" ? manifest.import.revenue_count : manifest.import.target_count;
    let offset = 0;
    while (offset < count) {
      if (!current()) throw new Error("Leitura substituída por uma atualização mais recente.");
      const page = await read({ importId: manifest.import.id, kind, offset });
      if (
        !Number.isInteger(page.nextOffset) ||
        page.nextOffset !== offset + page.rows.length ||
        !page.rows.length ||
        page.nextOffset > count ||
        page.rows.length > MAX_BATCH_ROWS
      )
        throw new Error("Página incompleta ou contagem inconsistente.");
      if (kind === "faturamento")
        snapshot.faturamento.push(...z.array(revenueSchema).parse(page.rows));
      else snapshot.metas.push(...z.array(targetSchema).parse(page.rows));
      offset = page.nextOffset;
    }
  }
  if (!current()) throw new Error("Leitura substituída por uma atualização mais recente.");
  return snapshot;
}
