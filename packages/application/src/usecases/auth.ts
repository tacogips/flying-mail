import {
  isApiKeyUsable,
  recordApiKeyUsage,
} from "@mailcal/domain/entities/api-key";
import { isSessionExpired } from "@mailcal/domain/entities/session";
import { isUserActive, type User } from "@mailcal/domain/entities/user";
import type { AppDependencies } from "../dependencies";
import type { Viewer } from "../policies/viewer";

/** Resolves a presented bearer/cookie token to a `Viewer`.
 *
 * Sessions are checked first, then API keys: the browser client's cookie is
 * the hot path, and a value can only ever be one of the two. Returns `null`
 * for anything unusable and never throws -- the HTTP middleware leaves
 * `viewer: null` and lets resolvers decide, so an expired credential
 * produces a clean `UNAUTHENTICATED` rather than a 500. */
export function createResolveViewerFromTokenUseCase(
  deps: AppDependencies,
): (token: string) => Promise<Viewer | null> {
  return async (token) => {
    if (token.length === 0) {
      return null;
    }
    const tokenHash = await deps.tokenHasher.hash(token);
    const now = deps.clock.now().toISOString();

    const session = await deps.sessionRepository.findByTokenHash(tokenHash);
    if (session !== null) {
      if (isSessionExpired(session, now)) {
        return null;
      }
      const user = await deps.userRepository.findById(session.userId);
      if (user === null || !isUserActive(user)) {
        return null;
      }
      // The three rule sets are loaded together: authorization for mail,
      // templates and calendars all consults the viewer snapshot, and a
      // partially-loaded viewer would silently under-authorize.
      const [permissions, templatePermissions, calendarPermissions] =
        await Promise.all([
          deps.userMailPermissionRepository.listByUserId(user.id),
          deps.userTemplatePermissionRepository.listByUserId(user.id),
          deps.userCalendarPermissionRepository.listByUserId(user.id),
        ]);
      return {
        kind: "USER",
        userId: user.id,
        role: user.role,
        permissions,
        templatePermissions,
        calendarPermissions,
      };
    }

    const apiKey = await deps.apiKeyRepository.findByKeyHash(tokenHash);
    if (apiKey === null || !isApiKeyUsable(apiKey, now)) {
      return null;
    }
    const scopesByKey = await deps.apiKeyRepository.listScopes([apiKey.id]);
    const scopes = scopesByKey.get(apiKey.id) ?? [];

    // Fire-and-forget: recording usage must never fail or delay a request.
    // A missed update only costs the operator a stale "last used" column.
    void deps.apiKeyRepository
      .save(recordApiKeyUsage(apiKey, now))
      .catch(() => undefined);

    return { kind: "API_KEY", apiKeyId: apiKey.id, scopes };
  };
}

/** Deletes the session behind a presented token. Returns `true` whether or
 * not one existed: a client logging out with an already-invalid cookie has
 * achieved what it asked for, and reporting otherwise would leak whether
 * the token was ever valid. */
export function createLogoutUseCase(
  deps: AppDependencies,
): (token: string) => Promise<boolean> {
  return async (token) => {
    if (token.length === 0) {
      return true;
    }
    const tokenHash = await deps.tokenHasher.hash(token);
    await deps.sessionRepository.deleteByTokenHash(tokenHash);
    return true;
  };
}

/** The `User` behind a viewer, or `null` for an API key viewer (which has no
 * user identity of its own -- see `Viewer`'s doc comment). */
export function createGetViewerUserUseCase(
  deps: AppDependencies,
): (viewer: Viewer) => Promise<User | null> {
  return async (viewer) =>
    viewer.kind === "USER" ? deps.userRepository.findById(viewer.userId) : null;
}
