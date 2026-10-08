import type { AppDependencies } from "@flying-mail/application/dependencies";
import type { Viewer } from "@flying-mail/application/policies";
import type { UseCases } from "@flying-mail/application/usecases";
import type { MailEventScope } from "@flying-mail/domain/entities/mail-event";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";
import {
  executeSubscriptionEvent,
  getArgumentValues,
  GraphQLError,
  type DocumentNode,
  type FieldNode,
  type FormattedExecutionResult,
  type GraphQLFormattedError,
  type GraphQLSchema,
  type OperationDefinitionNode,
  Kind,
  parse,
  validate,
  validateSubscriptionArgs,
  type ValidatedSubscriptionArgs,
} from "graphql";
import { buildGraphQLContext } from "../graphql/context";
import { DEFAULT_MAX_DEPTH, documentDepth } from "../graphql/depth-limit";
import { toGraphQLError } from "../graphql/errors";
import {
  DEFAULT_MAX_SELECTIONS,
  documentSelectionCount,
} from "../graphql/selection-limit";
import type { MailEventPayload } from "./mail-event-payload";

const PARSED_DOCUMENT_CACHE_LIMIT = 64;
const parsedDocumentCache = new Map<string, DocumentNode>();
const validatedArgsKey: unique symbol = Symbol("validatedSubscriptionArgs");

type PreparedSubscriptionInternal = PreparedSubscription & {
  readonly [validatedArgsKey]: ValidatedSubscriptionArgs;
};

export interface SubscribeRequest {
  readonly query: string;
  readonly operationName?: string | null;
  readonly variables?: Record<string, unknown> | null;
}

export interface PreparedSubscription {
  readonly scope: MailEventScope;
  readonly after: string | null;
  readonly [validatedArgsKey]: ValidatedSubscriptionArgs;
}

export type PrepareResult =
  | { readonly ok: true; readonly prepared: PreparedSubscription }
  | {
      readonly ok: false;
      readonly errors: readonly GraphQLFormattedError[];
    };

export interface SubscriptionExecutor {
  prepare(request: SubscribeRequest, viewer: Viewer): PrepareResult;
  execute(
    prepared: PreparedSubscription,
    payload: MailEventPayload,
    viewer: Viewer,
  ): Promise<FormattedExecutionResult>;
}

