// The Auth · Rate Limits values on their own, with no runtime imports: the
// settings registry reads them, and the Console loads that registry without the
// project environment that the limiter's middleware validates on import.

export interface AuthRateLimits {
  emailSentPerHour: number;
  smsSentPerHour: number;
  tokenRefreshPer5Min: number;
  verifyPer5Min: number;
  signInSignUpPer5Min: number;
  anonymousPerHour: number;
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  emailSentPerHour: 30,
  smsSentPerHour: 30,
  tokenRefreshPer5Min: 150,
  verifyPer5Min: 30,
  signInSignUpPer5Min: 30,
  anonymousPerHour: 30,
};
