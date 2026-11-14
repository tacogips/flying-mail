import type { UserMailPermission } from "@mailcal/domain/entities/user-mail-permission";
import type {
  UserId,
  UserMailPermissionId,
} from "@mailcal/domain/value-objects/ids";

/** Persistence boundary for interactive-user mailbox permission rules. */
export interface UserMailPermissionRepository {
  findById(id: UserMailPermissionId): Promise<UserMailPermission | null>;
  listByUserId(userId: UserId): Promise<readonly UserMailPermission[]>;
  save(permission: UserMailPermission): Promise<void>;
  delete(id: UserMailPermissionId): Promise<void>;
}
