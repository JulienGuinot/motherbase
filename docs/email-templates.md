# Transactional email templates

Motherbase ships editable transactional auth emails. Subjects and bodies are stored
as project settings, edited from Project Studio, and read at send time. There is no
container restart, no rebuild, and no environment file to touch.

## Where to edit them

Project Studio, **Authentication → Settings → Email templates** (route `/auth/settings`,
`apps/studio/src/features/auth/pages/AuthSettings.tsx:49`). The page renders the
`email.templates` settings group through the shared settings panel, so the fields,
their validation, and their defaults come from one place on the server.

The same group is reachable from the CLI:

```bash
motherbase config get email.templates
motherbase config set email.templates verificationSubject="Confirm your sign-in"
```

## The eight fields

Defined by `emailTemplates` in `apps/server/config/settings/messaging.groups.ts` (group key `email.templates`),
with defaults in `apps/server/auth/email-templates.ts`.

| Field | Used for | Required variable |
|---|---|---|
| `verificationSubject` | Email OTP, verification subject | none |
| `verificationBody` | Email OTP, verification body | `{{code}}` |
| `recoverySubject` | Password reset subject | none |
| `recoveryBody` | Password reset body | `{{code}}` |
| `magicLinkSubject` | Magic-link sign-in subject | none |
| `magicLinkBody` | Magic-link sign-in body | `{{url}}` |
| `verifyLinkSubject` | Verification-link subject | none |
| `verifyLinkBody` | Verification-link body | `{{url}}` |

Defaults, if nothing is set:

```text
verificationSubject   Verify your email
verificationBody      Your code is {{code}}
recoverySubject       Reset your password
recoveryBody          Your reset code is {{code}}
magicLinkSubject      Your sign-in link
magicLinkBody         Click to sign in: {{url}}
verifyLinkSubject     Verify your email
verifyLinkBody        Confirm your email address: {{url}}
```

## Variables

Two allowlists, one per template family.

- Code templates (`verification*`, `recovery*`): `{{appName}}`, `{{code}}`, `{{email}}`.
  `{{code}}` is mandatory, since a verification email without the code is useless.
- Link templates (`magicLink*`, `verifyLink*`): `{{appName}}`, `{{url}}`, `{{email}}`.
  `{{url}}` is mandatory.

Anything else is rejected. The allowlists are the constants
`AUTH_EMAIL_TEMPLATE_VARIABLES` and `AUTH_LINK_TEMPLATE_VARIABLES` in
`apps/server/auth/email-templates.ts:4` and `:122`.

## Validation

Each field has a zod refinement in the settings registry
(`messaging.groups.ts`, the `authEmail*`/`authLink*` schemas), so an invalid template is refused at save time with
a readable message instead of producing a broken email later:

- subjects: 1 to 200 characters, no CR or LF (header injection),
- bodies: 1 to 20000 characters,
- only allowlisted variables, and no stray `{{` or `}}`,
- the mandatory variable of the family must be present.

Rendering is defensive on top of that. `interpolate` and `interpolateLink`
(`email-templates.ts:74` and `:167`) re-check the stored template and silently fall
back to the default if it does not validate, so a template written before a rule
changed cannot break delivery. Values are HTML-escaped in bodies; in link bodies
`{{url}}` is rendered as an `<a href>` with the URL escaped as an attribute.

## No restart

`sendTemplatedAuthOtp` calls `loadTemplates()` on every send
(`email-templates.ts:105`), which `AuthManager` wires to
`SettingsService.get('email.templates')` (`apps/server/auth/auth-manager.ts:205`,
`:240`, `:247`). `SettingsService` caches the group in memory and deletes that cache
entry on every save and reset (`apps/server/services/settings.service.ts:176`, `:184`).
A save therefore applies to the next email sent. If the settings store is briefly
unreachable, delivery continues with the built-in defaults rather than failing.

Environment variables still work as a fallback when no override is stored:
`EMAIL_VERIFICATION_SUBJECT`, `EMAIL_VERIFICATION_BODY`, `EMAIL_RECOVERY_SUBJECT`,
`EMAIL_RECOVERY_BODY` (`messaging.groups.ts`, `emailTemplates.envFallback`). They cover the four code
templates only: the two link families fall back to their built-in defaults. They are
a starting point, not the editing surface.

## Contrast with Supabase

- Self-hosted Supabase configures templates through environment variables on the
  auth container, so changing an email means editing a `.env` and restarting the
  container. Here it is a form field that takes effect on the next send.
- Supabase removed template customisation from its free tier on 3 June 2026. In
  Motherbase it is part of the product, on every project, at no tier.

## Related

- Delivery settings (SMTP host, sender) live next door in the `email.smtp` group on
  the same Studio page.
- Unit coverage: `apps/server/tests/auth-email-templates.unit.test.ts`.
