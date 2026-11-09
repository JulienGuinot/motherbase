import { APP_NAME } from '../constants/app.constants';
import type { OtpArgs } from './instance';

const AUTH_EMAIL_TEMPLATE_VARIABLES = ['appName', 'code', 'email'] as const;
type AuthEmailTemplateVariable = (typeof AUTH_EMAIL_TEMPLATE_VARIABLES)[number];

export interface AuthEmailTemplates {
  verificationSubject: string;
  verificationBody: string;
  recoverySubject: string;
  recoveryBody: string;
}

export const DEFAULT_AUTH_EMAIL_TEMPLATES: Readonly<AuthEmailTemplates> = Object.freeze({
  verificationSubject: 'Verify your email',
  verificationBody: 'Your code is {{code}}',
  recoverySubject: 'Reset your password',
  recoveryBody: 'Your reset code is {{code}}',
});

interface MailOptions {
  to: string;
  subject: string;
  html: string;
}

interface OtpEmailDeps {
  loadTemplates: () => Promise<Partial<AuthEmailTemplates>>;
  sendMail: (options: MailOptions) => Promise<unknown>;
  appName?: string;
}

const TOKEN = /{{\s*([a-zA-Z][a-zA-Z0-9]*)\s*}}/g;
const ALLOWED_VARIABLES = new Set<string>(AUTH_EMAIL_TEMPLATE_VARIABLES);

function parsedVariables(template: string): string[] | undefined {
  const variables: string[] = [];
  const remainder = template.replace(TOKEN, (_token, name: string) => {
    variables.push(name);
    return '';
  });
  return remainder.includes('{{') || remainder.includes('}}') ? undefined : variables;
}

function hasOnlyAuthEmailTemplateVariables(template: string): boolean {
  const variables = parsedVariables(template);
  return variables !== undefined && variables.every(variable => ALLOWED_VARIABLES.has(variable));
}

function hasAuthEmailTemplateVariable(template: string, variable: AuthEmailTemplateVariable): boolean {
  return parsedVariables(template)?.includes(variable) ?? false;
}

export function isSafeAuthEmailSubjectTemplate(template: string): boolean {
  return template.length > 0 && template.length <= 200 && !/[\r\n]/.test(template)
    && hasOnlyAuthEmailTemplateVariables(template);
}

