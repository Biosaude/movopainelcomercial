import { createServerFn } from "@tanstack/react-start";
import {
  uploadManifestSchema,
  uploadChunkSchema,
  uploadIdSchema,
  pageSchema,
} from "../dashboard/batches";

export const beginSharedUpload = createServerFn({ method: "POST" })
  .validator(uploadManifestSchema)
  .handler(async ({ data }) => {
    const { beginUpload } = await import("../dashboard/upload.server");
    return beginUpload(data);
  });
export const appendSharedUpload = createServerFn({ method: "POST" })
  .validator(uploadChunkSchema)
  .handler(async ({ data }) => {
    const { appendUpload } = await import("../dashboard/upload.server");
    return appendUpload(data);
  });
export const commitSharedUpload = createServerFn({ method: "POST" })
  .validator(uploadIdSchema)
  .handler(async ({ data }) => {
    const { commitUpload } = await import("../dashboard/upload.server");
    return commitUpload(data);
  });
export const readSharedPage = createServerFn({ method: "GET" })
  .validator(pageSchema)
  .handler(async ({ data }) => {
    const { readPage } = await import("../dashboard/upload.server");
    return readPage(data);
  });
