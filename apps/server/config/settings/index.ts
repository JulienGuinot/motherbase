// The settings registry: every operator-editable group, its fields, its
// validation schema and its env fallback. One entry per group is the single
// source of truth shared by the console UI, the settings service and the
// project-defaults service.
//
// Group definitions are grouped by domain in ./auth.groups.ts,
// ./messaging.groups.ts and ./platform.groups.ts. This file only assembles them
// and exposes the lookups.

import type { GroupDef } from './types';
import {
  authApiKey,
  authAttackProtection,
  authHooksAccessToken,
  authHooksEvents,
  authHooksSend,
  authHooksSignUp,
  authMethods,
  authOauthCustom,
  authOrganization,
  authPasskey,
  authPhoneOtp,
  authRateLimits,
  authSessions,
  authSignup,
  authSocial,
  authSso,
  authTokens,
  authThirdParty,
  authTwoFactor,
  authUrls,
} from './auth.groups';
import {
  emailSmtp,
  emailTemplates,
  phoneSms,
  pushApns,
  pushFcm,
} from './messaging.groups';
import {
  aiAssistant,
  apiKeys,
  apiRest,
  backupSchedule,
  databaseSqlEditor,
  dataRetention,
  gitGithub,
  logsRetention,
  realtimeLimits,
  realtimeRetention,
  securityRateLimit,
  securityRateLimitRules,
  serverCors,
  storageImageTransform,
  storageLimits,
  storagePolicies,
  storageProvider,
  storageS3,
} from './platform.groups';

export { AUTH_TOKEN_EXPIRY_LIMITS } from './auth.groups';
export { SECRET_SENTINEL, type FieldDef, type GroupDef } from './types';

export const SETTINGS_GROUPS: Record<string, GroupDef> = {
  [serverCors.key]: serverCors,
  [securityRateLimit.key]: securityRateLimit,
  [securityRateLimitRules.key]: securityRateLimitRules,
  [authTokens.key]: authTokens,
  [authMethods.key]: authMethods,
  [authSignup.key]: authSignup,
  [authSessions.key]: authSessions,
  [authSocial.key]: authSocial,
  [authOauthCustom.key]: authOauthCustom,
  [authTwoFactor.key]: authTwoFactor,
  [authPasskey.key]: authPasskey,
  [authPhoneOtp.key]: authPhoneOtp,
  [authHooksSignUp.key]: authHooksSignUp,
  [authHooksAccessToken.key]: authHooksAccessToken,
  [authHooksSend.key]: authHooksSend,
  [authHooksEvents.key]: authHooksEvents,
  [authUrls.key]: authUrls,
  [authRateLimits.key]: authRateLimits,
  [authThirdParty.key]: authThirdParty,
  [authAttackProtection.key]: authAttackProtection,
  [authApiKey.key]: authApiKey,
  [authSso.key]: authSso,
  [authOrganization.key]: authOrganization,
  [emailSmtp.key]: emailSmtp,
  [phoneSms.key]: phoneSms,
  [emailTemplates.key]: emailTemplates,
  [storageProvider.key]: storageProvider,
  [storageLimits.key]: storageLimits,
  [storageImageTransform.key]: storageImageTransform,
  [storageS3.key]: storageS3,
  [storagePolicies.key]: storagePolicies,
  [pushFcm.key]: pushFcm,
  [pushApns.key]: pushApns,
  [backupSchedule.key]: backupSchedule,
  [dataRetention.key]: dataRetention,
  [logsRetention.key]: logsRetention,
  [realtimeRetention.key]: realtimeRetention,
  [realtimeLimits.key]: realtimeLimits,
  [databaseSqlEditor.key]: databaseSqlEditor,
  [apiRest.key]: apiRest,
  [apiKeys.key]: apiKeys,
  [aiAssistant.key]: aiAssistant,
  [gitGithub.key]: gitGithub,
};

export function getGroup(key: string): GroupDef | undefined {
  return SETTINGS_GROUPS[key];
}

export function groupHasSecrets(key: string): boolean {
  return SETTINGS_GROUPS[key]?.fields.some(field => field.secret || Boolean(field.secretKeys?.length)) ?? false;
}

export function listGroups(): Array<{ key: string; label: string }> {
  return Object.values(SETTINGS_GROUPS).map(g => ({ key: g.key, label: g.label }));
}
