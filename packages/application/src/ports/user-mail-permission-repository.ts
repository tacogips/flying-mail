import type { UserMailPermission } from "@flying-mail/domain/entities/user-mail-permission";
import type {
  UserId,
  UserMailPermissionId,
} from "@flying-mail/domain/value-objects/ids";

/** Persistence boundary for interactive-user mailbox permission rules. */
export interface UserMailPermissionRepository {
  findById(id: UserMailPermissionId): Promise<UserMailPermission | null>;
  listByUserId(userId: UserId): Promise<readonly UserMailPermission[]>;
  save(permission: UserMailPermission): Promise<void>;
  delete(id: UserMailPermissionId): Promise<void>;
}
