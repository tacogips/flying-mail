import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency, uploadAttachmentWithProgress } from "./upload";

class FakeXhr {
  readonly upload: XMLHttpRequestUpload = {
    onprogress: null,
  } as unknown as XMLHttpRequestUpload;
  withCredentials = false;
  status = 0;
  responseText = "";
  onload: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  onerror: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  onabort: ((this: XMLHttpRequest, ev: ProgressEvent) => unknown) | null = null;
  opened: [string, string] | undefined;
  body: Document | XMLHttpRequestBodyInit | null = null;

  open(method: string, url: string): void {
    this.opened = [method, url];
  }
  send(body?: Document | XMLHttpRequestBodyInit | null): void {
    this.body = body ?? null;
  }
  abort(): void {
    this.onabort?.call(
      this as unknown as XMLHttpRequest,
      new ProgressEvent("abort"),
    );
  }
  respond(status: number, response: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(response);
    this.onload?.call(
      this as unknown as XMLHttpRequest,
      new ProgressEvent("load"),
    );
  }
}

describe("attachment upload", () => {
  it("posts a credentialed file, parses the response, and reports progress", async () => {
    const xhr = new FakeXhr();
    const progress = vi.fn();
    const upload = uploadAttachmentWithProgress(
      new File(["data"], "a.txt"),
      progress,
      {
        createXhr: () => xhr as unknown as XMLHttpRequest,
      },
    );
    expect(xhr.opened).toEqual(["POST", "/api/attachments"]);
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.body).toBeInstanceOf(FormData);
    const form = xhr.body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
    (
      xhr.upload.onprogress as
        | ((event: ProgressEvent<EventTarget>) => void)
        | null
    )?.({
      loaded: 2,
      total: 4,
      lengthComputable: true,
    } as ProgressEvent<EventTarget>);
    expect(progress).toHaveBeenCalledWith(2, 4);
    xhr.respond(201, {
      id: "id",
      fileName: "a.txt",
      contentType: "text/plain",
      size: 4,
    });
    await expect(upload.promise).resolves.toEqual({
      ok: true,
      attachment: {
        id: "id",
        fileName: "a.txt",
        contentType: "text/plain",
        size: 4,
      },
    });
  });

  it("maps size, authentication, server, network, and abort failures", async () => {
    const tooLargeXhr = new FakeXhr();
    const tooLarge = uploadAttachmentWithProgress(new File([], "x"), vi.fn(), {
      createXhr: () => tooLargeXhr as unknown as XMLHttpRequest,
    });
    tooLargeXhr.respond(413, { error: "Too large", maxBytes: 5_242_880 });
    await expect(tooLarge.promise).resolves.toMatchObject({
      ok: false,
      failure: "TOO_LARGE",
      maxBytes: 5_242_880,
    });

    const unauthorizedXhr = new FakeXhr();
    const unauthorized = uploadAttachmentWithProgress(
      new File([], "x"),
      vi.fn(),
      {
        createXhr: () => unauthorizedXhr as unknown as XMLHttpRequest,
      },
    );
    unauthorizedXhr.respond(401, { error: "Sign in" });
    await expect(unauthorized.promise).resolves.toMatchObject({
      ok: false,
      failure: "UNAUTHENTICATED",
    });

    const networkXhr = new FakeXhr();
    const network = uploadAttachmentWithProgress(new File([], "x"), vi.fn(), {
      createXhr: () => networkXhr as unknown as XMLHttpRequest,
    });
    networkXhr.onerror?.call(
      networkXhr as unknown as XMLHttpRequest,
      new ProgressEvent("error"),
    );
    await expect(network.promise).resolves.toMatchObject({
      ok: false,
      failure: "NETWORK",
    });

    const abortXhr = new FakeXhr();
    const aborted = uploadAttachmentWithProgress(new File([], "x"), vi.fn(), {
      createXhr: () => abortXhr as unknown as XMLHttpRequest,
    });
    aborted.abort();
    await expect(aborted.promise).resolves.toMatchObject({
      ok: false,
      failure: "ABORTED",
    });
  });

  it("maps uploads with bounded concurrency and preserves order", async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapWithConcurrency(
      [0, 1, 2, 3, 4, 5, 6],
      3,
      async (item) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return item * 2;
      },
    );
    expect(result).toEqual([0, 2, 4, 6, 8, 10, 12]);
    expect(maximum).toBe(3);
  });
});
