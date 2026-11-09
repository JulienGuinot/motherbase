/**
 * Phone OTPs issued by this process, for the numbers that get a real SMS.
 *
 * A code is dead after `maxAttempts` wrong guesses, so a 6-digit code cannot be
 * brute-forced inside its lifetime: the attacker has to trigger a new SMS, which
 * the per-project delivery quota and the per-IP verify bucket both count.
 * Expired entries are dropped on every issue, so the map is bounded by the
 * numbers texted within one TTL.
 */
export class PhoneOtpStore {
  private readonly issued = new Map<string, { code: string; expiresAt: number; failures: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxAttempts = 5,
    private readonly now = Date.now,
  ) {}

  issue(phone: string, code: string): void {
    const now = this.now();
    for (const [key, entry] of this.issued) {
      if (entry.expiresAt < now) this.issued.delete(key);
    }
    this.issued.set(phone, { code, expiresAt: now + this.ttlMs, failures: 0 });
  }

  verify(phone: string, code: string): boolean {
    const entry = this.issued.get(phone);
    if (!entry || entry.expiresAt < this.now()) return false;
    if (entry.code === code) {
      this.issued.delete(phone);
      return true;
    }
    if (++entry.failures >= this.maxAttempts) this.issued.delete(phone);
    return false;
  }
}
