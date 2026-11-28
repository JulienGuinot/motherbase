// Hand-maintained OpenAPI 3 description of the public API, served at /api/docs
// and exportable to openapi.json via `npm run swagger`.
//
// Auth paths come from @motherbase/contracts rather than string literals: this
// file documented the pre-Better-Auth surface (/api/auth/register, /login,
// /refresh) long after those routes stopped existing, and a spec that names a
// dead endpoint is worse than one that omits it. Sharing the constants with the
// SDK makes that class of drift impossible.
//
// This spec covers the core surface only. The admin API, the generated REST
// routes and the full Better Auth plugin surface are documented elsewhere; see
// the note on `info.description`.
import { HTTP_ROUTES } from '@motherbase/contracts';
import { env } from './env';
import { APP_NAME } from '../constants/app.constants';

const bearer = [{ bearerAuth: [] }];

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: `${APP_NAME} API`,
    version: '1.0.0',
    description:
      'Core HTTP surface: auth, files, devices and notifications. Dynamic table routes under /rest/v1 depend on the tables in each project, and the admin API under /api/admin is documented separately.',
  },
  servers: [{ url: `http://${env.BASE_HOST}` }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
  },
  paths: {
    '/api/health-check': {
      get: { summary: 'Health check (also pings the database)', responses: { '200': { description: 'OK' } } },
    },
    [HTTP_ROUTES.authSignUp]: {
      post: {
        summary: 'Sign up with email + password',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SignUpEmail' } } },
        },
        responses: {
          '200': { description: 'Session token and user' },
          '403': { description: 'Sign-ups are disabled, or the sign-up gate refused the account' },
        },
      },
    },
    [HTTP_ROUTES.authSignIn]: {
      post: {
        summary: 'Sign in with email + password',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/SignInEmail' } } },
        },
        responses: {
          '200': { description: 'Session token and user, or a two-factor challenge' },
          '401': { description: 'Invalid credentials' },
        },
      },
    },
    [HTTP_ROUTES.authSession]: {
      get: {
        summary: 'Current session and user',
        security: bearer,
        responses: { '200': { description: 'Session and user, or null when signed out' } },
      },
    },
    [HTTP_ROUTES.authSignOut]: {
      post: {
        summary: 'End the current session',
        security: bearer,
        responses: { '200': { description: 'Signed out' } },
      },
    },
    '/api/auth/token': {
      get: {
        summary: 'Mint a signed JWT for the current session',
        security: bearer,
        responses: { '200': { description: 'JWT' } },
      },
    },
    '/api/auth/jwks': {
      get: {
        summary: 'JWKS for verifying issued JWTs',
        responses: { '200': { description: 'JSON Web Key Set' } },
      },
    },
    [HTTP_ROUTES.authSendOtp]: {
      post: {
        summary: 'Send an email one-time code (verification or sign-in)',
        responses: { '200': { description: 'Always OK: no account enumeration' } },
      },
    },
    [HTTP_ROUTES.authSignInEmailOtp]: {
      post: {
        summary: 'Sign in with an emailed one-time code',
        responses: { '200': { description: 'Session token and user' } },
      },
    },
    [HTTP_ROUTES.authRequestPasswordReset]: {
      post: {
        summary: 'Request a password-reset code by email',
        responses: { '200': { description: 'Always OK: no account enumeration' } },
      },
    },
    [HTTP_ROUTES.authResetPassword]: {
      post: {
        summary: 'Reset the password with an emailed code',
        responses: { '200': { description: 'Password updated' } },
      },
    },
    [HTTP_ROUTES.authSignInSocial]: {
      post: {
        summary: 'Start a social sign-in flow',
        responses: { '200': { description: 'Provider authorization URL' } },
      },
    },
    '/api/files': {
      post: {
        summary: 'Upload a file (multipart field "file")',
        security: bearer,
        responses: { '200': { description: 'File + URL' } },
      },
    },
    '/api/files/presign': {
      post: {
        summary: 'Reserve quota and get a size-bound presigned upload URL (S3 driver)',
        security: bearer,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/PresignUpload' } } },
        },
        responses: {
          '200': { description: 'Pending file reservation and upload URL' },
          '400': { description: 'Invalid size, or STORAGE_DRIVER=local (presigned uploads need the S3 driver)' },
          '413': { description: 'File or bucket quota exceeded' },
        },
      },
    },
    '/api/files/{id}/finalize': {
      post: {
        summary: 'Verify and finalize a presigned upload',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Ready file and download URL' },
          '409': { description: 'Uploaded object size does not match the reservation' },
          '410': { description: 'Upload reservation expired' },
        },
      },
    },
    '/api/files/{id}/url': {
      get: {
        summary: 'Get a (signed) download URL',
        security: bearer,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'URL' } },
      },
    },
    '/api/devices': {
      post: {
        summary: 'Register a push device token',
        security: bearer,
        responses: { '200': { description: 'Device' } },
      },
      delete: {
        summary: 'Unregister a push device token',
        security: bearer,
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/notifications/send': {
      post: {
        summary: 'Send a push to one user (userId) or up to 1000 (userIds). Secret API key or ADMIN role.',
        security: bearer,
        responses: { '200': { description: 'Dispatch results' } },
      },
    },
    '/api/notifications/test': {
      post: {
        summary: 'Send a push to your own devices',
        security: bearer,
        responses: { '200': { description: 'Dispatch results' } },
      },
    },
  },
};

// Reusable request schemas.
(openapiSpec as any).components.schemas = {
  SignUpEmail: {
    type: 'object',
    required: ['email', 'password', 'name'],
    properties: {
      email: { type: 'string' },
      // The effective bound is auth.signup.minPasswordLength (default 8).
      password: { type: 'string', minLength: 8 },
      name: { type: 'string' },
    },
  },
  SignInEmail: {
    type: 'object',
    required: ['email', 'password'],
    properties: { email: { type: 'string' }, password: { type: 'string' } },
  },
  PresignUpload: {
    type: 'object',
    required: ['filename', 'size'],
    properties: {
      filename: { type: 'string' },
      size: { type: 'integer', minimum: 0, maximum: env.MAX_UPLOAD_BYTES },
      mime: { type: 'string' },
      visibility: { type: 'string', enum: ['public', 'private'] },
      bucket: { type: 'string' },
    },
  },
};
