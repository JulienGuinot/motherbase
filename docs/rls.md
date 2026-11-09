# PostgreSQL RLS in Motherbase

This documentation now lives on the website, which is the single source of truth
for product documentation.

<https://www.motherbase.site/docs/platform/rls/>

## Related code (contributors)

- `lib/rls-pool.ts` - transaction, role switch, claim injection
- `lib/rls-claims.ts` - request user to RLS claims
- `services/admin/rls.service.ts` - Studio policy management
- `services/rest-api/rest-api.service.ts` - REST data routes under RLS
- `services/admin/advisor.service.ts` - RLS/security findings
- `services/admin/rls-simulator.service.ts` - simulator and policy attribution (CLI, MCP)
- `services/admin/rls-access.ts` - per-role, per-command access read off grants and policies
- `apps/studio/src/features/database/pages/RoleAccess.tsx` - the Studio page

The RLS foundation itself is migration `20260617000000_rls_foundation`.
