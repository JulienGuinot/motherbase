import { z } from 'zod';
import {
  DEFAULT_AUTH_EMAIL_TEMPLATES,
  DEFAULT_AUTH_LINK_TEMPLATES,
  isSafeAuthEmailBodyTemplate,
  isSafeAuthEmailSubjectTemplate,
  isSafeAuthLinkBodyTemplate,
  isSafeAuthLinkSubjectTemplate,
} from '../../auth/email-templates';
import type { GroupDef } from './types';

export const emailSmtp: GroupDef = {
  key: 'email.smtp',
  label: 'Email · SMTP',
  fields: [
    { key: 'host', label: 'SMTP host', type: 'text', required: true, placeholder: 'smtp.example.com' },
    { key: 'port', label: 'Port', type: 'number', required: true, default: 465 },
    { key: 'username', label: 'Username', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'password', secret: true },
    { key: 'from', label: 'From address', type: 'text', placeholder: 'noreply@myapp.io' },
    { key: 'secure', label: 'Secure (TLS)', type: 'bool', default: true },
  ],
  schema: z.object({
    host: z.string().min(1, 'host is required'),
    port: z.coerce.number().int().positive(),
    username: z.string().min(1, 'username is required'),
    password: z.string().optional().default(''),
    from: z.string().optional().default(''),
    secure: z.coerce.boolean().default(true),
  }),
  envFallback: () => ({
    host: process.env.EMAIL_SMTP_HOST || '',
    port: 465,
    username: process.env.EMAIL_SMTP_USERNAME || '',
    password: process.env.EMAIL_SMTP_PASSWORD || '',
    from: process.env.EMAIL_SMTP_USERNAME || '',
    secure: true,
  }),
};


// A transport, like email.smtp: it has no on/off switch of its own, so phone
// sign-in never needs two toggles on two pages. What uses SMS is switched on
// where it is configured: auth.phoneOtp for sign-in, auth.twoFactor for second
// factors.
export const phoneSms: GroupDef = {
  key: 'phone.sms',
  label: 'Phone / SMS',
  fields: [
    { key: 'provider', label: 'Provider', type: 'text', placeholder: 'twilio' },
    { key: 'accountSid', label: 'Account SID', type: 'text', placeholder: 'AC...' },
    { key: 'authToken', label: 'Auth token', type: 'password', secret: true },
    { key: 'from', label: 'From number', type: 'text', placeholder: '+15551234567' },
    { key: 'messagingServiceSid', label: 'Messaging Service SID (optional)', type: 'text', placeholder: 'MG...' },
    {
      key: 'testNumbers',
      label: 'Test numbers (bypass real SMS)',
      type: 'text',
      placeholder: '+15550001111:123456, +15550002222:000000',
      help: 'Comma-separated phone:code pairs. Matching numbers skip Twilio and accept the fixed code, for app-store review and e2e tests.',
    },
  ],
  schema: z.object({
    provider: z.string().optional().default('twilio'),
    accountSid: z.string().optional().default(''),
    authToken: z.string().optional().default(''),
    from: z.string().optional().default(''),
    messagingServiceSid: z.string().optional().default(''),
    testNumbers: z.string().optional().default(''),
  }),
  envFallback: () => ({
    provider: 'twilio',
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    from: process.env.TWILIO_FROM_NUMBER || '',
    messagingServiceSid: '',
    testNumbers: '',
  }),
};

const AUTH_EMAIL_VARIABLES_HINT = '{{appName}}, {{code}}, {{email}}';
const AUTH_LINK_VARIABLES_HINT = '{{appName}}, {{url}}, {{email}}';
const authEmailSubjectSchema = z.string().refine(
  isSafeAuthEmailSubjectTemplate,
  `invalid template; allowed variables: ${AUTH_EMAIL_VARIABLES_HINT}`,
);
const authEmailBodySchema = z.string().refine(
  isSafeAuthEmailBodyTemplate,
  `invalid template; {{code}} is required and only ${AUTH_EMAIL_VARIABLES_HINT} are allowed`,
);
const authLinkSubjectSchema = z.string().refine(
  isSafeAuthLinkSubjectTemplate,
  `invalid template; allowed variables: ${AUTH_LINK_VARIABLES_HINT}`,
);
const authLinkBodySchema = z.string().refine(
  isSafeAuthLinkBodyTemplate,
  `invalid template; {{url}} is required and only ${AUTH_LINK_VARIABLES_HINT} are allowed`,
);

