/** A game-only authorization simulation, deliberately separate from school/Discord proof. */
export const managedDevelopmentProvider = 'managed-development';
export const managedDevelopmentName = '개발용 계정';
export type ManagedGameSubject = { identityProvider: string; accessSuspended?: boolean; membershipStatus?: string; developmentAccount?: { enabled: boolean; discordLinked: boolean } | null };
export function managedGameActive(subject: ManagedGameSubject | null | undefined) {
  return Boolean(subject?.identityProvider === managedDevelopmentProvider && subject.developmentAccount?.enabled && !subject.accessSuspended && subject.membershipStatus !== 'suspended');
}
