export interface BuiltPolicy {
  command: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
  role: 'anon' | 'authenticated';
  using?: string;
  check?: string;
}
export interface RlsTemplate {
  id: string; label: string; description: string;
  build(opts: { ownerColumn?: string }): BuiltPolicy;
}

export const templates: RlsTemplate[] = [
  {
    id: 'owner', label: 'Owner only',
    description: 'Each user can only see and modify their own rows.',
    build: ({ ownerColumn = 'user_id' }) => ({
      command: 'ALL', role: 'authenticated',
      using: `auth.uid() = ${ownerColumn}`, check: `auth.uid() = ${ownerColumn}`,
    }),
  },
  {
    id: 'authenticated', label: 'Authenticated only',
    description: 'Any signed-in user has access.',
    build: () => ({ command: 'ALL', role: 'authenticated', using: 'auth.role() = \'authenticated\'' }),
  },
  {
    id: 'public_read', label: 'Public read',
    description: 'Anyone (even logged-out) can read.',
    build: () => ({ command: 'SELECT', role: 'anon', using: 'true' }),
  },
  {
    id: 'admin', label: 'Admin only',
    description: 'Only users whose JWT has user_role = ADMIN.',
    build: () => ({ command: 'ALL', role: 'authenticated', using: "auth.jwt() ->> 'user_role' = 'ADMIN'" }),
  },
];
