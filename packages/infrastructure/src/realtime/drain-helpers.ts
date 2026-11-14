import { MailEventType } from "@flying-mail/domain/entities/mail-event";
import type { MailEventScope } from "@flying-mail/domain/entities/mail-event";
import { createEmailAddress } from "@flying-mail/domain/value-objects/email-address";

export function coerceScope(value: unknown) {
  if (value === null || value === undefined) {
    return {
      ok: true as const,
      scope: { domainId: null, address: null, types: null },
    };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false as const,
      field: "scope.address" as const,
      message: "scope.address is not a valid email address",
    };
  }
  const scope = value as {
    readonly domainId?: unknown;
    readonly address?: unknown;
    readonly types?: unknown;
  };
  let address: string | null = null;
  if (scope.address !== undefined && scope.address !== null) {
    if (typeof scope.address !== "string") {
      return {
        ok: false as const,
        field: "scope.address" as const,
        message: "scope.address is not a valid email address",
      };
    }
    try {
      address = createEmailAddress(
        scope.address.trim().toLowerCase(),
        "scope.address",
      );
    } catch {
      return {
        ok: false as const,
        field: "scope.address" as const,
        message: "scope.address is not a valid email address",
      };
    }
  }
  if (
    scope.domainId !== undefined &&
    scope.domainId !== null &&
    typeof scope.domainId !== "string"
  ) {
    return {
      ok: false as const,
      field: "scope.address" as const,
      message: "scope.address is not a valid email address",
    };
  }
  let types: readonly MailEventType[] | null = null;
  if (scope.types !== undefined && scope.types !== null) {
    if (!Array.isArray(scope.types)) {
      return {
        ok: false as const,
        field: "scope.types" as const,
        message: "scope.types must be a list of event types",
      };
    }
    const requestedTypes: readonly unknown[] = scope.types;
    if (requestedTypes.length === 0) {
      return {
        ok: false as const,
        field: "scope.types" as const,
        message: "scope.types must list at least one event type",
      };
    }
    if (requestedTypes.includes("LIVE")) {
      return {
        ok: false as const,
        field: "scope.types" as const,
        message: "scope.types cannot include LIVE; it is always delivered",
      };
    }
    const eventTypes = Object.values(MailEventType);
    if (
      !requestedTypes.every(
        (type): type is MailEventType =>
          typeof type === "string" &&
          eventTypes.includes(type as MailEventType),
      )
    ) {
      return {
        ok: false as const,
        field: "scope.types" as const,
        message: "scope.types contains an unknown event type",
      };
    }
    types = eventTypes.filter((type) => requestedTypes.includes(type));
  }
  return {
    ok: true as const,
    scope: {
      domainId: (scope.domainId ?? null) as MailEventScope["domainId"],
      address,
      types,
    },
  };
}

export function matchesScope(
  scope: MailEventScope,
  row: {
    readonly domainId: string;
    readonly addresses: readonly string[];
    readonly type: MailEventType;
  },
): boolean {
  if (scope.domainId !== null && row.domainId !== scope.domainId) return false;
  if (
    scope.address !== null &&
    !row.addresses.some(
      (address) => address.trim().toLowerCase() === scope.address,
    )
  ) {
    return false;
  }
  return scope.types == null || scope.types.includes(row.type);
}

export function graphqlError(
  code: string,
  message: string,
): readonly unknown[] {
  return [{ message, extensions: { code } }];
}
