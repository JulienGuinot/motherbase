import { asClass, asFunction, asValue } from 'awilix';
import { UserService } from './user.service';
import { TransporterService } from './transporter.service';
import { SmsService } from './sms.service';
import { SocketService } from './socket.service';
import { RealtimeBroadcastService } from './realtime/realtime-broadcast.service';
import { RealtimeOutboxService } from './realtime/realtime-outbox.service';
import { RealtimeOutboxSchedulerService } from './realtime/realtime-outbox-scheduler.service';
import { RealtimeTopicService } from './realtime/realtime-topic.service';
import { RealtimePresenceService } from './realtime/realtime-presence.service';
import { RealtimePostgresService } from './realtime/realtime-postgres.service';
import { RealtimeAuthorizationService } from './realtime/realtime-authorization.service';
import { ContentService } from './admin/content.service';
import { initCron } from '../helpers/cron.helper';
import { StorageService } from './storage/storage.service';
import { StorageCleanupSchedulerService } from './storage/storage-cleanup-scheduler.service';
import { BucketDeletionService } from './storage/bucket-deletion.service';
import { BucketDeletionSchedulerService } from './storage/bucket-deletion-scheduler.service';
import { BucketService } from './storage/bucket.service';
import { StoragePolicyService } from './storage/storage-policy.service';
import { ImageRenderService } from './storage/image-render.service';
import { ResumableUploadService } from './storage/resumable-upload.service';
import { S3AccessKeyService } from './storage/s3-access-key.service';
import { S3ProtocolService } from './storage/s3-protocol.service';
import { NotificationService } from './notification/notification.service';
import { AdminService } from './admin/admin.service';
import { UserAdminService } from './admin/user-admin.service';
import { AuthAuditService } from './admin/auth-audit.service';
import { AuthLinkService } from './admin/auth-link.service';
import { ThirdPartyAuthService } from './third-party-auth.service';
import { WebhookAdminService } from './admin/webhook-admin.service';
import { SqlService } from './admin/sql.service';
import { SchemaService } from './admin/schema.service';
import { SchemaMigrationService } from './admin/schema-migration.service';
import { DbWorkflowService } from './admin/db-workflow.service';
import { EnumTypeService } from './admin/enum-type.service';
import { DatabaseRoleService } from './admin/database-role.service';
import { PublicationService } from './admin/publication.service';
import { PostgresConfigService } from './admin/postgres-config.service';
import { RealtimeAdminService } from './admin/realtime-admin.service';
import { EdgeFunctionService } from './admin/edge-function.service';
import { EdgeFunctionSchedulerService } from './admin/edge-function-scheduler.service';
import { AdvisorService } from './admin/advisor.service';
import { ShieldService } from './admin/shield.service';
import { BackupService } from './admin/backup.service';
import { BackupSchedulerService } from './admin/backup-scheduler.service';
import { DataRetentionService } from './admin/data-retention.service';
import { DataRetentionSchedulerService } from './admin/data-retention-scheduler.service';
import { LogPersistenceService } from './admin/log-persistence.service';
import { SigningKeyService } from './admin/signing-key.service';
import { DatabaseAccessService } from './admin/database-access.service';
import { LogDrainService } from './admin/log-drain.service';
import { ImportService } from './admin/import.service';
import { SecretsService } from './admin/secrets.service';
import { IntegrationsService } from './admin/integrations.service';
import { GitRepoService } from './admin/git/git-repo.service';
import { SettingsService } from './settings.service';
import { ApiKeyService } from './api-key.service';
import { DbConnectionService } from './admin/db-connection.service';
import { StorageConnectionService } from './admin/storage-connection.service';
import { AuthManager } from '../auth/auth-manager';
import { RestApiService } from './rest-api/rest-api.service';
import { EventDispatcherService } from './events/event-dispatcher.service';
import { RlsPool } from '../lib/rls-pool';
import { RlsService } from './admin/rls.service';
import { RlsSimulatorService } from './admin/rls-simulator.service';
import { JobLedgerService } from './admin/job-ledger.service';
import { JobInventoryService } from './admin/job-inventory.service';
import { CronService } from './admin/cron.service';
import { QueueService } from './admin/queue.service';
import { VaultService } from './admin/vault.service';
import { WrapperService } from './admin/wrapper.service';
import { IndexAdvisorService } from './admin/index-advisor.service';
import { OutboundHttpClient } from './http/outbound-http-client.service';
import { AiConfigService, type ResolvedAiConfig } from './admin/ai-config.service';
import { AiChatService } from './admin/ai-chat.service';
import { openThreadStore } from './admin/ai-thread-store.sqlite';
import { getProvider, type ProviderAdapter, type ThreadStore } from '@motherbase/ai';
import path from 'path';
import { env } from '../config/env';