export function isSafeAuthEmailBodyTemplate(template: string): boolean {
  return template.length > 0 && template.length <= 20_000
    && hasOnlyAuthEmailTemplateVariables(template)
    && hasAuthEmailTemplateVariable(template, 'code');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function interpolate(
  candidate: unknown,
  fallback: string,
  variables: Record<AuthEmailTemplateVariable, string>,
  html: boolean,
): string {
  const template = typeof candidate === 'string' && candidate ? candidate : fallback;
  const valid = html ? isSafeAuthEmailBodyTemplate(template) : isSafeAuthEmailSubjectTemplate(template);
  const selected = valid ? template : fallback;
  return selected.replace(TOKEN, (_token, name: AuthEmailTemplateVariable) => {
    const value = variables[name];
    return html ? escapeHtml(value) : value.replace(/[\r\n]/g, ' ');
  });
}

export function renderAuthOtpEmail(
  templates: Partial<AuthEmailTemplates> | undefined,
  args: OtpArgs,
  appName = APP_NAME,
): Pick<MailOptions, 'subject' | 'html'> {
  const recovery = args.type === 'forget-password';
  const variables = { appName, code: args.otp, email: args.email };
  const subjectKey = recovery ? 'recoverySubject' : 'verificationSubject';
  const bodyKey = recovery ? 'recoveryBody' : 'verificationBody';
  return {
    subject: interpolate(templates?.[subjectKey], DEFAULT_AUTH_EMAIL_TEMPLATES[subjectKey], variables, false),
    html: interpolate(templates?.[bodyKey], DEFAULT_AUTH_EMAIL_TEMPLATES[bodyKey], variables, true),
  };
}

/** Resolve the registry-backed template at send time so edits apply immediately. */
export async function sendTemplatedAuthOtp(deps: OtpEmailDeps, args: OtpArgs): Promise<void> {
  let templates: Partial<AuthEmailTemplates> = DEFAULT_AUTH_EMAIL_TEMPLATES;
  try {
    templates = await deps.loadTemplates();
  } catch {
    // Email delivery remains available when settings storage is temporarily down.
  }
  await deps.sendMail({
    to: args.email,
    ...renderAuthOtpEmail(templates, args, deps.appName),
  });
}

// ── Link-based templates (magic-link sign-in, email-verification link) ──────
// These carry a clickable {{url}} instead of an OTP {{code}}. The url token is
// rendered as an <a> anchor in the HTML body; other variables are escaped text.

const AUTH_LINK_TEMPLATE_VARIABLES = ['appName', 'url', 'email'] as const;
type AuthLinkTemplateVariable = (typeof AUTH_LINK_TEMPLATE_VARIABLES)[number];

export type AuthLinkKind = 'magic-link' | 'verify';

export interface AuthLinkTemplates {
  magicLinkSubject: string;
  magicLinkBody: string;
  verifyLinkSubject: string;
  verifyLinkBody: string;
}

export const DEFAULT_AUTH_LINK_TEMPLATES: Readonly<AuthLinkTemplates> = Object.freeze({
  magicLinkSubject: 'Your sign-in link',
  magicLinkBody: 'Click to sign in: {{url}}',
  verifyLinkSubject: 'Verify your email',
  verifyLinkBody: 'Confirm your email address: {{url}}',
});

const ALLOWED_LINK_VARIABLES = new Set<string>(AUTH_LINK_TEMPLATE_VARIABLES);

function hasOnlyLinkVariables(template: string): boolean {
  const variables = parsedVariables(template);
  return variables !== undefined && variables.every(v => ALLOWED_LINK_VARIABLES.has(v));
}

export function isSafeAuthLinkSubjectTemplate(template: string): boolean {
  return template.length > 0 && template.length <= 200 && !/[\r\n]/.test(template)
    && hasOnlyLinkVariables(template);
}

export function isSafeAuthLinkBodyTemplate(template: string): boolean {
  return template.length > 0 && template.length <= 20_000
    && hasOnlyLinkVariables(template)
    && (parsedVariables(template)?.includes('url') ?? false);
}

function escapeUrlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function interpolateLink(
  candidate: unknown,
  fallback: string,
  variables: Record<AuthLinkTemplateVariable, string>,
  html: boolean,
): string {
  const template = typeof candidate === 'string' && candidate ? candidate : fallback;
  const valid = html ? isSafeAuthLinkBodyTemplate(template) : isSafeAuthLinkSubjectTemplate(template);
  const selected = valid ? template : fallback;
  return selected.replace(TOKEN, (_token, name: AuthLinkTemplateVariable) => {
    const value = variables[name] ?? '';
    if (!html) return value.replace(/[\r\n]/g, ' ');
    if (name === 'url') return `<a href="${escapeUrlAttr(value)}">${escapeHtml(value)}</a>`;
    return escapeHtml(value);
  });
}

export function renderAuthLinkEmail(
  templates: Partial<AuthLinkTemplates> | undefined,
  kind: AuthLinkKind,
  args: { url: string; email: string },
  appName = APP_NAME,
): Pick<MailOptions, 'subject' | 'html'> {
  const variables = { appName, url: args.url, email: args.email };
  const subjectKey = kind === 'magic-link' ? 'magicLinkSubject' : 'verifyLinkSubject';
  const bodyKey = kind === 'magic-link' ? 'magicLinkBody' : 'verifyLinkBody';
  return {
    subject: interpolateLink(templates?.[subjectKey], DEFAULT_AUTH_LINK_TEMPLATES[subjectKey], variables, false),
    html: interpolateLink(templates?.[bodyKey], DEFAULT_AUTH_LINK_TEMPLATES[bodyKey], variables, true),
  };
}
