import type { Prisma } from '@prisma/client';

/** Publish authority changes under the caller's policy writer transaction. */
export async function invalidateGamePolicy(tx: Prisma.TransactionClient, subjectId: string) {
  const identity = await tx.minecraftIdentity.findUnique({ where: { subjectId } });
  if (!identity) return;
  const changed = await tx.minecraftIdentity.update({ where: { uuid: identity.uuid }, data: { policyVersion: { increment: 1 }, policyFingerprint: '' } });
  await tx.policyEvent.create({ data: { minecraftUuid: changed.uuid, policyVersion: changed.policyVersion } });
}
