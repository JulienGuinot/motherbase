export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushResult {
  token: string;
  success: boolean;
  error?: string;
  /** True when the token is permanently invalid and should be pruned. */
  invalid?: boolean;
}

/** A platform push backend (FCM for Android/Web, APNs for iOS). */
export interface IPushProvider {
  isEnabled(): boolean;
  send(tokens: string[], message: PushMessage): Promise<PushResult[]>;
}