export const emailTemplates: GroupDef = {
  key: 'email.templates',
  label: 'Email templates',
  description: 'Customise transactional auth emails. Code templates use {{code}}; link templates use {{url}} (rendered as a button/link). {{appName}} and {{email}} are always available.',
  fields: [
    { key: 'verificationSubject', label: 'Email OTP · verification subject', type: 'text', default: DEFAULT_AUTH_EMAIL_TEMPLATES.verificationSubject },
    { key: 'verificationBody', label: 'Email OTP · verification body', type: 'text', multiline: true, placeholder: 'Your code is {{code}}', help: `Requires {{code}}. Allowed: ${AUTH_EMAIL_VARIABLES_HINT}` },
    { key: 'recoverySubject', label: 'Password reset subject', type: 'text', default: DEFAULT_AUTH_EMAIL_TEMPLATES.recoverySubject },
    { key: 'recoveryBody', label: 'Password reset body', type: 'text', multiline: true, placeholder: 'Your reset code is {{code}}', help: `Requires {{code}}. Allowed: ${AUTH_EMAIL_VARIABLES_HINT}` },
    { key: 'magicLinkSubject', label: 'Magic-link subject', type: 'text', default: DEFAULT_AUTH_LINK_TEMPLATES.magicLinkSubject },
    { key: 'magicLinkBody', label: 'Magic-link body', type: 'text', multiline: true, placeholder: 'Click to sign in: {{url}}', help: `Requires {{url}}. Allowed: ${AUTH_LINK_VARIABLES_HINT}` },
    { key: 'verifyLinkSubject', label: 'Verification-link subject', type: 'text', default: DEFAULT_AUTH_LINK_TEMPLATES.verifyLinkSubject },
    { key: 'verifyLinkBody', label: 'Verification-link body', type: 'text', multiline: true, placeholder: 'Confirm your email address: {{url}}', help: `Requires {{url}}. Allowed: ${AUTH_LINK_VARIABLES_HINT}` },
  ],
  schema: z.object({
    verificationSubject: authEmailSubjectSchema.optional().default(DEFAULT_AUTH_EMAIL_TEMPLATES.verificationSubject),
    verificationBody: authEmailBodySchema.optional().default(DEFAULT_AUTH_EMAIL_TEMPLATES.verificationBody),
    recoverySubject: authEmailSubjectSchema.optional().default(DEFAULT_AUTH_EMAIL_TEMPLATES.recoverySubject),
    recoveryBody: authEmailBodySchema.optional().default(DEFAULT_AUTH_EMAIL_TEMPLATES.recoveryBody),
    magicLinkSubject: authLinkSubjectSchema.optional().default(DEFAULT_AUTH_LINK_TEMPLATES.magicLinkSubject),
    magicLinkBody: authLinkBodySchema.optional().default(DEFAULT_AUTH_LINK_TEMPLATES.magicLinkBody),
    verifyLinkSubject: authLinkSubjectSchema.optional().default(DEFAULT_AUTH_LINK_TEMPLATES.verifyLinkSubject),
    verifyLinkBody: authLinkBodySchema.optional().default(DEFAULT_AUTH_LINK_TEMPLATES.verifyLinkBody),
  }),
  envFallback: () => ({
    verificationSubject: process.env.EMAIL_VERIFICATION_SUBJECT || DEFAULT_AUTH_EMAIL_TEMPLATES.verificationSubject,
    verificationBody: process.env.EMAIL_VERIFICATION_BODY || DEFAULT_AUTH_EMAIL_TEMPLATES.verificationBody,
    recoverySubject: process.env.EMAIL_RECOVERY_SUBJECT || DEFAULT_AUTH_EMAIL_TEMPLATES.recoverySubject,
    recoveryBody: process.env.EMAIL_RECOVERY_BODY || DEFAULT_AUTH_EMAIL_TEMPLATES.recoveryBody,
    magicLinkSubject: DEFAULT_AUTH_LINK_TEMPLATES.magicLinkSubject,
    magicLinkBody: DEFAULT_AUTH_LINK_TEMPLATES.magicLinkBody,
    verifyLinkSubject: DEFAULT_AUTH_LINK_TEMPLATES.verifyLinkSubject,
    verifyLinkBody: DEFAULT_AUTH_LINK_TEMPLATES.verifyLinkBody,
  }),
};


export const pushFcm: GroupDef = {
  key: 'push.fcm',
  label: 'Push · Firebase',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'projectId', label: 'Project ID', type: 'text' },
    { key: 'clientEmail', label: 'Client email', type: 'text' },
    { key: 'privateKey', label: 'Private key', type: 'password', secret: true },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    projectId: z.string().optional().default(''),
    clientEmail: z.string().optional().default(''),
    privateKey: z.string().optional().default(''),
  }),
  envFallback: () => ({
    enabled: false,
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: process.env.FIREBASE_PRIVATE_KEY || '',
  }),
};

export const pushApns: GroupDef = {
  key: 'push.apns',
  label: 'Push · APNs',
  fields: [
    { key: 'enabled', label: 'Enabled', type: 'bool', default: false },
    { key: 'key', label: 'APNs key', type: 'password', secret: true },
    { key: 'keyId', label: 'Key ID', type: 'text' },
    { key: 'teamId', label: 'Team ID', type: 'text' },
    { key: 'bundleId', label: 'Bundle ID', type: 'text' },
    { key: 'production', label: 'Production', type: 'bool', default: false },
  ],
  schema: z.object({
    enabled: z.coerce.boolean().default(false),
    key: z.string().optional().default(''),
    keyId: z.string().optional().default(''),
    teamId: z.string().optional().default(''),
    bundleId: z.string().optional().default(''),
    production: z.coerce.boolean().default(false),
  }),
  envFallback: () => ({
    enabled: false,
    key: process.env.APNS_KEY || '',
    keyId: process.env.APNS_KEY_ID || '',
    teamId: process.env.APNS_TEAM_ID || '',
    bundleId: process.env.APNS_BUNDLE_ID || '',
    production: process.env.APNS_PRODUCTION === 'true',
  }),
};

// CORS allowed origins. Empty string = allow all (dev only). Changes take
// effect immediately: no server restart required.
