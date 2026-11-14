import { createAttachment } from "@flying-mail/domain/entities/attachment";
import {
  createMailDomain,
  verifyMailDomain,
} from "@flying-mail/domain/entities/mail-domain";
import {
  createInboundMessage,
  createOutboundMessage,
  createDraftMessage,
  RecipientKind,
  type Message,
} from "@flying-mail/domain/entities/message";
import { createUser, UserRole } from "@flying-mail/domain/entities/user";
import { createDomainName } from "@flying-mail/domain/value-objects/domain-name";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  createAttachmentId,
  createDomainId,
  createMessageId,
  createThreadId,
  createUserId,
  type DomainId,
} from "@flying-mail/domain/value-objects/ids";
import {
  createFakeDependencies,
  type FakeDependencies,
} from "@flying-mail/application/test-support/fakes";
import type { AppDependencies } from "@flying-mail/application/dependencies";
import type { ApiKeyScopeInput } from "@flying-mail/application/usecases/api-keys";
import type { UseCases } from "@flying-mail/application/usecases";
import { createUseCases } from "@flying-mail/application/usecases";
import type { McpAuditLine } from "./audit";
import { dispatchMcpMessage } from "./protocol";
import { MCP_TOOL_REGISTRY, type McpToolRegistry } from "./tool-registry";
import type { McpViewer } from "./tool-types";

const NOW = "2026-08-23T00:00:00.000Z";
const DOMAIN_ID: DomainId = createDomainId("dom-mcp-test");
const ADMIN_ID = createUserId("usr-mcp-test-admin");

export interface SeedMessageSpec {
  readonly id: string;
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly status?: "RECEIVED" | "SENT" | "DRAFT";
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly textBody?: string | null;
  readonly htmlBody?: string | null;
  readonly attachments?: readonly {
    readonly id: string;
    readonly fileName: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
  }[];
}
export interface McpCallResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>> | null;
}

export interface McpTestHarness {
  readonly fake: FakeDependencies;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly domainId: DomainId;
  readonly audit: McpAuditLine[];
  issueKey(
    scopes: readonly ApiKeyScopeInput[],
  ): Promise<{ readonly secret: string; readonly viewer: McpViewer }>;
  seedMessage(spec: SeedMessageSpec): Promise<Message>;
  callTool(
    viewer: McpViewer,
    name: string,
    args: unknown,
    registry?: McpToolRegistry,
  ): Promise<McpCallResult>;
  listTools(
    viewer: McpViewer,
    registry?: McpToolRegistry,
  ): Promise<readonly string[]>;
}

export async function createMcpTestHarness(): Promise<McpTestHarness> {
  const fake = createFakeDependencies({ now: NOW });
  const usecases = createUseCases(fake.deps);
  await fake.deps.mailDomainRepository.save(
    verifyMailDomain(
      createMailDomain({
        id: DOMAIN_ID,
        name: createDomainName("example.com"),
        catchAll: true,
        verificationToken: "test-token",
        createdAt: NOW,
      }),
      NOW,
    ),
  );
  const admin = createUser({
    id: ADMIN_ID,
    email: createEmailAddress("admin@example.com"),
    name: "Test Admin",
    role: UserRole.Admin,
    createdAt: NOW,
  });
  fake.stores.users.set(admin.id, admin);
  const adminViewer = {
    kind: "USER",
    userId: admin.id,
    role: admin.role,
    permissions: [],
    templatePermissions: [],
  } as const;
  const audit: McpAuditLine[] = [];
  const contextFor = (viewer: McpViewer) => ({
    viewer,
    usecases,
    deps: fake.deps,
  });
  const dispatch = async (
    viewer: McpViewer,
    message: unknown,
    registry: McpToolRegistry,
  ) =>
    dispatchMcpMessage({
      message,
      headers: new Headers(),
      registry,
      context: contextFor(viewer),
      keyPrefix: "ybm_test_prefix",
      clientIp: null,
      audit: (line) => audit.push(line),
      nowMs: () => Date.now(),
    });

  return {
    fake,
    deps: fake.deps,
    usecases,
    domainId: DOMAIN_ID,
    audit,
    async issueKey(scopes) {
      const issued = await usecases.createApiKey(adminViewer, {
        name: "MCP test key",
        scopes,
        expiresAt: null,
      });
      return {
        secret: issued.secret,
        viewer: {
          kind: "API_KEY",
          apiKeyId: issued.apiKey.id,
          scopes: issued.scopes,
        },
      };
    },
    async seedMessage(spec) {
      const id = createMessageId(spec.id);
      const common = {
        id,
        domainId: DOMAIN_ID,
        threadId: createThreadId(`thread-${spec.id}`),
        rfcMessageId: `${spec.id}@example.com`,
        inReplyTo: null,
        references: [],
        subject: spec.subject,
        fromAddress: createEmailAddress(spec.from),
        fromName: null,
        textBody: spec.textBody ?? null,
        htmlBody: spec.htmlBody ?? null,
        rawKey: `raw/${spec.id}.eml`,
        rawSize: 0,
        occurredAt: NOW,
        createdAt: NOW,
      };
      const message =
        spec.direction === "INBOUND"
          ? createInboundMessage({ ...common, spamScore: null })
          : spec.status === "DRAFT"
            ? createDraftMessage(common)
            : createOutboundMessage(common);
      fake.messageStores.messages.set(id, message);
      fake.messageStores.recipients.set(id, [
        {
          kind: RecipientKind.Envelope,
          address: createEmailAddress(spec.to[0] ?? "support@example.com"),
          name: null,
          position: 0,
        },
        ...spec.to.map((address, index) => ({
          kind: RecipientKind.To,
          address: createEmailAddress(address),
          name: null,
          position: index,
        })),
      ]);
      fake.messageStores.messageTags.set(id, new Set());
      for (const attachment of spec.attachments ?? []) {
        const attachmentId = createAttachmentId(attachment.id);
        const blobKey = `att/${attachment.id}/${attachment.fileName}`;
        fake.messageStores.attachments.set(
          attachmentId,
          createAttachment({
            id: attachmentId,
            messageId: id,
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            size: attachment.bytes.byteLength,
            blobKey,
            contentId: null,
            inline: false,
            createdAt: NOW,
          }),
        );
        await fake.deps.blobs.put(blobKey, attachment.bytes, {
          contentType: attachment.contentType,
        });
      }
      return message;
    },
    async callTool(viewer, name, args, selectedRegistry = MCP_TOOL_REGISTRY) {
      const result = await dispatch(
        viewer,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        },
        selectedRegistry,
      );
      return { status: result.status, body: result.body };
    },
    async listTools(viewer, selectedRegistry = MCP_TOOL_REGISTRY) {
      const result = await dispatch(
        viewer,
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        selectedRegistry,
      );
      const rpcResult = result.body?.["result"];
      if (typeof rpcResult !== "object" || rpcResult === null) return [];
      const tools = (rpcResult as Record<string, unknown>)["tools"];
      return Array.isArray(tools)
        ? tools.flatMap((tool) =>
            typeof tool === "object" &&
            tool !== null &&
            typeof (tool as Record<string, unknown>)["name"] === "string"
              ? [(tool as Record<string, string>)["name"] ?? ""]
              : [],
          )
        : [];
    },
  };
}
