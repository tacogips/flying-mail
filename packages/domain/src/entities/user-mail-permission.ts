import type { AddressPattern } from "../value-objects/address-pattern";
import type {
  DomainId,
  UserId,
  UserMailPermissionId,
} from "../value-objects/ids";

/** Whether a mailbox rule grants or explicitly removes access. */
export enum UserPermissionEffect {
  Allow = "ALLOW",
  Deny = "DENY",
}

/** One immutable mailbox-access rule assigned to an interactive user. */
export interface UserMailPermission {
  readonly id: UserMailPermissionId;
  readonly userId: UserId;
  readonly effect: UserPermissionEffect;
  /** `null` means the rule may match mail in every managed domain. */
  readonly domainId: DomainId | null;
  readonly addressPattern: AddressPattern;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}

export interface CreateUserMailPermissionInput {
  readonly id: UserMailPermissionId;
  readonly userId: UserId;
  readonly effect: UserPermissionEffect;
  readonly domainId: DomainId | null;
  readonly addressPattern: AddressPattern;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}

/** Creates a permission from already-validated IDs and address pattern. */
export function createUserMailPermission(
  input: CreateUserMailPermissionInput,
): UserMailPermission {
  return {
    id: input.id,
    userId: input.userId,
    effect: input.effect,
    domainId: input.domainId,
    addressPattern: input.addressPattern,
    createdByUserId: input.createdByUserId,
    createdAt: input.createdAt,
  };
}
