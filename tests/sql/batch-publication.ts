import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { largeDataset } from "../support/large-dataset.mjs";
import {
  prepareUpload,
  assembleSnapshot,
  type UploadManifest,
} from "../../src/lib/dashboard/batches";

const container = process.argv[2];
assert.match(container ?? "", /^movopainel-sql-/); // Local, disposable DB only.
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
class SqlError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
async function sql(statement: string, actor: string | null = owner, operator = false) {
  const env = { ...process.env };
  for (const name of [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_TLS",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ])
    delete env[name];
  const query = `BEGIN; SET LOCAL ROLE ${operator ? "postgres" : actor ? "authenticated" : "anon"}; SET LOCAL request.jwt.claim.sub = ${q(actor ?? "")}; ${statement}; COMMIT;`;
  const proc = Bun.spawn(
    [
      "docker",
      "--host=unix:///var/run/docker.sock",
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      "postgres",
      "-qAt",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
    ],
    { env, stdin: new Response(query), stdout: "pipe", stderr: "pipe" },
  );
  const [out, error, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (status)
    throw new SqlError(error.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] ?? "unknown_sql_error");
  return out.trim() ? JSON.parse(out.trim()) : null;
}
const snapshot = () =>
  sql("SELECT public.dashboard_read_snapshot()", null).then((state) => state.snapshot);
const metadata = () =>
  sql("SELECT public.dashboard_read_manifest()", null).then((state) => state.manifest);
const historyCount = () => sql("SELECT to_jsonb(count(*)) FROM public.dashboard_imports");
const begin = (m: UploadManifest, actor = owner) =>
  sql(
    `SELECT to_jsonb(public.dashboard_upload_begin(${q(m.requestId)}::uuid,${m.expectedVersion ? q(m.expectedVersion) + "::uuid" : "NULL"},${q(m.fileName)},${m.revenueCount},${m.targetCount},${q(JSON.stringify(m.plan))}::jsonb))`,
    actor,
  );
const append = (id: string, index: number, payload: string, actor = owner) =>
  sql(
    `SELECT to_jsonb(public.dashboard_upload_chunk(${q(id)}::uuid,${index},${q(payload)}))`,
    actor,
  );
const commit = (id: string, actor = owner) =>
  sql(`SELECT to_jsonb(public.dashboard_upload_commit(${q(id)}::uuid))`, actor);
const page = (id: string, kind: string, offset: number) =>
  sql(`SELECT public.dashboard_read_page(${q(id)}::uuid,${q(kind)},${offset})`, null);
const expectCode = async (action: Promise<unknown>, code: string) => {
  await assert.rejects(action, (error: SqlError) => error.code === code);
};

const before = await snapshot();
const beforeCount = await historyCount();
const data = largeDataset();
const id = randomUUID();
const input = {
  requestId: id,
  expectedVersion: before.import.id,
  fileName: "fictional-13759-633.xlsx",
  ...data,
};
const { manifest, payloads } = await prepareUpload(input);
assert.ok(new TextEncoder().encode(JSON.stringify(input)).byteLength > 4_500_000);
await expectCode(begin(manifest, other), "42501");
await expectCode(
  sql(`SELECT to_jsonb(public.dashboard_upload_commit(${q(id)}::uuid))`, null),
  "42501",
);
await begin(manifest);
await begin({ ...manifest, expectedVersion: null }); // Retries retain the first precondition.
await append(id, 0, payloads[0]);
await append(id, 0, payloads[0]);
assert.equal(
  await sql(
    `SELECT to_jsonb(count(*)) FROM public.dashboard_upload_chunks WHERE upload_id=${q(id)}::uuid`,
  ),
  1,
);
await expectCode(
  append(id, 1, payloads[1].replace("Cliente fictício", "Conteúdo alterado")),
  "22023",
);
await expectCode(commit(id), "22023");
assert.equal((await snapshot()).import.id, before.import.id);
assert.equal(await historyCount(), beforeCount);
await expectCode(page(id, "faturamento", 0), "40001");
console.log(
  "PASS SQL: unauthorized writes, private staging, checksum verification, repeated batches and incomplete-commit rollback.",
);

for (let index = 1; index < payloads.length; index++) await append(id, index, payloads[index]);
const started = Date.now();
assert.equal(await commit(id), id);
console.log(
  `Commit of 13,759 revenue records and 633 targets completed in ${Date.now() - started} ms (disposable PostgreSQL).`,
);
assert.equal(await historyCount(), beforeCount + 1);
assert.equal(await commit(id), id);
assert.equal(await historyCount(), beforeCount + 1);
await append(id, 0, payloads[0]);
assert.equal(
  await sql(
    `SELECT to_jsonb(count(*)) FROM public.dashboard_upload_chunks WHERE upload_id=${q(id)}::uuid`,
  ),
  payloads.length,
);
const manifestRead = await metadata();
assert.ok(manifestRead.bytes > 4_500_000);
const restored = await assembleSnapshot(manifestRead, async (request) => {
  const result = await page(request.importId, request.kind, request.offset);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).byteLength < 500_000);
  return result;
});
assert.deepEqual(restored.faturamento, data.faturamento);
assert.deepEqual(restored.metas, data.metas);
assert.equal(
  await sql(
    `SELECT to_jsonb(sum((data->>'valor')::numeric)) FROM public.dashboard_faturamento WHERE import_id=${q(id)}::uuid`,
  ),
  (13758 * 13759) / 200,
);
assert.equal(
  await sql(
    `SELECT to_jsonb(sum((data->>'metaFinanceira')::numeric)) FROM public.dashboard_metas WHERE import_id=${q(id)}::uuid`,
  ),
  633 * 900 + (632 * 633) / 2,
);
console.log(
  "PASS SQL: complete large version, exact counts/order/values, paged reading, financial reconciliation and commit idempotency.",
);

