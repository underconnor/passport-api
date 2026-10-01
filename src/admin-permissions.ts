import type { Administrator } from '@prisma/client';

export type AdminRole = 'owner' | 'operator' | 'viewer';
export type AdminPermission = 'read' | 'write' | 'manageOperators';
export function adminPermissions(admin: Pick<Administrator, 'enabled' | 'role' | 'revokedAt'> | null | undefined) {
  const active = Boolean(admin?.enabled && !admin.revokedAt && ['owner', 'operator', 'viewer'].includes(admin.role));
  return { read: active, write: active && (admin!.role === 'owner' || admin!.role === 'operator'), manageOperators: active && admin!.role === 'owner' };
}
/** The legacy game flag authorizes mutating commands. Never set it for viewers. */
export function gameAdministrator(admin: Pick<Administrator, 'enabled' | 'role' | 'revokedAt'> | null | undefined) { return adminPermissions(admin).write; }
