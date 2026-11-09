namespace NodeJS {
  interface ProcessEnv {
    NODE_ENV: string;
    PORT: string;
    DATABASE_URL: string;

    JWT_SECRET: string;
    PLATFORM_SERVICE_TOKEN?: string;
    ACCESS_TOKEN_EXP_MIN: string;
    REFRESH_TOKEN_EXP_DAYS: string;

    STATIC_PATH: string;
    USER_PATH: string;

    EMAIL_SMTP_USERNAME: string;
    EMAIL_SMTP_PASSWORD: string;
    EMAIL_SMTP_HOST: string;


    BASE_HOST: string;
    CORS_ORIGINS: string;
    TRUST_PROXY: string;
    RATE_LIMIT_WINDOW_MIN: string;
    RATE_LIMIT_GLOBAL_MAX: string;
    RATE_LIMIT_AUTH_MAX: string;
    RATE_LIMIT_REST_READ_MAX: string;
    RATE_LIMIT_REST_WRITE_MAX: string;
    RATE_LIMIT_EDGE_MAX: string;
    EDGE_PUBLIC_INVOKE_ENABLED: string;
    EDGE_INVOKE_TOKEN: string;
    EDGE_SECRETS_ENABLED?: string;
    BACKUP_DIR: string;
    AI_DATA_DIR: string;

    STORAGE_DRIVER: string;
    S3_ENDPOINT: string;
    S3_REGION: string;
    S3_ACCESS_KEY_ID: string;
    S3_SECRET_ACCESS_KEY: string;
    S3_BUCKET: string;
    S3_PUBLIC_URL: string;
    S3_PRESIGN_ENDPOINT: string;

    FIREBASE_PROJECT_ID: string;
    FIREBASE_CLIENT_EMAIL: string;
    FIREBASE_PRIVATE_KEY: string;
    APNS_KEY: string;
    APNS_KEY_ID: string;
    APNS_TEAM_ID: string;
    APNS_BUNDLE_ID: string;
    APNS_PRODUCTION: string;
  }
}
