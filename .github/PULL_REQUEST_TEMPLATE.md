<!-- Keep one concern per pull request. -->

## What and why

<!-- What changed, and the problem it solves. Link the issue if there is one. -->

## How it was verified

<!-- The commands you ran, and anything you exercised by hand. -->

## Checklist

- [ ] `npm run lint`, `npm run build` and `npm test` pass locally
      (`npm run infra` must be up for the integration tests)
- [ ] Behaviour changes are covered by tests
- [ ] Database changes are a new Prisma migration, not an edit to an applied one
- [ ] New environment variables are in `apps/server/config/env.ts` and
      `apps/server/.env.example`, or the setting went into the settings system
- [ ] User-visible changes update the matching page under `website/content/docs/`
      in this pull request
