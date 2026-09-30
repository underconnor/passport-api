import { PrismaClient } from '@prisma/client';
export async function seedDevelopment(db: PrismaClient, env = process.env) {
  if (env.PASSPORT_AUTH_MODE !== 'development' || env.NODE_ENV === 'production') throw new Error('Development seed requires explicit non-production development auth mode');
  const verifiedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  for (const identity of ['member', 'outsider'] as const) {
    const active = identity === 'member';
    await db.subject.upsert({ where: { universityKey: `development:${identity}` }, create: { universityKey: `development:${identity}`, displayName: active ? '개발 회원' : '개발 비회원', identityProvider: 'development', membershipStatus: active ? 'active' : 'inactive', roleLabel: active ? '개발회원' : '', verifiedUntil, allowedServerIds: active ? ['lobby', 'survival'] : [] }, update: {} });
  }
}
if (require.main === module) {
  const db = new PrismaClient();
  seedDevelopment(db).then(() => console.log('Synthetic development fixtures ensured; no real university or roster verification performed.')).finally(() => db.$disconnect());
}
