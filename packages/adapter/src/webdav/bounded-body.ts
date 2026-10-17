/** Raised by {@link readTextBounded} when a response body is over the cap. */
export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response body exceeds ${maxBytes} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/** Reads a response body as UTF-8 text without buffering more than
 * `maxBytes`. A declared `Content-Length` over the cap is refused before any
 * of the body is read; the running total covers a missing or understated
 * header. The stream is cancelled as soon as the cap is passed. */
export async function readTextBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
