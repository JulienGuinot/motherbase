'use client';

import { SubPage } from '@/shared/ui/SubPage';
import SettingsForm from '@/shared/ui/SettingsForm';
import { Section } from '@/shared/ui/Section';
import CodeBlock from '@/shared/ui/CodeBlock';
import type { FieldRenderer } from '@/shared/ui/SettingsFields';
import { CaptchaEndpointsPicker, CaptchaRoutesEditor, type CaptchaRoute } from '@/features/auth/components/CaptchaRoutesEditor';

const SNIPPET = `// The widget's response token, from hCaptcha or Turnstile, in the header the server checks.
const fetchOptions = { headers: { 'x-captcha-response': captchaToken } };
await client.auth.signUp.email({ email, password, name, fetchOptions });
await client.auth.signIn.email({ email, password, fetchOptions });
await client.auth.emailOtp.sendVerificationOtp({ email, type: 'sign-in', fetchOptions });
await client.auth.signIn.anonymous({ fetchOptions });
await client.auth.emailOtp.requestPasswordReset({ email, fetchOptions });

// Any other guarded route: the same token, in the x-captcha-response header.
await client.from('orders').insert(order).setHeader('x-captcha-response', captchaToken);
await client.functions.invoke('chat', { body, headers: { 'x-captcha-response': captchaToken } });`;

// The two route lists are JSON on the wire; edit them as checkboxes and rows.
const renderField: FieldRenderer = ({ field, values, setField, editable }) => {
  if (field.key === 'captchaAuthEndpoints') {
    return (
      <CaptchaEndpointsPicker
        all={(field.default as string[] | undefined) ?? []}
        value={(values.captchaAuthEndpoints as string[] | undefined) ?? []}
        disabled={!editable}
        onChange={next => setField('captchaAuthEndpoints', next)}
      />
    );
  }
  if (field.key === 'captchaRoutes') {
    return (
      <CaptchaRoutesEditor
        value={(values.captchaRoutes as CaptchaRoute[] | undefined) ?? []}
        disabled={!editable}
        onChange={next => setField('captchaRoutes', next)}
      />
    );
  }
  return undefined;
};

/** Supabase's Auth · Attack Protection: CAPTCHA, on auth and on any route, and the leaked-password check. */
export default function AttackProtection() {
  return (
    <SubPage
      title="Attack Protection"
      description="Stop bots at sign-up, sign-in, one-time codes and password recovery, or on any route of your API, including the tables you created, and refuse passwords that have already leaked. Changes apply live."
    >
      <SettingsForm group="auth.attackProtection" renderField={renderField} />
      <Section
        title="Sending the token"
        description="Once CAPTCHA is on, every guarded call without a token is refused with 400, and one with a bad token with 403. Verifying a code is not guarded: the request that sent it already was."
      >
        <CodeBlock value={SNIPPET} language="ts" label="client" />
      </Section>
    </SubPage>
  );
}
