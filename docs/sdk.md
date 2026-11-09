# Client SDK

This documentation now lives on the website, which is the single source of truth
for product documentation.

<https://www.motherbase.site/docs/reference/sdk/>

## The compatibility matrix (contributors)

The authoritative list of what is supported, partial or missing is
[`packages/client/COMPATIBILITY.md`](../packages/client/COMPATIBILITY.md), generated
by the contract test `apps/server/tests/sdk-contract.integration.test.ts` running
every listed supabase-js call against a live server and a live Postgres:

```bash
npm run test -w apps/server -- sdk-contract
```

CI regenerates it and fails if the committed copy differs, which is what keeps it
from over-claiming or under-claiming. Do not maintain a second table by hand.