export interface IServiceContainer {
  UserService: UserService;
  StorageService: StorageService;
  StorageCleanupSchedulerService: StorageCleanupSchedulerService;
  BucketDeletionService: BucketDeletionService;
  BucketDeletionSchedulerService: BucketDeletionSchedulerService;
  BucketService: BucketService;
  StoragePolicyService: StoragePolicyService;
  ImageRenderService: ImageRenderService;
  ResumableUploadService: ResumableUploadService;
  S3AccessKeyService: S3AccessKeyService;
  S3ProtocolService: S3ProtocolService;
  NotificationService: NotificationService;
  TransporterService: TransporterService;
  SmsService: SmsService;
  SocketService: SocketService;
  RealtimeBroadcastService: RealtimeBroadcastService;
  RealtimeOutboxService: RealtimeOutboxService;
  RealtimeOutboxSchedulerService: RealtimeOutboxSchedulerService;
  RealtimeTopicService: RealtimeTopicService;
  RealtimePresenceService: RealtimePresenceService;
  RealtimePostgresService: RealtimePostgresService;
  RealtimeAuthorizationService: RealtimeAuthorizationService;
  ContentService: ContentService;
  AdminService: AdminService;
  UserAdminService: UserAdminService;
  AuthAuditService: AuthAuditService;
  AuthLinkService: AuthLinkService;
  ThirdPartyAuthService: ThirdPartyAuthService;
  WebhookAdminService: WebhookAdminService;
  SqlService: SqlService;
  SchemaService: SchemaService;
  SchemaMigrationService: SchemaMigrationService;
  DbWorkflowService: DbWorkflowService;
  EnumTypeService: EnumTypeService;
  DatabaseRoleService: DatabaseRoleService;
  PublicationService: PublicationService;
  PostgresConfigService: PostgresConfigService;
  RealtimeAdminService: RealtimeAdminService;
  EdgeFunctionService: EdgeFunctionService;
  EdgeFunctionSchedulerService: EdgeFunctionSchedulerService;
  AdvisorService: AdvisorService;
  ShieldService: ShieldService;
  BackupService: BackupService;
  BackupSchedulerService: BackupSchedulerService;
  DataRetentionService: DataRetentionService;
  DataRetentionSchedulerService: DataRetentionSchedulerService;
  LogPersistenceService: LogPersistenceService;
  SigningKeyService: SigningKeyService;
  DatabaseAccessService: DatabaseAccessService;
  LogDrainService: LogDrainService;
  ImportService: ImportService;
  SecretsService: SecretsService;
  IntegrationsService: IntegrationsService;
  GitRepoService: GitRepoService;
  SettingsService: SettingsService;
  ApiKeyService: ApiKeyService;
  DbConnectionService: DbConnectionService;
  StorageConnectionService: StorageConnectionService;
  AuthManager: AuthManager;
  RestApiService: RestApiService;
  EventDispatcherService: EventDispatcherService;
  RlsPool: RlsPool;
  RlsService: RlsService;
  RlsSimulatorService: RlsSimulatorService;
  JobLedgerService: JobLedgerService;
  JobInventoryService: JobInventoryService;
  CronService: CronService;
  QueueService: QueueService;
  VaultService: VaultService;
  WrapperService: WrapperService;
  IndexAdvisorService: IndexAdvisorService;
  OutboundHttpClient: OutboundHttpClient;
  AiConfigService: AiConfigService;
  // Resolves the organization-wide AI config: the default a project inherits
  // when it has not saved one of its own. It arrives as AI_* environment
  // variables, written into .env.prod by the Console, so this process needs no
  // route back to it. Resolves to null when nothing is configured, and
  // AiConfigService.resolve falls back cleanly to "not configured".
  consoleAiConfig: () => Promise<Record<string, unknown> | null>;
  AiChatService: AiChatService;
  // Values, not classes (like consoleAiConfig above), so they stay camelCase.
  aiThreadStore: ThreadStore;
  aiAdapterFactory: (config: ResolvedAiConfig) => ProviderAdapter;
  initCron: () => void;
}

