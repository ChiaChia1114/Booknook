/** Organisation roles and the permission matrix (enforced server-side, mirrored in the UI). */

export const ROLES = ['owner', 'admin', 'manager', 'pilot', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Administrator',
  manager: 'Mission manager',
  pilot: 'Pilot / operator',
  viewer: 'Observer',
};

export const PERMISSIONS = [
  'org.manage',
  'org.delete',
  'members.manage',
  'fleet.manage',
  'drone.manage',
  'drone.control',
  'mission.edit',
  'flight.upload',
  'flight.edit',
  'airspace.manage',
  'authorization.request',
  'authorization.decide',
  'firmware.manage',
  'integrations.manage',
  'analytics.view',
  'live.view',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== 'org.delete'),
  manager: [
    'fleet.manage',
    'mission.edit',
    'flight.upload',
    'flight.edit',
    'airspace.manage',
    'authorization.request',
    'authorization.decide',
    'analytics.view',
    'live.view',
    'audit.view',
  ],
  pilot: ['drone.control', 'mission.edit', 'flight.upload', 'authorization.request', 'analytics.view', 'live.view'],
  viewer: ['analytics.view', 'live.view'],
};

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && MATRIX[role].includes(permission);
}

export function permissionsOf(role: Role): Permission[] {
  return [...MATRIX[role]];
}

/** Rank used to stop admins from managing owners, etc. Higher = more privileged. */
export const ROLE_RANK: Record<Role, number> = { owner: 5, admin: 4, manager: 3, pilot: 2, viewer: 1 };

/** May a member with role `actor` change or remove a member with role `target`? Not above their own role. */
export function canManageMember(actor: Role | null | undefined, target: Role): boolean {
  return !!actor && can(actor, 'members.manage') && ROLE_RANK[target] <= ROLE_RANK[actor];
}

/** Roles a member with role `actor` may grant: the owner role by owners only. */
export function grantableRoles(actor: Role | null | undefined): Role[] {
  if (!actor || !can(actor, 'members.manage')) return [];
  return ROLES.filter((r) => r !== 'owner' || actor === 'owner');
}