export interface SubscriptionExecutorOptions {
  readonly schema: GraphQLSchema;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly publicOrigin: string | null;
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

/** Synchronous SHA-256 keeps preparation runtime-neutral and cache keys stable. */
function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15] ?? 0;
      const y = words[index - 2] ?? 0;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] =
        ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const e1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 =
        (h + e1 + choice + (SHA256_K[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const a1 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (a1 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return hash.map((part) => part.toString(16).padStart(8, "0")).join("");
}

function parsedDocument(query: string): DocumentNode {
  const key = sha256Hex(query);
  const cached = parsedDocumentCache.get(key);
  if (cached !== undefined) {
    parsedDocumentCache.delete(key);
    parsedDocumentCache.set(key, cached);
    return cached;
  }
  const document = parse(query);
  parsedDocumentCache.set(key, document);
  if (parsedDocumentCache.size > PARSED_DOCUMENT_CACHE_LIMIT) {
    const oldest = parsedDocumentCache.keys().next().value;
    if (oldest !== undefined) {
      parsedDocumentCache.delete(oldest);
    }
  }
  return document;
}

function formattedErrors(
  errors: readonly Error[],
): readonly GraphQLFormattedError[] {
  return errors.map((error) => {
    const formatted = toGraphQLError(error).toJSON();
    return {
      ...formatted,
      extensions: {
        ...formatted.extensions,
        code: formatted.extensions?.["code"] ?? "BAD_USER_INPUT",
      },
    };
  });
}

function badInput(message: string, field?: string): PrepareResult {
  const error = new GraphQLError(message, {
    extensions:
      field === undefined
        ? { code: "BAD_USER_INPUT" }
        : { code: "BAD_USER_INPUT", field },
  });
  return {
    ok: false,
    errors: [error.toJSON()],
  };
}

function selectedOperation(
  document: DocumentNode,
  operationName: string | null | undefined,
): OperationDefinitionNode | null {
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (operationName !== null && operationName !== undefined) {
    return (
      operations.find((operation) => operation.name?.value === operationName) ??
      null
    );
  }
  return operations.length === 1 ? (operations[0] ?? null) : null;
}

function rootMailEventField(
  operation: OperationDefinitionNode,
): FieldNode | null {
  const [selection] = operation.selectionSet.selections;
  return selection?.kind === Kind.FIELD &&
    selection.name.value === "mailEvents" &&
    operation.selectionSet.selections.length === 1
    ? selection
    : null;
}

function coerceScope(value: unknown): MailEventScope | null {
  if (value === null || value === undefined) {
    return { domainId: null, address: null };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const scope = value as {
    readonly domainId?: unknown;
    readonly address?: unknown;
  };
  let address: string | null = null;
  if (scope.address !== undefined && scope.address !== null) {
    if (typeof scope.address !== "string") {
      return null;
    }
    try {
      address = createEmailAddress(
        scope.address.trim().toLowerCase(),
        "scope.address",
      );
    } catch {
      return null;
    }
  }
  if (
    scope.domainId !== undefined &&
    scope.domainId !== null &&
    typeof scope.domainId !== "string"
  ) {
    return null;
  }
  return {
    domainId: (scope.domainId ?? null) as MailEventScope["domainId"],
    address,
  };
}

export function createSubscriptionExecutor(
  options: SubscriptionExecutorOptions,
): SubscriptionExecutor {
  return {
    prepare(request, viewer) {
      void viewer;
      let document: DocumentNode;
      try {
        document = parsedDocument(request.query);
      } catch (error) {
        return { ok: false, errors: formattedErrors([toGraphQLError(error)]) };
      }

      if (documentDepth(document) > DEFAULT_MAX_DEPTH) {
        return badInput(
          `Query is too deep: maximum depth is ${DEFAULT_MAX_DEPTH}`,
        );
      }
      if (documentSelectionCount(document) > DEFAULT_MAX_SELECTIONS) {
        return badInput(
          `Query has too many selections: maximum is ${DEFAULT_MAX_SELECTIONS}`,
        );
      }

      const validationErrors = validate(options.schema, document);
      if (validationErrors.length > 0) {
        return { ok: false, errors: formattedErrors(validationErrors) };
      }

      const operation = selectedOperation(document, request.operationName);
      if (operation === null || operation.operation !== "subscription") {
        return badInput("A mailEvents subscription operation is required");
      }
      const fieldNode = rootMailEventField(operation);
      if (fieldNode === null) {
        return badInput(
          "A subscription must select exactly one mailEvents root field",
        );
      }

      const validated = validateSubscriptionArgs({
        schema: options.schema,
        document,
        operationName: request.operationName ?? undefined,
        contextValue: { viewer: null },
        ...(request.variables === null || request.variables === undefined
          ? {}
          : { variableValues: request.variables }),
      });
      if (!("operation" in validated)) {
        return { ok: false, errors: formattedErrors(validated) };
      }
      const validatedArgs = validated;

      const subscriptionType = options.schema.getSubscriptionType();
      const fieldDefinition = subscriptionType?.getFields()["mailEvents"];
      if (fieldDefinition === undefined) {
        return badInput("mailEvents subscription is unavailable");
      }
      let args: Record<string, unknown>;
      try {
        args = getArgumentValues(
          fieldDefinition,
          fieldNode,
          validatedArgs.variableValues,
        );
      } catch (error) {
        return { ok: false, errors: formattedErrors([toGraphQLError(error)]) };
      }
      const scope = coerceScope(args["scope"]);
      if (scope === null) {
        return badInput(
          "scope.address is not a valid email address",
          "scope.address",
        );
      }
      const afterValue = args["after"];
      if (
        afterValue !== null &&
        afterValue !== undefined &&
        typeof afterValue !== "string"
      ) {
        return badInput("after must be a string or null", "after");
      }
      const prepared: PreparedSubscriptionInternal = {
        scope,
        after: (afterValue ?? null) as string | null,
        [validatedArgsKey]: validatedArgs,
      };
      return { ok: true, prepared };
    },
    async execute(prepared, payload, viewer) {
      const contextValue = buildGraphQLContext({
        viewer,
        token: null,
        requestOrigin: options.publicOrigin,
        clientIp: null,
        deps: options.deps,
        usecases: options.usecases,
      });
      try {
        const result = await executeSubscriptionEvent({
          ...prepared[validatedArgsKey],
          rootValue: { mailEvents: payload },
          contextValue,
        });
        if (result.errors === undefined || result.errors.length === 0) {
          return result as FormattedExecutionResult;
        }
        return {
          ...result,
          errors: result.errors.map((error) => toGraphQLError(error).toJSON()),
        } as FormattedExecutionResult;
      } catch (error) {
        return {
          data: null,
          errors: [toGraphQLError(error).toJSON()],
        };
      }
    },
  };
}
