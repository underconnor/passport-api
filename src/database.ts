import { PrismaClient, Prisma } from '@prisma/client';
export async function serializable<T>(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && attempt < 3) continue;
      throw error;
    }
  }
}

/** Keep sequence allocation and commit order aligned for the policy-event cursor. */
export function policyTransaction<T>(db: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return serializable(db, async tx => {
    // Acquire before any row access. Every policy-event producer uses this same
    // database-wide transaction lock; PostgreSQL releases it on commit/rollback.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1346458451, 1347374153)`;
    return fn(tx);
  });
}
