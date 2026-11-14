export interface UploadedAttachmentInfo {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
}

export type UploadFailure =
  | "TOO_LARGE"
  | "UNAUTHENTICATED"
  | "NETWORK"
  | "SERVER"
  | "ABORTED";
export type UploadResult =
  | { readonly ok: true; readonly attachment: UploadedAttachmentInfo }
  | {
      readonly ok: false;
      readonly failure: UploadFailure;
      readonly message: string;
      readonly maxBytes?: number;
    };

function parseBody(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function failure(
  failureType: UploadFailure,
  message: string,
  maxBytes?: number,
): UploadResult {
  return maxBytes === undefined
    ? { ok: false, failure: failureType, message }
    : { ok: false, failure: failureType, message, maxBytes };
}

/** Uploads a single attachment and reports XMLHttpRequest upload progress. */
export function uploadAttachmentWithProgress(
  file: File,
  onProgress: (loaded: number, total: number) => void,
  options: {
    readonly endpoint?: string;
    readonly createXhr?: () => XMLHttpRequest;
  } = {},
): { readonly promise: Promise<UploadResult>; abort(): void } {
  const xhr = options.createXhr?.() ?? new XMLHttpRequest();
  let settled = false;
  let settle!: (result: UploadResult) => void;
  const promise = new Promise<UploadResult>((resolve) => {
    settle = resolve;
  });
  const finish = (result: UploadResult): void => {
    if (settled) return;
    settled = true;
    settle(result);
  };

  xhr.open("POST", options.endpoint ?? "/api/attachments");
  xhr.withCredentials = true;
  xhr.upload.onprogress = (event: ProgressEvent<EventTarget>): void => {
    onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
  };
  xhr.onload = (): void => {
    const body = parseBody(xhr.responseText);
    if (xhr.status === 201) {
      const { id, fileName, contentType, size } = body;
      if (
        typeof id === "string" &&
        typeof fileName === "string" &&
        typeof contentType === "string" &&
        typeof size === "number"
      ) {
        finish({ ok: true, attachment: { id, fileName, contentType, size } });
      } else {
        finish(failure("SERVER", "The upload response was invalid."));
      }
      return;
    }
    const message =
      typeof body["error"] === "string"
        ? body["error"]
        : "Attachment upload failed.";
    if (xhr.status === 413) {
      finish(
        failure(
          "TOO_LARGE",
          message,
          typeof body["maxBytes"] === "number" ? body["maxBytes"] : undefined,
        ),
      );
    } else if (xhr.status === 401) {
      finish(failure("UNAUTHENTICATED", message));
    } else {
      finish(failure("SERVER", message));
    }
  };
  xhr.onerror = (): void =>
    finish(failure("NETWORK", "Network error while uploading attachment."));
  xhr.onabort = (): void =>
    finish(failure("ABORTED", "Attachment upload was aborted."));

  const form = new FormData();
  form.append("file", file);
  try {
    xhr.send(form);
  } catch {
    finish(failure("NETWORK", "Network error while uploading attachment."));
  }

  return {
    promise,
    abort() {
      if (settled) return;
      xhr.abort();
      finish(failure("ABORTED", "Attachment upload was aborted."));
    },
  };
}

/** Maps items with a fixed concurrency cap while preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<readonly R[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("limit must be a positive integer");
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        const item = items[index];
        if (item === undefined && !(index in items)) continue;
        results[index] = await fn(item as T);
      }
    }),
  );
  return results;
}