const small = largeDataset(1, 1);
const failing = await prepareUpload({
  requestId: randomUUID(),
  expectedVersion: id,
  fileName: "fictional-commit-failure.xlsx",
  ...small,
});
await begin(failing.manifest);
for (let index = 0; index < failing.payloads.length; index++)
  await append(failing.manifest.requestId, index, failing.payloads[index]);
// Inject a failure AFTER history and revenue INSERTs, only in this disposable DB.
await sql(
  "CREATE FUNCTION public.test_fail_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional failure' USING ERRCODE='P0001'; END $$; CREATE TRIGGER test_fail_target BEFORE INSERT ON public.dashboard_metas FOR EACH ROW EXECUTE FUNCTION public.test_fail_target()",
  null,
  true,
);
await expectCode(commit(failing.manifest.requestId), "P0001");
assert.equal(await historyCount(), beforeCount + 1);
assert.equal(
  await sql(
    `SELECT to_jsonb(count(*)) FROM public.dashboard_faturamento WHERE import_id=${q(failing.manifest.requestId)}::uuid`,
  ),
  0,
);
assert.equal((await metadata()).import.id, id);
await sql(
  "DROP TRIGGER test_fail_target ON public.dashboard_metas; DROP FUNCTION public.test_fail_target()",
  null,
  true,
);
console.log(
  "PASS SQL: a late failure rolls back history, revenue, targets and active pointer together.",
);

// A second administrator in the local fixture, never in the remote project.
await sql(`INSERT INTO public.dashboard_admins(user_id) VALUES (${q(other)}::uuid)`, null, true);
await expectCode(append(id, 0, payloads[0], other), "42501");
const first = await prepareUpload({
  requestId: randomUUID(),
  expectedVersion: id,
  fileName: "fictional-concurrent-first.xlsx",
  ...small,
});
const second = await prepareUpload({
  requestId: randomUUID(),
  expectedVersion: id,
  fileName: "fictional-concurrent-second.xlsx",
  ...small,
});
for (const [upload, actor] of [
  [first, owner],
  [second, other],
] as const) {
  await begin(upload.manifest, actor);
  for (let index = 0; index < upload.payloads.length; index++)
    await append(upload.manifest.requestId, index, upload.payloads[index], actor);
}
let reads = 0;
await assert.rejects(
  assembleSnapshot(manifestRead, async (request) => {
    if (++reads === 2) {
      const results = await Promise.allSettled([
        commit(first.manifest.requestId),
        commit(second.manifest.requestId, other),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const failed = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      assert.equal(failed.reason.code, "40001");
    }
    return page(request.importId, request.kind, request.offset);
  }),
  (error: SqlError) => error.code === "40001",
);
assert.equal(await historyCount(), beforeCount + 2);
assert.equal(
  await sql(
    `SELECT to_jsonb(count(*)) FROM public.dashboard_faturamento WHERE import_id=${q(id)}::uuid`,
  ),
  13759,
);
assert.equal(
  await sql(`SELECT to_jsonb(count(*)) FROM public.dashboard_metas WHERE import_id=${q(id)}::uuid`),
  633,
);
assert.equal(await commit(id), id); // Historical retry doesn't move the newer pointer.
assert.notEqual((await metadata()).import.id, id);
console.log(
  "PASS SQL: concurrent administrators, owner isolation, superseded reads rejected and historical retry preserving the newer version.",
);
