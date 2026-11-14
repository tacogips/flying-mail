import { AwsClient } from "aws4fetch";
import type {
  BlobObject,
  BlobStore,
} from "@mailcal/application/ports/blob-store";

export interface S3Config {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  /** `true` for MinIO and most self-hosted S3 implementations. */
  readonly forcePathStyle?: boolean;
}

function objectUrl(config: S3Config, key: string): string {
  const base = config.endpoint.replace(/\/+$/, "");
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (config.forcePathStyle === true) {
    return `${base}/${config.bucket}/${encodedKey}`;
  }
  const url = new URL(base);
  return `${url.protocol}//${config.bucket}.${url.host}/${encodedKey}`;
}

/** S3-compatible `BlobStore` reached over plain `fetch` with SigV4 signing
 * (`aws4fetch`), so it works unchanged on Workers, Bun and Node without an
 * SDK. Used for local development against MinIO and for deployments that
 * prefer their own object store over R2. */
export function createS3BlobStore(config: S3Config): BlobStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  });

  return {
    async put(key, body, opts): Promise<void> {
      const headers: Record<string, string> = {};
      if (opts?.contentType !== undefined) {
        headers["content-type"] = opts.contentType;
      }
      const response = await client.fetch(objectUrl(config, key), {
        method: "PUT",
        // `Uint8Array` and `ReadableStream` are both valid fetch bodies; the
        // cast only satisfies the ambient typing available here, which under
        // `exactOptionalPropertyTypes` excludes `undefined` from `body`.
        body: body as unknown as Exclude<RequestInit["body"], undefined>,
        headers,
      });
      if (!response.ok) {
        throw new Error(
          `S3 PUT for ${key} failed with status ${response.status}`,
        );
      }
    },

    async get(key): Promise<BlobObject | null> {
      const response = await client.fetch(objectUrl(config, key));
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(
          `S3 GET for ${key} failed with status ${response.status}`,
        );
      }
      if (response.body === null) {
        return null;
      }
      const contentLength = response.headers.get("content-length");
      return {
        body: response.body,
        contentType: response.headers.get("content-type"),
        size: contentLength === null ? 0 : Number(contentLength),
      };
    },

    async delete(key): Promise<void> {
      const response = await client.fetch(objectUrl(config, key), {
        method: "DELETE",
      });
      // 404 is success for a delete: the object is gone either way, and
      // treating it as an error would make message deletion fail on a
      // retry that already succeeded.
      if (!response.ok && response.status !== 404) {
        throw new Error(
          `S3 DELETE for ${key} failed with status ${response.status}`,
        );
      }
    },
  };
}
