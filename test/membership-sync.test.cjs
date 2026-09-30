const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PrismaClient}=require('@prisma/client');
const {applyRosterSnapshot,previewRosterSnapshot,membershipForStudent,rosterDigest,startMembershipSync,runRosterSync}=require('../dist/membership-sync');
const {parseRoster,studentKey,validateSnapshotChange}=require('../dist/integrations/sheets');
const testDatabase=process.env.TEST_DATABASE_URL;
if(!testDatabase || !new URL(testDatabase).pathname.endsWith('_test')) throw new Error('A dedicated database ending in _test is required');
// This suite uses a separate schema so the existing API suite cannot truncate its data.
const database=new URL(testDatabase);database.searchParams.set('schema','membership_test');
const db=new PrismaClient({datasources:{db:{url:database.href}}});
const options={allowedServerIds:['lobby','survival'],maxAgeMs:900000};
const secret='membership-test-key-'.repeat(3);
const sourceKey='a'.repeat(64);
const header=['student_id','status','role_label','server_ids'];
const entries=()=>parseRoster([header,...Array.from({length:5},(_,i)=>[String(99990001+i),'active','회원','lobby,survival'])],{matchingSecret:secret,allowedServerIds:options.allowedServerIds});
const snapshot=(rows=entries(),fetchedAt=new Date(),key=sourceKey)=>({entries:rows,fetchedAt,sourceKey:key});
async function makeSubject(entry=entries()[0]) {
  return db.subject.create({data:{universityKey:entry.studentKey,displayName:'Membership test',identityProvider:'usaint',membershipStatus:'inactive',verifiedUntil:new Date(0),minecraft:{create:{uuid:randomUUID(),name:'TestMember',policyVersion:7}}},include:{minecraft:true}});
}
before(async()=>{await db.$connect();});
after(async()=>{await db.$disconnect();});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent", "PolicyEvent", "LinkSession", "WebSession", "MinecraftIdentity", "Subject", "RosterMembership", "RosterSnapshot" RESTART IDENTITY CASCADE');});

