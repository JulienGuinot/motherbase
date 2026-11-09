import { describe, expect, it, vi } from 'vitest';
import { getGroup } from '../config/settings';
import {
  DEFAULT_AUTH_EMAIL_TEMPLATES,
  DEFAULT_AUTH_LINK_TEMPLATES,
  renderAuthOtpEmail,
  renderAuthLinkEmail,
  sendTemplatedAuthOtp,
  type AuthEmailTemplates,
  type AuthLinkTemplates,
} from '../auth/email-templates';

const verification = {
  email: 'person@example.com',
  otp: '123456',
  type: 'email-verification' as const,
};

describe('Auth email templates', () => {
  it('selects verification/recovery templates and escapes interpolated HTML values', () => {
    const templates: AuthEmailTemplates = {
      verificationSubject: '{{appName}} code for {{email}}',
      verificationBody: '<p>{{code}} for {{email}}</p>',
      recoverySubject: 'Recover {{appName}}',
      recoveryBody: '<p>Reset with {{code}}</p>',
    };

    expect(renderAuthOtpEmail(templates, {
      ...verification,
      email: 'person+<tag>@example.com',
      otp: '<123&>',
    }, 'Acme')).toEqual({
      subject: 'Acme code for person+<tag>@example.com',
      html: '<p>&lt;123&amp;&gt; for person+&lt;tag&gt;@example.com</p>',
    });
    expect(renderAuthOtpEmail(templates, { ...verification, type: 'forget-password' }, 'Acme')).toEqual({
      subject: 'Recover Acme',
      html: '<p>Reset with 123456</p>',
    });
  });

  it('falls back field-by-field for unknown variables or unsafe subjects', () => {
    expect(renderAuthOtpEmail({
      verificationSubject: 'Code\r\nBcc: attacker@example.com',
      verificationBody: '<p>{{secret}} {{code}}</p>',
    }, verification)).toEqual({
      subject: DEFAULT_AUTH_EMAIL_TEMPLATES.verificationSubject,
      html: 'Your code is 123456',
    });
  });

  it('reads registry-backed templates for every send so edits apply without rebuilding Auth', async () => {
    let templates: Partial<AuthEmailTemplates> = {
      verificationSubject: 'First',
      verificationBody: 'First code: {{code}}',
    };
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const deps = { loadTemplates: async () => templates, sendMail };

    await sendTemplatedAuthOtp(deps, verification);
    templates = { verificationSubject: 'Second', verificationBody: 'Second code: {{code}}' };
    await sendTemplatedAuthOtp(deps, verification);

    expect(sendMail.mock.calls.map(call => call[0].subject)).toEqual(['First', 'Second']);
    expect(sendMail.mock.calls[1][0]).toMatchObject({
      to: verification.email,
      html: 'Second code: 123456',
    });
  });

  it('keeps delivery available with safe defaults when settings loading fails', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    await sendTemplatedAuthOtp({
      loadTemplates: async () => { throw new Error('settings unavailable'); },
      sendMail,
    }, verification);

    expect(sendMail).toHaveBeenCalledWith({
      to: verification.email,
      subject: DEFAULT_AUTH_EMAIL_TEMPLATES.verificationSubject,
      html: 'Your code is 123456',
    });
  });

  it('rejects unknown variables, header injection and bodies without the code in the registry schema', () => {
    const schema = getGroup('email.templates')!.schema;
    const valid = {
      verificationSubject: 'Verify {{email}}',
      verificationBody: '<p>{{code}}</p>',
      recoverySubject: 'Recover {{appName}}',
      recoveryBody: '<p>{{code}}</p>',
    };
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse({ ...valid, verificationBody: '{{secret}} {{code}}' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, verificationSubject: 'Verify\r\nBcc: x@example.com' }).success).toBe(false);
    expect(schema.safeParse({ ...valid, recoveryBody: 'Contact support' }).success).toBe(false);
  });
});

describe('Auth link templates', () => {
  const args = { url: 'https://app.example.com/verify?token=abc&x=1', email: 'person@example.com' };

  it('renders the url token as an anchor and escapes the href + other variables', () => {
    const templates: AuthLinkTemplates = {
      magicLinkSubject: 'Sign in to {{appName}}',
      magicLinkBody: 'Hi {{email}}, open {{url}} to continue',
      verifyLinkSubject: 'Confirm {{email}}',
      verifyLinkBody: 'Verify: {{url}}',
    };

    expect(renderAuthLinkEmail(templates, 'magic-link', args, 'Acme')).toEqual({
      subject: 'Sign in to Acme',
      html: 'Hi person@example.com, open <a href="https://app.example.com/verify?token=abc&amp;x=1">https://app.example.com/verify?token=abc&amp;x=1</a> to continue',
    });
    expect(renderAuthLinkEmail(templates, 'verify', args, 'Acme').subject).toBe('Confirm person@example.com');
  });

  it('falls back to defaults when a body omits the required url variable', () => {
    const rendered = renderAuthLinkEmail(
      { magicLinkBody: 'No link here {{email}}' },
      'magic-link',
      args,
      'Acme',
    );
    // default magic-link body is "Click to sign in: {{url}}"
    expect(rendered.html).toContain('<a href="https://app.example.com/verify?token=abc&amp;x=1">');
    expect(rendered.html).toContain('Click to sign in:');
  });

  it('validates link templates in the registry schema (url required, no unknown vars)', () => {
    const schema = getGroup('email.templates')!.schema;
    const base = {
      verificationSubject: 'Verify {{email}}',
      verificationBody: '<p>{{code}}</p>',
      recoverySubject: 'Recover {{appName}}',
      recoveryBody: '<p>{{code}}</p>',
      magicLinkSubject: DEFAULT_AUTH_LINK_TEMPLATES.magicLinkSubject,
      magicLinkBody: 'Sign in: {{url}}',
      verifyLinkSubject: DEFAULT_AUTH_LINK_TEMPLATES.verifyLinkSubject,
      verifyLinkBody: 'Confirm: {{url}}',
    };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, magicLinkBody: 'No link {{email}}' }).success).toBe(false);
    expect(schema.safeParse({ ...base, verifyLinkBody: '{{code}} {{url}}' }).success).toBe(false);
    expect(schema.safeParse({ ...base, magicLinkSubject: 'Hi\r\nBcc: x@example.com' }).success).toBe(false);
  });
});
