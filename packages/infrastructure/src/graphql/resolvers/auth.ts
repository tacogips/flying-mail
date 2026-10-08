import type { GraphQLContext } from "../context";
import type { ViewerSource } from "./types";

export const authMutations = {
  /** Deliberately unauthenticated; the use case gates bootstrap by token. */
  async bootstrapAdmin(
    _parent: unknown,
    args: {
      readonly email: string;
      readonly name: string;
      readonly token: string;
    },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.bootstrapAdmin({
      email: args.email,
      name: args.name,
      token: args.token,
      clientIp: ctx.clientIp,
    });
  },

  /** Always resolves true for valid addresses to avoid account enumeration. */
  async requestEmailAuth(
    _parent: unknown,
    args: { readonly email: string; readonly turnstileToken?: string | null },
    ctx: GraphQLContext,
  ) {
    return ctx.usecases.requestEmailAuth({
      email: args.email,
      turnstileToken: args.turnstileToken ?? null,
      clientIp: ctx.clientIp,
    });
  },

  async verifyEmailAuthToken(
    _parent: unknown,
    args: { readonly token: string },
    ctx: GraphQLContext,
  ): Promise<{
    readonly viewer: ViewerSource;
    readonly expiresAt: string;
  }> {
    const result = await ctx.usecases.verifyEmailAuthToken(
      args.token,
      ctx.clientIp,
    );
    ctx.sessionCookies.setSession(
      result.token,
      new Date(result.session.expiresAt),
    );
    const [permissions, templatePermissions] = await Promise.all([
      ctx.deps.userMailPermissionRepository.listByUserId(result.user.id),
      ctx.deps.userTemplatePermissionRepository.listByUserId(result.user.id),
    ]);
    return {
      viewer: {
        viewer: {
          kind: "USER",
          userId: result.user.id,
          role: result.user.role,
          permissions,
          templatePermissions,
        },
      },
      expiresAt: result.session.expiresAt,
    };
  },

  async logout(_parent: unknown, _args: unknown, ctx: GraphQLContext) {
    ctx.sessionCookies.clearSession();
    return ctx.token === null ? true : ctx.usecases.logout(ctx.token);
  },
};
