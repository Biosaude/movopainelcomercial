import { describe, expect, test } from "bun:test";
import { largeDataset } from "./support/large-dataset.mjs";
import {
  normalizePublication,
  publicationSchema,
  legacyPublicationSchema,
  type Publication,
} from "../src/lib/dashboard/shared";
import {
  prepareUpload,
  transferUpload,
  assembleSnapshot,
  uploadChunkSchema,
  MAX_BATCH_BYTES,
  MAX_BATCH_ROWS,
  type ReadManifest,
} from "../src/lib/dashboard/batches";

const input: Publication = {
  requestId: "20000000-0000-4000-8000-000000000001",
  expectedVersion: null,
  fileName: "fictional-large.xlsx",
  ...largeDataset(),
};
const normalized = normalizePublication(input);
const manifest: ReadManifest = {
  import: {
    id: input.requestId,
    file_name: input.fileName,
    published_at: "2026-10-14T16:00:00Z",
    revenue_count: 13759,
    target_count: 633,
  },
  bytes: JSON.stringify(input).length,
};
describe("large publications", () => {
  test("accepts all 13,759 revenue records and 633 targets above 3 MB", () => {
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeGreaterThan(4_500_000);
    expect(publicationSchema.parse(input).faturamento).toHaveLength(13759);
    expect(publicationSchema.parse(input).metas).toHaveLength(633);
    expect(legacyPublicationSchema.safeParse(input).success).toBe(false);
  });
  test("splits by UTF-8 bytes and row count without changing any record", async () => {
    const result = await prepareUpload(input);
    const collected = { faturamento: [] as unknown[], metas: [] as unknown[] };
    for (const [index, chunk] of result.manifest.plan.entries()) {
      const bytes = new TextEncoder().encode(result.payloads[index]).byteLength;
      expect(bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
      expect(chunk.count).toBeLessThanOrEqual(MAX_BATCH_ROWS);
      expect(chunk.start).toBe(collected[chunk.kind].length);
      const rows = JSON.parse(result.payloads[index]);
      expect(rows).toHaveLength(chunk.count);
      collected[chunk.kind].push(...rows);
      // Even nested RPC JSON quoting stays well below the Vercel request limit.
      expect(
        new TextEncoder().encode(JSON.stringify({ p_payload: result.payloads[index] })).byteLength,
      ).toBeLessThan(1_100_000);
    }
    expect(collected.faturamento).toEqual(normalized.faturamento);
    expect(collected.metas).toEqual(normalized.metas);
  });
  test("retries produce the same immutable batch hashes even after a browser refresh", async () => {
    const first = await prepareUpload(input);
    const retry = await prepareUpload({ ...input, expectedVersion: input.requestId });
    expect(retry.manifest.plan).toEqual(first.manifest.plan);
    expect(retry.payloads).toEqual(first.payloads);
  });
  test("an intermediate transport failure never calls commit, and a retry resends stable batches", async () => {
    const received = new Map<number, string>();
    let fail = true;
    let commits = 0;
    const transport = {
      begin: async () => input.requestId,
      chunk: async (chunk: { index: number; payload: string }) => {
        if (fail && chunk.index === 2) {
          fail = false;
          throw new Error("network failure");
        }
        if (received.has(chunk.index)) expect(chunk.payload).toBe(received.get(chunk.index));
        received.set(chunk.index, chunk.payload);
      },
      commit: async () => {
        commits++;
        return input.requestId;
      },
    };
    await expect(transferUpload(input, transport)).rejects.toThrow("network failure");
    expect(commits).toBe(0);
    expect(received.size).toBe(2);
    expect(await transferUpload(input, transport)).toBe(input.requestId);
    expect(commits).toBe(1);
    expect(
      [...received.values()].reduce((sum, payload) => sum + JSON.parse(payload).length, 0),
    ).toBe(14392);
  });
  test("validates each bounded payload, rejecting oversized and non-finite JSON values", () => {
    expect(
      uploadChunkSchema.safeParse({
        requestId: input.requestId,
        index: 0,
        payload: "x".repeat(500001),
      }).success,
    ).toBe(false);
    expect(
      uploadChunkSchema.safeParse({
        requestId: input.requestId,
        index: 0,
        payload: JSON.stringify([{ ...input.faturamento[0], valor: "invalid" }]),
      }).success,
    ).toBe(false);
    expect(
      uploadChunkSchema.safeParse({ requestId: input.requestId, index: 0, payload: "[]" }).success,
    ).toBe(false);
  });
});
describe("complete version reads", () => {
  test("assembles every page of a version larger than 3 MB", async () => {
    const snapshot = await assembleSnapshot(manifest, async (page) => {
      const rows = normalized[page.kind].slice(page.offset, page.offset + 200);
      return { rows, nextOffset: page.offset + rows.length };
    });
    expect(snapshot.faturamento).toEqual(normalized.faturamento);
    expect(snapshot.metas).toEqual(normalized.metas);
  });
  test("rejects truncated or non-advancing pages instead of accepting a partial snapshot", async () => {
    await expect(
      assembleSnapshot(manifest, async () => ({ rows: [], nextOffset: 0 })),
    ).rejects.toThrow("Página incompleta");
    await expect(
      assembleSnapshot(manifest, async () => ({
        rows: [normalized.faturamento[0]],
        nextOffset: 20,
      })),
    ).rejects.toThrow("Página incompleta");
  });
  test("a concurrent publication or a superseded request never returns mixed or partial data", async () => {
    let pages = 0;
    await expect(
      assembleSnapshot(manifest, async (page) => {
        if (++pages > 1) throw new Error("active version changed");
        return {
          rows: normalized.faturamento.slice(page.offset, page.offset + 200),
          nextOffset: page.offset + 200,
        };
      }),
    ).rejects.toThrow("active version changed");
    await expect(
      assembleSnapshot(
        manifest,
        async () => ({ rows: [], nextOffset: 0 }),
        () => false,
      ),
    ).rejects.toThrow("Leitura substituída");
  });
});