test('one transaction stores HMAC roster and grants matching school subjects with policy outbox',async()=>{
  const subject=await makeSubject();const input=snapshot();const applied=await applyRosterSnapshot(db,input,options);
  assert.equal(applied.total,5);assert.equal(applied.changedPolicies,1);assert.equal(applied.updatedSubjects,1);
  const current=await db.subject.findUnique({where:{id:subject.id}});assert.equal(current.membershipStatus,'active');assert.deepEqual(current.allowedServerIds,['lobby','survival']);
  assert.equal(current.verifiedUntil.getTime(),input.fetchedAt.getTime()+900000);
  const policy=await db.minecraftIdentity.findUnique({where:{uuid:subject.minecraft.uuid}});assert.equal(policy.policyVersion,8);assert.equal(policy.policyFingerprint,'');
  assert.equal(await db.policyEvent.count(),1);assert.equal(await db.auditEvent.count(),2);assert.equal(await db.rosterMembership.count(),5);
  assert.doesNotMatch(JSON.stringify(await db.rosterMembership.findMany()),/99990001/);
});
test('missing subject is revoked while suspension is retained and only affected UUIDs advance',async()=>{
  const subject=await makeSubject();const initial=snapshot();await applyRosterSnapshot(db,initial,options);
  const next=snapshot(entries().slice(1),new Date(initial.fetchedAt.getTime()+1));await applyRosterSnapshot(db,next,options);
  const revoked=await db.subject.findUnique({where:{id:subject.id}});assert.equal(revoked.membershipStatus,'inactive');assert.deepEqual(revoked.allowedServerIds,[]);
  assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:subject.minecraft.uuid}})).policyVersion,9);
  const restored=entries();restored[0]={...restored[0],status:'suspended',serverIds:[]};await applyRosterSnapshot(db,snapshot(restored,new Date(initial.fetchedAt.getTime()+2)),options);
  assert.equal((await db.subject.findUnique({where:{id:subject.id}})).membershipStatus,'suspended');
});
test('mass revocation and source changes need approval of exactly the preview digest',async()=>{
  await makeSubject();const initial=snapshot();await applyRosterSnapshot(db,initial,options);
  const next=snapshot(entries().slice(2),new Date(initial.fetchedAt.getTime()+1),'b'.repeat(64));const preview=await previewRosterSnapshot(db,next,options);
  assert.deepEqual(preview.risks,['source_changed','mass_revocation']);
  await assert.rejects(applyRosterSnapshot(db,next,options),error=>error.code==='approval_required');
  await assert.rejects(applyRosterSnapshot(db,next,{...options,expectedApprovalDigest:'c'.repeat(64)}),error=>error.code==='approval_mismatch');
  assert.equal(await db.rosterMembership.count(),5);
  await applyRosterSnapshot(db,next,{...options,expectedApprovalDigest:preview.digest});assert.equal(await db.rosterMembership.count(),3);
  assert.equal(await db.auditEvent.count({where:{action:'roster.snapshot_approved'}}),1);
});
test('header-only empty roster requires deliberate approval and then revokes every member',async()=>{
  assert.throws(()=>parseRoster([header],{matchingSecret:secret,allowedServerIds:options.allowedServerIds}));
  assert.deepEqual(parseRoster([header],{matchingSecret:secret,allowedServerIds:options.allowedServerIds},{allowEmpty:true}),[]);
  const subject=await makeSubject();const initial=snapshot();await applyRosterSnapshot(db,initial,options);
  const empty=snapshot([],new Date(initial.fetchedAt.getTime()+1));await assert.rejects(applyRosterSnapshot(db,empty,options),error=>error.code==='approval_required');
  await applyRosterSnapshot(db,empty,{...options,expectedApprovalDigest:rosterDigest(empty)});
  assert.equal(await db.rosterMembership.count(),0);assert.equal((await db.subject.findUnique({where:{id:subject.id}})).membershipStatus,'inactive');
});
test('malformed, expired, future and out-of-order snapshots cannot extend access',async()=>{
  const initial=snapshot();await applyRosterSnapshot(db,initial,options);
  const digest=(await db.rosterSnapshot.findUnique({where:{id:'current'}})).digest;
  for(const [input,code] of [[snapshot(entries(),new Date(Date.now()-900001)),'stale_snapshot'],[snapshot(entries(),new Date(Date.now()+60000)),'stale_snapshot'],[initial,'outdated_snapshot'],[snapshot([...entries(),entries()[0]],new Date(initial.fetchedAt.getTime()+1)),'invalid_snapshot']]) {
    await assert.rejects(applyRosterSnapshot(db,input,options),error=>error.code===code);
  }
  assert.equal((await db.rosterSnapshot.findUnique({where:{id:'current'}})).digest,digest);
});
test('failure after snapshot and subject writes rolls back membership, audit and outbox together',async()=>{
  const subject=await makeSubject();const failingDb={$transaction:(fn,settings)=>db.$transaction(tx=>fn(new Proxy(tx,{get:(target,key)=>key==='auditEvent'?{create:async()=>{throw new Error('injected write failure');}}:target[key]})),settings)};
  await assert.rejects(applyRosterSnapshot(failingDb,snapshot(),options),/injected write failure/);
  assert.equal(await db.rosterSnapshot.count(),0);assert.equal(await db.rosterMembership.count(),0);assert.equal(await db.policyEvent.count(),0);
  assert.equal((await db.subject.findUnique({where:{id:subject.id}})).membershipStatus,'inactive');
  assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:subject.minecraft.uuid}})).policyVersion,7);
});
test('SSO membership lookup fails closed for absent or stale snapshots and never touches admin overrides',async()=>{
  const key=studentKey('99990001',secret);const absent=await db.$transaction(tx=>membershipForStudent(tx,key));assert.equal(absent.membershipStatus,'inactive');assert.equal(absent.verifiedUntil.getTime(),0);
  const subject=await makeSubject();await db.subject.update({where:{id:subject.id},data:{accessSuspended:true,scopeRestricted:true,scopeLimit:['lobby']}});
  const initial=snapshot();await applyRosterSnapshot(db,initial,options);
  const live=await db.$transaction(tx=>membershipForStudent(tx,key));assert.deepEqual(live.allowedServerIds,['lobby','survival']);
  const stale=await db.$transaction(tx=>membershipForStudent(tx,key,new Date(initial.fetchedAt.getTime()+900001)));assert.deepEqual(stale.allowedServerIds,[]);assert.equal(stale.roleLabel,'');
  const updated=await db.subject.findUnique({where:{id:subject.id}});assert.equal(updated.accessSuspended,true);assert.equal(updated.scopeRestricted,true);assert.deepEqual(updated.scopeLimit,['lobby']);
});
test('a fresh identical snapshot renews only freshness; returning from stale bumps linked policy',async()=>{
  const subject=await makeSubject();const initial=snapshot();await applyRosterSnapshot(db,initial,options);
  await applyRosterSnapshot(db,snapshot(entries(),new Date(initial.fetchedAt.getTime()+1)),options);
  assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:subject.minecraft.uuid}})).policyVersion,8);assert.equal(await db.policyEvent.count(),1);
  await db.subject.update({where:{id:subject.id},data:{verifiedUntil:new Date(0)}});
  await applyRosterSnapshot(db,snapshot(entries(),new Date(initial.fetchedAt.getTime()+2)),options);
  assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:subject.minecraft.uuid}})).policyVersion,9);
});
test('scope loss counts as revocation and missing worker configuration cannot write or authorize',async()=>{
  const old=entries();const narrowed=old.map(entry=>({...entry,serverIds:['lobby']}));assert.throws(()=>validateSnapshotChange(old,narrowed),/manual review/);
  const worker=startMembershipSync(db,{SHEETS_SYNC_ENABLED:'true'});assert.equal(worker.status().enabled,false);assert.equal(worker.status().lastError,'configuration_error');worker.stop();
  await assert.rejects(runRosterSync(db,{}),error=>error.code==='configuration_error');assert.equal(await db.rosterSnapshot.count(),0);
});
test('concurrent readers cannot overwrite a newer snapshot with a late older response',async()=>{
  const subject=await makeSubject();const initial=snapshot();await applyRosterSnapshot(db,initial,options);
  const older=snapshot(entries().map(entry=>({...entry,roleLabel:'Earlier'})),new Date(initial.fetchedAt.getTime()+1));
  const newer=snapshot(entries().map(entry=>({...entry,roleLabel:'Latest'})),new Date(initial.fetchedAt.getTime()+2));
  const result=await Promise.allSettled([applyRosterSnapshot(db,older,options),applyRosterSnapshot(db,newer,options)]);
  assert.equal(result[1].status,'fulfilled');
  if(result[0].status==='rejected') assert.equal(result[0].reason.code,'outdated_snapshot');
  const final=await db.rosterSnapshot.findUnique({where:{id:'current'}});assert.equal(final.fetchedAt.getTime(),newer.fetchedAt.getTime());
  assert.equal((await db.subject.findUnique({where:{id:subject.id}})).roleLabel,'Latest');
});
