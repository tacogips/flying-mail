import { ApplicationError } from "@mailcal/application/errors";
import type { AppDependencies } from "@mailcal/application/dependencies";
import type { UseCases } from "@mailcal/application/usecases";
import {
  buildAttachmentBlobKey,
  createAttachment,
} from "@mailcal/domain/entities/attachment";
import { createAttachmentId } from "@mailcal/domain/value-objects/ids";
import { Hono } from "hono";
import type { AuthVariables } from "./auth-middleware";
import { buildDownloadResponse } from "./downloads";

/** JSON body of a successful upload. */
export interface UploadAttachmentResponse {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
  readonly createdAt: string;
}

/** Upload cap, matching the outbound total-size limit an attachment is
 * ultimately destined for. */
export const MAX_ATTACHMENT_SIZE = 5 * 1024 * 1024;

/** Slack added when rejecting from `Content-Length` alone, before the body
 * is parsed: a multipart request's total size includes boundary markers and
 * per-part headers, which count toward `Content-Length` but not toward the
 * file's own size. Generous enough never to reject a legitimately-sized
 * upload, while still refusing a wildly oversized body unread. */
const MULTIPART_OVERHEAD_ALLOWANCE = 64 * 1024;

function sizeLimitResponse(): Response {
  return Response.json(
    {
      error: `Attachment exceeds the ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB size limit`,
    },
    { status: 413 },
  );
}

function errorStatus(
  error: ApplicationError,
): 400 | 401 | 403 | 404 | 409 | 503 | 500 {
  switch (error.code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "BAD_USER_INPUT":
      return 400;
    case "CONFLICT":
      return 409;
    case "SERVICE_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

/** Mirrors the GraphQL layer's masking: every current `ApplicationError`
 * maps to a 4xx/503, but if a future code were added without a case above,
 * this still refuses to leak `error.message` -- which may embed
 * caller-supplied values -- through a 500. */
function applicationErrorResponse(error: ApplicationError): Response {
  const status = errorStatus(error);
  return Response.json(
    { error: status === 500 ? "Internal server error" : error.message },
    { status },
  );
}

function unauthenticatedResponse(): Response {
  return Response.json({ error: "Authentication required" }, { status: 401 });
}

/** Binary attachment transfer, kept out of GraphQL: GraphQL carries
 * metadata, bytes go over plain HTTP.
 *
 * - `POST /attachments` (multipart, field `file`) stores a body for a later
 *   `sendMessage` to reference by id.
 * - `GET /attachments/:id` streams a stored attachment back.
 *
 * Both require an authenticated viewer. For a credential-free, expiring URL
 * see `file-links.ts`. */
export function createAttachmentRoutes(
  deps: AppDependencies,
  usecases: UseCases,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post("/attachments", async (c) => {
    const viewer = c.get("viewer");
    if (viewer === null) {
      return unauthenticatedResponse();
    }

    // Reject an oversized request from its header alone, before
    // `formData()` reads (and buffers) any of the body.
    const contentLengthHeader = c.req.header("content-length");
    if (contentLengthHeader !== undefined) {
      const contentLength = Number(contentLengthHeader);
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_ATTACHMENT_SIZE + MULTIPART_OVERHEAD_ALLOWANCE
      ) {
        return sizeLimitResponse();
      }
    }

    try {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return Response.json(
          { error: 'Missing multipart "file" field' },
          { status: 400 },
        );
      }
      // Backstop for a request with no, or an understated, `Content-Length`.
      if (file.size > MAX_ATTACHMENT_SIZE) {
        return sizeLimitResponse();
      }

      const now = deps.clock.now().toISOString();
      const attachmentId = createAttachmentId(deps.random.uuid());
      const fileName = file.name.length === 0 ? "attachment" : file.name;
      const blobKey = buildAttachmentBlobKey(attachmentId, fileName);
      await deps.blobs.put(blobKey, new Uint8Array(await file.arrayBuffer()), {
        contentType: file.type || "application/octet-stream",
      });

      // Staged: not tied to a message yet. `sendMessage` binds it when it
      // consumes the id, which is also when it starts cascading on delete.
      const attachment = createAttachment({
        id: attachmentId,
        messageId: null,
        fileName,
        contentType: file.type || "application/octet-stream",
        size: file.size,
        blobKey,
        contentId: null,
        inline: false,
        createdAt: now,
      });

      const response: UploadAttachmentResponse = {
        id: attachment.id,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        size: attachment.size,
        url: `/api/attachments/${attachment.id}`,
        createdAt: attachment.createdAt,
      };
      await deps.messageRepository.saveAttachment(attachment);
      return Response.json(response, { status: 201 });
    } catch (error) {
      if (error instanceof ApplicationError) {
        return applicationErrorResponse(error);
      }
      // Most commonly a malformed multipart body, which throws rather than
      // rejecting with an `ApplicationError`. Treated as a client error
      // rather than left to bubble up as a 500.
      return Response.json(
        { error: "Malformed multipart request body" },
        { status: 400 },
      );
    }
  });

  app.get("/attachments/:id", async (c) => {
    const viewer = c.get("viewer");
    if (viewer === null) {
      return unauthenticatedResponse();
    }

    const attachmentId = createAttachmentId(c.req.param("id"));
    let attachment: Awaited<
      ReturnType<AppDependencies["messageRepository"]["findAttachmentById"]>
    >;
    try {
      attachment =
        await deps.messageRepository.findAttachmentById(attachmentId);
    } catch (error) {
      if (error instanceof ApplicationError) {
        return applicationErrorResponse(error);
      }
      throw error;
    }
    if (attachment === null) {
      return Response.json({ error: "Attachment not found" }, { status: 404 });
    }

    // Authorization goes through whatever claims the attachment: a mail
    // attachment through its message, an event attachment through the event
    // that claimed it. Either way, one the viewer cannot read reports as
    // absent, matching the GraphQL rule that a scoped key cannot probe for
    // other mailboxes or calendars.
    //
    // An attachment nothing has claimed has nothing to authorize against, so
    // it is simply not downloadable -- it only exists to be referenced by a
    // later `sendMessage` or `attachFileToEvent`, and serving it here would
    // mean any authenticated caller could read any other caller's pending
    // upload.
    if (attachment.messageId === null) {
      const readableThroughEvent = await usecases.canViewerReadEventAttachment(
        viewer,
        attachmentId,
      );
      if (!readableThroughEvent) {
        return Response.json(
          { error: "Attachment not found" },
          { status: 404 },
        );
      }
    } else {
      const message = await usecases.getMessage(viewer, attachment.messageId);
      if (message === null) {
        return Response.json(
          { error: "Attachment not found" },
          { status: 404 },
        );
      }
    }

    const blob = await deps.blobs.get(attachment.blobKey);
    if (blob === null) {
      return Response.json({ error: "Attachment not found" }, { status: 404 });
    }

    return buildDownloadResponse({
      body: blob.body,
      contentType: blob.contentType ?? attachment.contentType,
      contentLength: blob.size || attachment.size,
      fileName: attachment.fileName,
      forceDownload: c.req.query("download") === "1",
    });
  });

  return app;
}
