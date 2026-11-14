import { Capability } from "@flying-mail/domain/entities/api-key";
import { UserRole } from "@flying-mail/domain/entities/user";
import { UserPermissionEffect } from "@flying-mail/domain/entities/user-mail-permission";
import {
  createDomainId,
  createUserId,
  createUserMailPermissionId,
} from "@flying-mail/domain/value-objects/ids";
import type { UserWithPermissions } from "@flying-mail/application/usecases/users";
import { defineTool } from "../tool-types";

const USER_ADMIN = [Capability.UserAdmin];

const annotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function toUserView(value: UserWithPermissions) {
  const { user, permissions } = value;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    active: user.deactivatedAt === null,
    invitation_accepted: user.invitationAcceptedAt !== null,
    permissions: permissions.map((permission) => ({
      id: permission.id,
      effect: permission.effect,
      domain_id: permission.domainId,
      address_pattern: permission.addressPattern,
    })),
  };
}

export const USER_ADMIN_TOOLS = [
  defineTool({
    name: "list_users",
    title: "List users",
    description: "List users and their mailbox permissions.",
    visibleWith: USER_ADMIN,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    input: {},
    execute: async (_args, ctx) => {
      const users = await ctx.usecases.listUsers(ctx.viewer);
      return {
        summary: `Listed ${users.length} users.`,
        structured: { users: users.map(toUserView) },
        containsUntrusted: false,
      };
    },
  }),
  defineTool({
    name: "set_user_role",
    title: "Set user role",
    description: "Set an existing user's role to ADMIN or MEMBER.",
    visibleWith: USER_ADMIN,
    annotations,
    input: {
      user_id: {
        kind: "string",
        format: "id",
        required: true,
        maxLength: 128,
        description: "The user ID.",
      },
      role: {
        kind: "string",
        enum: [UserRole.Admin, UserRole.Member],
        required: true,
        maxLength: 16,
        description: "The role to assign.",
      },
    },
    execute: async (args, ctx) => {
      const user = await ctx.usecases.setUserRole(
        ctx.viewer,
        createUserId(args.user_id),
        args.role,
      );
      return {
        summary: `User ${user.user.id} role set to ${user.user.role}.`,
        structured: { user: toUserView(user) },
        containsUntrusted: false,
      };
    },
  }),
  defineTool({
    name: "set_user_active",
    title: "Set user active state",
    description: "Activate or deactivate an existing user.",
    visibleWith: USER_ADMIN,
    annotations,
    input: {
      user_id: {
        kind: "string",
        format: "id",
        required: true,
        maxLength: 128,
        description: "The user ID.",
      },
      active: {
        kind: "boolean",
        required: true,
        description: "Whether the user should be active.",
      },
    },
    execute: async (args, ctx) => {
      const user = await ctx.usecases.setUserActive(
        ctx.viewer,
        createUserId(args.user_id),
        args.active,
      );
      return {
        summary: `User ${user.user.id} active set to ${args.active}.`,
        structured: { user: toUserView(user) },
        containsUntrusted: false,
      };
    },
  }),
  defineTool({
    name: "add_mail_permission",
    title: "Add mail permission",
    description: "Add an ALLOW or DENY mailbox permission for a user.",
    visibleWith: USER_ADMIN,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    input: {
      user_id: {
        kind: "string",
        format: "id",
        required: true,
        maxLength: 128,
        description: "The user ID.",
      },
      effect: {
        kind: "string",
        enum: [UserPermissionEffect.Allow, UserPermissionEffect.Deny],
        required: true,
        maxLength: 8,
        description: "Whether this permission allows or denies access.",
      },
      domain_id: {
        kind: "string",
        format: "id",
        maxLength: 128,
        description: "Optional domain ID; omitted means all domains.",
      },
      address_pattern: {
        kind: "string",
        required: true,
        maxLength: 320,
        description:
          "The mailbox address pattern, including * for all addresses.",
      },
    },
    execute: async (args, ctx) => {
      const permission = await ctx.usecases.addUserMailPermission(
        ctx.viewer,
        createUserId(args.user_id),
        {
          effect: args.effect,
          domainId:
            args.domain_id === undefined
              ? null
              : createDomainId(args.domain_id),
          addressPattern: args.address_pattern,
        },
      );
      return {
        summary: `Added ${permission.effect} permission ${permission.id} for user ${permission.userId}.`,
        structured: {
          permission: {
            id: permission.id,
            user_id: permission.userId,
            effect: permission.effect,
            domain_id: permission.domainId,
            address_pattern: permission.addressPattern,
          },
        },
        containsUntrusted: false,
      };
    },
  }),
  defineTool({
    name: "remove_mail_permission",
    title: "Remove mail permission",
    description: "Remove an existing mailbox permission.",
    visibleWith: USER_ADMIN,
    annotations,
    input: {
      permission_id: {
        kind: "string",
        format: "id",
        required: true,
        maxLength: 128,
        description: "The permission ID.",
      },
    },
    execute: async (args, ctx) => {
      const removed = await ctx.usecases.removeUserMailPermission(
        ctx.viewer,
        createUserMailPermissionId(args.permission_id),
      );
      return {
        summary: `Removed permission ${args.permission_id}.`,
        structured: { removed, permission_id: args.permission_id },
        containsUntrusted: false,
      };
    },
  }),
] as const;
