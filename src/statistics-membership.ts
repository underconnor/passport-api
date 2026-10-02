import type { Prisma } from '@prisma/client';

export type StatisticsMembership = 'all' | 'active';

/** Match adminMembers' active membership at one query-time instant, not the activity date. */
export function statisticsSubjectWhere(membership: StatisticsMembership, queryNow: Date): Prisma.SubjectWhereInput {
  return membership === 'active'
    ? { identityProvider: 'usaint', membershipStatus: 'active', verifiedUntil: { gt: queryNow }, accessSuspended: false }
    : {};
}
