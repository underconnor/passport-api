const {test,before,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const raw=process.env.TEST_DATABASE_URL;
if(!raw||!new URL(raw).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
const database=new URL(raw);database.searchParams.set('schema','development_accounts_test');
Object.assign(process.env,{DATABASE_URL:database.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',API_SERVICE_TOKEN:'development-accounts-service-'.repeat(4),SESSION_SECRET:'development-accounts-session-'.repeat(4),ROSTER_MATCHING_SECRET:'development-accounts-roster-'.repeat(4),DATA_ENCRYPTION_KEY:'cd'.repeat(32),ADMIN_MFA_REQUIRED:'false',SHEETS_SYNC_ENABLED:'false'});
const {createApp}=require('../dist/app');
const {hash,csrf}=require('../dist/security');
const db=new PrismaClient({datasources:{db:{url:database.href}}});
let app,http,admin,profileUuid,fetchCalls,fetchImpl;
const originalFetch=global.fetch;
const ADMIN='admin.example.test',PORTAL='portal.example.test';
const service=r=>r.set('Authorization',`Bearer ${process.env.API_SERVICE_TOKEN}`);
function browser(r,user=admin,mutation=false){r=r.set('Host',user.host).set('Cookie',user.cookie);return mutation?r.set('Origin',`https://${user.host}`).set('X-CSRF-Token',user.csrf):r;}
async function subject(changes={}){return db.subject.create({data:{universityKey:randomUUID(),displayName:'Synthetic Owner',identityProvider:'usaint',universityVerifiedUntil:new Date(Date.now()+3600000),membershipStatus:'active',verifiedUntil:new Date(Date.now()+3600000),...changes}});}
async function session(subject,host=ADMIN){const token=randomBytes(32).toString('base64url');await db.webSession.create({data:{subjectId:subject.id,tokenHash:hash(token),audienceHost:host,expiresAt:new Date(Date.now()+3600000)}});return{subject,host,cookie:`__Host-passport_${host===ADMIN?'admin':'portal'}_session=${token}`,csrf:csrf(process.env.SESSION_SECRET,token)};}
const base={minecraftName:'PassportTest',member:true,discordLinked:false};
async function create(body={},status=201,user=admin){return browser(request(http).post('/v1/admin/development-accounts'),user,true).send({...base,...body}).expect(status);}
async function update(account,body={},status=200,user=admin){return browser(request(http).put(`/v1/admin/development-accounts/${account.id}`),user,true).send({member:account.member,discordLinked:account.discordLinked,enabled:account.enabled,expectedRevision:account.revision,...body}).expect(status);}
async function policy(uuid=profileUuid){return(await service(request(http).get(`/v1/minecraft/policies/${uuid}`)).expect(200)).body;}
async function server(id,accessMode,discordRequirement='any',allowedSubjectIds=[]){return db.serverRecord.create({data:{id,commandName:id,label:id,enabled:true,accessMode,discordRequirement,allowedSubjectIds}});}
before(async()=>{await db.$connect();});after(async()=>{global.fetch=originalFetch;await db.$disconnect();});
beforeEach(async()=>{
 await db.$executeRawUnsafe('TRUNCATE TABLE "Subject", "MinecraftIdentity", "ServerRecord", "PolicyEvent", "AuditEvent", "ActivityBatch", "PlayerPresence", "RosterSnapshot" RESTART IDENTITY CASCADE');
 profileUuid=randomUUID();fetchCalls=0;
 fetchImpl=async(url,options)=>{fetchCalls++;assert.equal(url,'https://api.mojang.com/users/profiles/minecraft/PassportTest');assert.equal(options.redirect,'error');return new Response(JSON.stringify({id:profileUuid.replaceAll('-',''),name:'PassportTest'}),{status:200});};
 global.fetch=(...args)=>fetchImpl(...args);
 app=await createApp();http=app.getHttpServer();const actor=await subject();admin=await session(actor);await db.administrator.create({data:{subjectId:actor.id,enabled:true,role:'owner',totpSecret:''}});
});
afterEach(async()=>{await app?.close();global.fetch=originalFetch;});

test('production managed accounts resolve real UUIDs and are game-only, never school or Discord identities',async()=>{
 const account=(await create()).body.account;
 assert.equal(account.displayName,'개발용 계정');assert.equal(account.minecraft.uuid,profileUuid);assert.equal(account.minecraft.name,'PassportTest');assert.equal(account.revision,1);assert.deepEqual(account.allowedServerIds,['lobby','survival']);
 const saved=await db.subject.findUnique({where:{id:account.id},include:{developmentAccount:true,administrator:true,discordIdentity:true,sessions:true,consents:true}});
 assert.equal(saved.identityProvider,'managed-development');assert.equal(saved.universityVerifiedUntil,null);assert.equal(saved.administrator,null);assert.equal(saved.discordIdentity,null);assert.deepEqual(saved.sessions,[]);assert.deepEqual(saved.consents,[]);assert.equal(saved.studentIdCiphertext,null);
 const result=await policy();assert.equal(result.status,'active');assert.equal(result.display.displayName,'개발용 계정');assert.equal(result.display.member,true);assert.equal(result.administrator,false);assert.equal(result.discordLinked,false);assert.equal(result.telemetry.enabled,false);assert.equal(result.telemetry.presenceEnabled,true);assert.deepEqual(result.telemetry.serverIds,[]);
 await browser(request(http).post('/v1/auth/development'),admin,true).send({identity:'member'}).expect(404);
 await browser(request(http).post('/v1/admin/operator-invitations'),admin,true).send({subjectId:account.id,role:'owner'}).expect(403);
 const devSession=await session(saved);await browser(request(http).get('/v1/admin/development-accounts'),devSession).expect(403);
 await db.administrator.create({data:{subjectId:account.id,enabled:true,role:'owner',totpSecret:''}});assert.equal((await policy()).administrator,false);
 await server('staff_room','staff');assert.ok(!(await policy()).allowedServerIds.includes('staff_room'));
 const rows=(await browser(request(http).get('/v1/admin/development-accounts')).expect(200)).body.accounts;assert.equal(rows.length,1);
 assert.equal(await db.auditEvent.count({where:{action:'admin.development_account_created',actorSubjectId:admin.subject.id}}),1);
});

test('membership, simulated Discord, selected users and personal limits use the same server policy',async()=>{
 let account=(await create()).body.account;
 await server('all','university');await server('linked','university','linked');await server('unlinked','university','unlinked');await server('selected','selected','any',[account.id]);
 assert.deepEqual((await policy()).allowedServerIds,['all','lobby','selected','survival','unlinked']);
 const previous=await policy();account=(await update(account,{member:false,discordLinked:true})).body.account;
 const changed=await policy();assert.deepEqual(changed.allowedServerIds,['all','linked','selected']);assert.equal(changed.display.member,false);assert.equal(changed.display.roleLabel,'');assert.equal(changed.discordLinked,true);assert.ok(changed.policyVersion>previous.policyVersion);assert.equal(await db.discordIdentity.count(),0);assert.equal(await db.discordRoleState.count(),0);assert.equal(await db.membershipSemester.count(),0);
 await browser(request(http).put(`/v1/admin/members/${account.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['linked']}).expect(200);assert.deepEqual((await policy()).allowedServerIds,['linked']);
 const picker=(await browser(request(http).get('/v1/admin/members?q=PassportTest')).expect(200)).body.members;assert.equal(picker[0].id,account.id);assert.equal(picker[0].identityProvider,'managed-development');
 const target=await db.serverRecord.findUnique({where:{id:'all'}});await browser(request(http).put('/v1/admin/servers/all'),admin,true).send({label:target.label,enabled:true,sensitive:false,accessMode:'selected',allowedSubjectIds:[account.id],expectedUpdatedAt:target.updatedAt.toISOString()}).expect(200);
 account=(await browser(request(http).get('/v1/admin/development-accounts')).expect(200)).body.accounts[0];account=(await update(account,{enabled:false})).body.account;assert.deepEqual((await policy()).allowedServerIds,[]);assert.equal((await policy()).display.displayName,'');
 const disabledPicker=(await browser(request(http).get('/v1/admin/members?q=PassportTest')).expect(200)).body.members[0];assert.ok(disabledPicker.eligibleServerIds.includes('linked'));
 await browser(request(http).put(`/v1/admin/members/${account.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['linked']}).expect(200);assert.deepEqual((await policy()).allowedServerIds,['linked']);
});

test('existing school UUID and stale school link sessions cannot be overwritten or used to claim managed accounts',async()=>{
 const real=await subject();await db.minecraftIdentity.create({data:{uuid:profileUuid,name:'ExistingReal',subjectId:real.id}});
 assert.equal((await create({},409)).body.code,'minecraft_already_linked');assert.equal(await db.developmentMinecraftAccount.count(),0);assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:profileUuid}})).subjectId,real.id);
 profileUuid=randomUUID();const game={minecraftUuid:profileUuid,minecraftName:'PassportTest',gameSessionId:randomUUID()};const link=(await service(request(http).post('/v1/link-sessions')).send(game).expect(201)).body;
 await create();assert.equal((await db.linkSession.findUnique({where:{id:link.id}})).status,'cancelled');
 const portal=await session(real,PORTAL),token=new URL(link.url).hash.slice(7);const {privacyNotice}=require('../dist/privacy');await browser(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`),portal,true).send({token,consent:{accepted:true,version:privacyNotice.version}}).expect(409);
 await create({},409);
});

test('mutations require current admin write authority, same-origin CSRF and strict schemas before profile lookup',async()=>{
 await request(http).get('/v1/admin/development-accounts').set('Host',ADMIN).expect(401);
 await browser(request(http).post('/v1/admin/development-accounts')).send(base).expect(403);
 const viewer=await session(await subject());await db.administrator.create({data:{subjectId:viewer.subject.id,enabled:true,role:'viewer',totpSecret:''}});await create({},403,viewer);assert.equal(fetchCalls,0);await browser(request(http).get('/v1/admin/development-accounts'),viewer).expect(200);
 await create({administrator:true},400);await create({minecraftName:'https://evil.test'},400);assert.equal(fetchCalls,0);
 const operator=await session(await subject());await db.administrator.create({data:{subjectId:operator.subject.id,enabled:true,role:'operator',totpSecret:''}});const account=(await create({},201,operator)).body.account;await update(account,{member:false},403,viewer);
 profileUuid=randomUUID();const previous=fetchImpl;fetchImpl=async(...args)=>{await db.administrator.update({where:{subjectId:admin.subject.id},data:{enabled:false}});return previous(...args);};await create({},403);assert.equal(await db.developmentMinecraftAccount.count(),1);
});

test('revisions reject stale writes and deletion revokes policy, removes selected references and retains UUID watermark',async()=>{
 const account=(await create()).body.account,first=await policy();const changed=(await update(account,{discordLinked:true})).body.account;
 assert.equal((await update(account,{member:false},409)).body.code,'development_account_changed');
 await browser(request(http).delete(`/v1/admin/development-accounts/${account.id}`),admin,true).send({expectedRevision:account.revision}).expect(409);
 await server('selected','selected','any',[account.id]);await db.playerPresence.create({data:{minecraftUuid:profileUuid,serverId:'lobby',observedAt:new Date(),expiresAt:new Date(Date.now()+60000)}});
 await browser(request(http).delete(`/v1/admin/development-accounts/${account.id}`),admin,true).send({expectedRevision:changed.revision}).expect(200);
 assert.equal(await db.subject.findUnique({where:{id:account.id}}),null);assert.equal(await db.playerPresence.count(),0);assert.deepEqual((await db.serverRecord.findUnique({where:{id:'selected'}})).allowedSubjectIds,[]);const after=await policy();assert.equal(after.status,'unlinked');assert.ok(after.policyVersion>first.policyVersion);assert.equal(await db.auditEvent.count({where:{action:'admin.development_account_deleted'}}),1);
});

test('managed game presence works while statistic writes are ignored even with the current epoch',async()=>{
 const account=(await create()).body.account;
 const response=await service(request(http).post('/v1/minecraft/presence')).send({serverId:'survival',observedAt:new Date().toISOString(),players:[profileUuid]}).expect(200);assert.equal(response.body.received,1);
 const listing=(await browser(request(http).get('/v1/admin/development-accounts')).expect(200)).body.accounts;assert.equal(listing[0].presence.online,true);
 const lookup=(await service(request(http).get('/v1/minecraft/players?query=PassportTest')).expect(200)).body.players[0];assert.equal(lookup.displayName,'개발용 계정');assert.equal(lookup.member,true);assert.equal(lookup.administrator,false);
 const identity=await db.minecraftIdentity.findUnique({where:{uuid:profileUuid}});const batch={id:randomUUID(),serverId:'survival',records:[{minecraftUuid:profileUuid,epoch:identity.telemetryEpoch,playSeconds:20,blocksBroken:1,blocksPlaced:0,damageTakenMilli:0,deaths:0,mobKills:0,playerKills:0,distanceCm:0}]};
 const collected=await service(request(http).post('/v1/minecraft/stats/batches')).send(batch).expect(200);assert.equal(collected.body.received,0);assert.equal(await db.activityGeneration.count(),0);
 await update(account,{enabled:false});assert.equal(await db.playerPresence.count(),0);
});

test('profile errors and forged managed provider markers fail closed without inserting identities',async()=>{
 fetchImpl=async()=>new Response(null,{status:404});assert.equal((await create({},404)).body.code,'minecraft_profile_not_found');
 fetchImpl=async()=>new Response(JSON.stringify({id:profileUuid.replaceAll('-',''),name:'WrongName'}));assert.equal((await create({},503)).body.code,'minecraft_profile_unavailable');
 fetchImpl=async()=>new Response('x'.repeat(4097));await create({},503);assert.equal(await db.developmentMinecraftAccount.count(),0);
 const fake=await subject({identityProvider:'managed-development'});await db.minecraftIdentity.create({data:{uuid:profileUuid,name:'Fake',subjectId:fake.id}});assert.deepEqual((await policy()).allowedServerIds,[]);
});


test('concurrent registration and revision writes have one winner without duplicate identities',async()=>{
 const results=await Promise.all([browser(request(http).post('/v1/admin/development-accounts'),admin,true).send(base),browser(request(http).post('/v1/admin/development-accounts'),admin,true).send(base)]);
 assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal(await db.developmentMinecraftAccount.count(),1);assert.equal(await db.minecraftIdentity.count(),1);
 const account=results.find(r=>r.status===201).body.account;
 const body={member:false,discordLinked:true,enabled:true,expectedRevision:account.revision};
 const writes=await Promise.all([browser(request(http).put(`/v1/admin/development-accounts/${account.id}`),admin,true).send(body),browser(request(http).put(`/v1/admin/development-accounts/${account.id}`),admin,true).send(body)]);
 assert.deepEqual(writes.map(r=>r.status).sort(),[200,409]);assert.equal(await db.auditEvent.count({where:{action:'admin.development_account_updated'}}),1);
 assert.equal((await browser(request(http).delete(`/v1/admin/members/${account.id}/minecraft`),admin,true).expect(409)).body.code,'development_account_managed_separately');
});
