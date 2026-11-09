// Maximum members per end-user organization. Pure so it can be tested without a
// database: the wiring lives in auth/instance.ts.
//
// 0 (the default) means unlimited. Better Auth's own `membershipLimit` option
// falls back to 100 when it is unset, so "unlimited" has to be expressed as an
// explicit Infinity rather than by leaving the option out.

/** Configured limit as a comparable number. 0 / absent / invalid ⇒ Infinity. */
export function orgSeatLimit(maxMembers: unknown): number {
  const parsed = Number(maxMembers);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : Infinity;
}

/** True while the organization can take one more member. */
export function orgHasRoomForMember(memberCount: number, maxMembers: unknown): boolean {
  return memberCount < orgSeatLimit(maxMembers);
}

/** Operator-facing reason, shown to the user whose join was refused. */
export function orgFullMessage(maxMembers: unknown): string {
  const limit = orgSeatLimit(maxMembers);
  return `This organization already has its maximum of ${limit} member${limit === 1 ? '' : 's'}. An operator can raise "Maximum members per organization" in Auth · Organizations.`;
}
