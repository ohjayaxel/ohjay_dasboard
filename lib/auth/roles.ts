export const Roles = {
  platformAdmin: 'platform_admin',
  admin: 'admin',
  editor: 'editor',
  viewer: 'viewer',
} as const;

export type Role = (typeof Roles)[keyof typeof Roles];

const WRITE_ROLES: Role[] = [Roles.platformAdmin, Roles.admin];

export function isPlatformAdmin(role: Role | null | undefined): role is Role {
  return role === Roles.platformAdmin;
}

export function canManageTenant(role: Role | null | undefined): boolean {
  if (!role) {
    return false;
  }

  return WRITE_ROLES.includes(role);
}

export function assertCanManageTenant(role: Role | null | undefined): void {
  if (!canManageTenant(role)) {
    throw new Error('Insufficient permissions to manage tenant resources.');
  }
}