// The thread store's SQLite file lives under AI_DATA_DIR. Opening it is
// deliberately non-fatal: the API container runs read-only, so an unmounted
// data volume must cost the operator their conversation history, not their
// whole project API. See openThreadStore.
const aiDataDir = path.resolve(process.cwd(), env.AI_DATA_DIR);

/**
 * The organization-wide AI config this project inherits, from its environment.
 *
 * Shaped like a saved `ai.assistant` settings group, because that is what
 * AiConfigService compares it against. `source: 'org'` is what lets Studio say
 * the assistant is running on the organization's key rather than this
 * project's own.
 *
 * Returns null unless there is actually a key: a half-filled environment is
 * "not configured", not a broken configuration.
 */
export function orgAiConfigFromEnv(): Record<string, unknown> | null {
  if (!env.AI_API_KEY || !env.AI_PROVIDER) return null;
  return {
    enabled: env.AI_ASSISTANT_ENABLED,
    provider: env.AI_PROVIDER,
    model: env.AI_MODEL,
    apiKey: env.AI_API_KEY,
    baseUrl: env.AI_BASE_URL,
    source: 'org',
  };
}

export default {
  UserService: asClass(UserService).singleton(),
  TransporterService: asClass(TransporterService).singleton(),
  SmsService: asClass(SmsService).singleton(),
  SocketService: asClass(SocketService).singleton(),
  RealtimeBroadcastService: asClass(RealtimeBroadcastService).singleton(),
  RealtimeOutboxService: asClass(RealtimeOutboxService).singleton(),
  RealtimeOutboxSchedulerService: asClass(RealtimeOutboxSchedulerService).singleton(),
  RealtimeTopicService: asClass(RealtimeTopicService).singleton(),
  RealtimePresenceService: asClass(RealtimePresenceService).singleton(),
  RealtimePostgresService: asClass(RealtimePostgresService).singleton(),
  RealtimeAuthorizationService: asClass(RealtimeAuthorizationService).singleton(),
  ContentService: asClass(ContentService).singleton(),
  StorageService: asClass(StorageService).singleton(),
  StorageCleanupSchedulerService: asClass(StorageCleanupSchedulerService).singleton(),
  BucketDeletionService: asClass(BucketDeletionService).singleton(),
  BucketDeletionSchedulerService: asClass(BucketDeletionSchedulerService).singleton(),
  BucketService: asClass(BucketService).singleton(),
  StoragePolicyService: asClass(StoragePolicyService).singleton(),
  ImageRenderService: asClass(ImageRenderService).singleton(),
  ResumableUploadService: asClass(ResumableUploadService).singleton(),
  S3AccessKeyService: asClass(S3AccessKeyService).singleton(),
  S3ProtocolService: asClass(S3ProtocolService).singleton(),
  NotificationService: asClass(NotificationService).singleton(),
  AdminService: asClass(AdminService).singleton(),
  UserAdminService: asClass(UserAdminService).singleton(),
  AuthAuditService: asClass(AuthAuditService).singleton(),
  AuthLinkService: asClass(AuthLinkService).singleton(),
  ThirdPartyAuthService: asClass(ThirdPartyAuthService).singleton(),
  WebhookAdminService: asClass(WebhookAdminService).singleton(),
  SqlService: asClass(SqlService).singleton(),
  SchemaService: asClass(SchemaService).singleton(),
  SchemaMigrationService: asClass(SchemaMigrationService).singleton(),
  DbWorkflowService: asClass(DbWorkflowService).singleton(),
  EnumTypeService: asClass(EnumTypeService).singleton(),
  DatabaseRoleService: asClass(DatabaseRoleService).singleton(),
  PublicationService: asClass(PublicationService).singleton(),
  PostgresConfigService: asClass(PostgresConfigService).singleton(),
  RealtimeAdminService: asClass(RealtimeAdminService).singleton(),
  EdgeFunctionService: asClass(EdgeFunctionService).singleton(),
  EdgeFunctionSchedulerService: asClass(EdgeFunctionSchedulerService).singleton(),
  AdvisorService: asClass(AdvisorService).singleton(),
  ShieldService: asClass(ShieldService).singleton(),
  BackupService: asClass(BackupService).singleton(),
  BackupSchedulerService: asClass(BackupSchedulerService).singleton(),
  DataRetentionService: asClass(DataRetentionService).singleton(),
  DataRetentionSchedulerService: asClass(DataRetentionSchedulerService).singleton(),
  LogPersistenceService: asClass(LogPersistenceService).singleton(),
  SigningKeyService: asClass(SigningKeyService).singleton(),
  DatabaseAccessService: asClass(DatabaseAccessService).singleton(),
  LogDrainService: asClass(LogDrainService).singleton(),
  ImportService: asClass(ImportService).singleton(),
  SecretsService: asClass(SecretsService).singleton(),
  IntegrationsService: asClass(IntegrationsService).singleton(),
  GitRepoService: asClass(GitRepoService).singleton(),
  SettingsService: asClass(SettingsService).singleton(),
  ApiKeyService: asClass(ApiKeyService).singleton(),
  DbConnectionService: asClass(DbConnectionService).singleton(),
  StorageConnectionService: asClass(StorageConnectionService).singleton(),
  AuthManager: asClass(AuthManager).singleton(),
  RestApiService: asClass(RestApiService).singleton(),
  EventDispatcherService: asClass(EventDispatcherService).singleton(),
  RlsPool: asClass(RlsPool).singleton(),
  RlsService: asClass(RlsService).singleton(),
  RlsSimulatorService: asClass(RlsSimulatorService).singleton(),
  JobLedgerService: asClass(JobLedgerService).singleton(),
  JobInventoryService: asClass(JobInventoryService).singleton(),
  CronService: asClass(CronService).singleton(),
  QueueService: asClass(QueueService).singleton(),
  VaultService: asClass(VaultService).singleton(),
  WrapperService: asClass(WrapperService).singleton(),
  IndexAdvisorService: asClass(IndexAdvisorService).singleton(),
  // Its constructor accepts optional test seams. A factory prevents Awilix's
  // dependency proxy from treating those optional properties as registrations.
  OutboundHttpClient: asFunction(() => new OutboundHttpClient()).singleton(),
  AiConfigService: asClass(AiConfigService).scoped(),
  // Organization-wide AI settings, read fresh on every call rather than
  // captured once: a container is recreated when the Console pushes a new key,
  // but reading env at call time also means a plain `docker compose up` with an
  // edited .env.prod takes effect with no code path to remember.
  consoleAiConfig: asValue(async () => orgAiConfigFromEnv()),
  AiChatService: asClass(AiChatService).scoped(),
  aiThreadStore: asValue(openThreadStore(aiDataDir)),
  aiAdapterFactory: asValue((config: ResolvedAiConfig) =>
    getProvider(config.provider).create({
      provider: config.provider,
      model: config.model,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    }),
  ),
  initCron: asFunction(initCron).singleton(),
};
