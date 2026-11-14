import type { AppDependencies } from "@mailcal/application/dependencies";
import type { Viewer } from "@mailcal/application/policies";
import type { UseCases } from "@mailcal/application/usecases";
import { createRequestLoaders, type RequestLoaders } from "./loaders";

/** One queued `Set-Cookie` header, recorded by a resolver and rendered by
 * `http/app.ts` after `yoga.fetch()` returns.
 *
 * Kept as plain data rather than a pre-built header string because only the
 * HTTP layer knows whether the request needs the cookie's `Secure`
 * attribute -- a browser refuses to store a `Secure` cookie set over plain
 * HTTP at all, which would break local development. */
export type SessionCookieIntent =
  | { readonly kind: "set"; readonly token: string; readonly expiresAt: Date }
  | { readonly kind: "clear" };

export interface SessionCookieCollector {
  setSession(token: string, expiresAt: Date): void;
  clearSession(): void;
  readonly intents: readonly SessionCookieIntent[];
}

function createSessionCookieCollector(): SessionCookieCollector {
  const intents: SessionCookieIntent[] = [];
  return {
    setSession(token, expiresAt) {
      intents.push({ kind: "set", token, expiresAt });
    },
    clearSession() {
      intents.push({ kind: "clear" });
    },
    intents,
  };
}

/** Per-request GraphQL execution context.
 *
 * `viewer` is `null` for unauthenticated requests -- the middleware never
 * rejects, so resolvers decide. `token` is the raw presented credential,
 * which is not derivable from `viewer` and is needed as-is by `logout` to
 * delete the exact session by its hash. */
export interface GraphQLContext {
  readonly viewer: Viewer | null;
  readonly token: string | null;
  readonly requestOrigin: string | null;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
  readonly loaders: RequestLoaders;
  readonly sessionCookies: SessionCookieCollector;
}

export function buildGraphQLContext(params: {
  readonly viewer: Viewer | null;
  readonly token: string | null;
  readonly requestOrigin?: string | null;
  readonly deps: AppDependencies;
  readonly usecases: UseCases;
}): GraphQLContext {
  return {
    viewer: params.viewer,
    token: params.token,
    requestOrigin: params.requestOrigin ?? null,
    deps: params.deps,
    usecases: params.usecases,
    loaders: createRequestLoaders(params.deps, params.viewer),
    sessionCookies: createSessionCookieCollector(),
  };
}
