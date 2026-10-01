const {test,before,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const raw=process.env.TEST_DATABASE_URL;
if(!raw||!new URL(raw).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
const database=new URL(raw);database.searchParams.set('schema','registry_test');
Object.assign(process.env,{DATABASE_URL:database.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',API_SERVICE_TOKEN:'registry-service-'.repeat(4),SESSION_SECRET:'registry-session-'.repeat(4),ROSTER_MATCHING_SECRET:'registry-roster-'.repeat(4),DATA_ENCRYPTION_KEY:'cd'.repeat(32),ADMIN_MFA_REQUIRED:'false',SHEETS_SYNC_ENABLED:'false'});
const {createApp}=require('../dist/app');
const {hash,csrf}=require('../dist/security');
const {seedServerRegistry}=require('../dist/registry');
const {privacyNotice}=require('../dist/privacy');
const db=new PrismaClient({datasources:{db:{url:database.href}}});
let app,http,admin;
const ADMIN='admin.example.test',PORTAL='portal.example.test';
const service=r=>r.set('Authorization',`Bearer ${process.env.API_SERVICE_TOKEN}`);
function browser(r,user=admin,mutation=false){r=r.set('Host',user.host).set('Cookie',user.cookie);return mutation?r.set('Origin',`https://${user.host}`).set('X-CSRF-Token',user.csrf):r;}
async function subject(changes={}){return db.subject.create({data:{universityKey:randomUUID(),displayName:'Synthetic Registry Member',identityProvider:'usaint',universityVerifiedUntil:new Date(Date.now()+3600000),membershipStatus:'active',verifiedUntil:new Date(Date.now()+3600000),allowedServerIds:['lobby','survival'],...changes}});}
async function session(subject,host=ADMIN){const token=randomBytes(32).toString('base64url');await db.webSession.create({data:{subjectId:subject.id,tokenHash:hash(token),audienceHost:host,expiresAt:new Date(Date.now()+3600000)}});return{subject,host,cookie:`__Host-passport_${host===ADMIN?'admin':'portal'}_session=${token}`,csrf:csrf(process.env.SESSION_SECRET,token)};}
async function heartbeat(source,servers,status=200){return service(request(http).post('/v1/minecraft/servers/heartbeat')).send({source,servers}).expect(status);}
async function settings(id,changes={},status=200,user=admin){const current=await db.serverRecord.findUnique({where:{id}});return browser(request(http).put(`/v1/admin/servers/${id}`),user,true).send({label:current.label,sensitive:current.sensitive,enabled:current.enabled,accessMode:current.accessMode,allowedSubjectIds:current.allowedSubjectIds,expectedUpdatedAt:current.updatedAt.toISOString(),...changes}).expect(status);}
async function policy(identity){return(await service(request(http).get(`/v1/minecraft/policies/${identity.uuid}`)).expect(200)).body;}
before(async()=>{await db.$connect();});
after(async()=>{await db.$disconnect();});
beforeEach(async()=>{
 await db.$executeRawUnsafe('TRUNCATE TABLE "ServerRecord", "ConsumedUniversityToken", "UniversityAuthRequest", "Administrator", "AuditEvent", "PolicyEvent", "LinkSession", "WebSession", "MinecraftIdentity", "Subject", "RosterMembership", "RosterSnapshot" RESTART IDENTITY CASCADE');
 app=await createApp();http=app.getHttpServer();const actor=await subject();admin=await session(actor);
 await db.administrator.create({data:{subjectId:actor.id,enabled:true,role:'owner',totpSecret:''}});
});
afterEach(async()=>{await app?.close();});

test('bootstrap preserves existing records and heartbeats discover disabled servers without changing settings revisions',async()=>{
 const initial=await db.serverRecord.findUnique({where:{id:'lobby'}});assert.equal(initial.enabled,true);assert.equal(initial.accessMode,'roster');
 await request(http).post('/v1/minecraft/servers/heartbeat').send({source:'paper',servers:[{id:'creative',label:'건축'}]}).expect(401);
 assert.deepEqual((await heartbeat('paper',[{id:'creative',label:'건축'}])).body,{received:1,registered:1});
 const found=await db.serverRecord.findUnique({where:{id:'creative'}});assert.equal(found.enabled,false);assert.equal(found.accessMode,'roster');
 await heartbeat('velocity',[{id:'creative',label:'ignored replacement'},{id:'lobby',label:'ignored lobby'}]);
 const listing=(await browser(request(http).get('/v1/admin/servers')).expect(200)).body.servers;
 const listed=listing.find(server=>server.id==='creative');assert.equal(listed.label,'건축');assert.equal(listed.online,true);assert.equal(listed.proxyAvailable,true);assert.equal(listed.updatedAt,found.updatedAt.toISOString());
 assert.equal((await db.serverRecord.findUnique({where:{id:'lobby'}})).label,initial.label);
 assert.equal(await db.policyEvent.count(),0);
 assert.ok(!(await service(request(http).get('/v1/minecraft/servers')).expect(200)).body.servers.some(server=>server.id==='creative'));
 await seedServerRegistry(db,[{id:'creative',label:'seed must not overwrite'},{id:'another',label:'not re-seeded'}]);
 assert.equal(await db.serverRecord.count(),3);assert.equal((await db.serverRecord.findUnique({where:{id:'creative'}})).enabled,false);
});

test('registry members and selected modes share policy, portal and admin eligibility while respecting personal limits',async()=>{
 const member=await subject();const portal=await session(member,PORTAL);const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryTest',subjectId:member.id}});
 const initial=await policy(identity);assert.deepEqual(initial.allowedServerIds,['lobby','survival']);
 await heartbeat('paper',[{id:'creative',label:'건축'}]);await settings('creative',{enabled:true,accessMode:'members'});
 const expanded=await policy(identity);assert.deepEqual(expanded.allowedServerIds,['creative','lobby','survival']);assert.ok(expanded.policyVersion>initial.policyVersion);
 assert.deepEqual((await browser(request(http).get('/v1/me/servers'),portal).expect(200)).body.servers.map(server=>server.id),expanded.allowedServerIds);
 await browser(request(http).put(`/v1/admin/members/${member.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['lobby']}).expect(200);
 assert.deepEqual((await policy(identity)).allowedServerIds,['lobby']);
 const listed=(await browser(request(http).get('/v1/admin/members')).expect(200)).body.members.find(row=>row.id===member.id);assert.deepEqual(listed.eligibleServerIds,['creative','lobby','survival']);
 await settings('creative',{accessMode:'selected',allowedSubjectIds:[admin.subject.id]});
 assert.deepEqual((await browser(request(http).get('/v1/admin/members')).expect(200)).body.members.find(row=>row.id===member.id).eligibleServerIds,['lobby','survival']);
 await browser(request(http).put(`/v1/admin/members/${member.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['creative']}).expect(403);
 await settings('creative',{allowedSubjectIds:[member.id]});
 await browser(request(http).put(`/v1/admin/members/${member.id}/access`),admin,true).send({suspended:true,restricted:true,serverIds:['creative']}).expect(200);
 assert.deepEqual((await policy(identity)).allowedServerIds,[]);
 await browser(request(http).put(`/v1/admin/members/${member.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['creative']}).expect(200);
 assert.deepEqual((await policy(identity)).allowedServerIds,['creative']);
 await db.subject.update({where:{id:member.id},data:{membershipStatus:'inactive'}});assert.deepEqual((await policy(identity)).allowedServerIds,[]);
});

test('administrative server writes enforce CSRF, selected school identities and optimistic settings versions',async()=>{
 const before=await db.serverRecord.findUnique({where:{id:'lobby'}});
 const body={label:'로비 수정',enabled:true,sensitive:true,accessMode:'selected',allowedSubjectIds:[admin.subject.id],expectedUpdatedAt:before.updatedAt.toISOString()};
 await browser(request(http).put('/v1/admin/servers/lobby')).send(body).expect(403);
 const outsider=await session(await subject());await browser(request(http).put('/v1/admin/servers/lobby'),outsider,true).send(body).expect(403);
 await settings('lobby',{allowedSubjectIds:[randomUUID()],accessMode:'selected'},403);
 const nonSchool=await subject({identityProvider:'development'});await settings('lobby',{allowedSubjectIds:[nonSchool.id],accessMode:'selected'},403);
 await heartbeat('paper',[{id:'lobby',label:'ignored'}]);
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryAdmin',subjectId:admin.subject.id}});const initial=await policy(identity);
 const updated=await browser(request(http).put('/v1/admin/servers/lobby'),admin,true).send(body).expect(200);
 assert.equal(updated.body.server.sensitive,true);assert.notEqual(updated.body.server.updatedAt,body.expectedUpdatedAt);
 assert.equal((await browser(request(http).put('/v1/admin/servers/lobby'),admin,true).send({...body,label:'stale overwrite'}).expect(409)).body.code,'server_changed');
 assert.equal((await db.serverRecord.findUnique({where:{id:'lobby'}})).label,'로비 수정');
 assert.equal((await policy(identity)).policyVersion,initial.policyVersion+1);
 assert.equal(await db.policyEvent.count({where:{minecraftUuid:identity.uuid}}),1);
 const audit=await db.auditEvent.findFirst({where:{action:'admin.server_updated'}});assert.equal(audit.actorSubjectId,admin.subject.id);assert.equal(audit.details.before.label,before.label);assert.equal(audit.details.after.label,'로비 수정');
});

test('heartbeat validates batches and enforces the total registry cap atomically',async()=>{
 await heartbeat('paper',[{id:'lobby',label:'a'},{id:'lobby',label:'b'}],400);
 await heartbeat('paper',[{id:'BAD ID',label:'a'}],400);
 await heartbeat('paper',[{id:'valid',label:'\u0000invalid'}],400);
 const batch=Array.from({length:62},(_,i)=>({id:`server_${i}`,label:`Server ${i}`}));await heartbeat('velocity',batch);
 assert.equal(await db.serverRecord.count(),64);
 const old=await db.serverRecord.findUnique({where:{id:'lobby'}});
 assert.equal((await heartbeat('paper',[{id:'lobby',label:'ignored'},{id:'overflow',label:'Overflow'}],409)).body.code,'registry_full');
 assert.equal(await db.serverRecord.count(),64);assert.deepEqual((await db.serverRecord.findUnique({where:{id:'lobby'}})).paperSeenAt,old.paperSeenAt);
});

test('Paper liveness expires independently from configured proxy availability and permissions',async()=>{
 await heartbeat('velocity',[{id:'lobby',label:'lobby'}]);
 await db.serverRecord.update({where:{id:'lobby'},data:{paperSeenAt:new Date(Date.now()-91000)}});
 const server=(await browser(request(http).get('/v1/admin/servers')).expect(200)).body.servers.find(item=>item.id==='lobby');
 assert.equal(server.online,false);assert.equal(server.proxyAvailable,true);assert.equal(server.enabled,true);
 await settings('lobby',{enabled:false});
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryDisabled',subjectId:admin.subject.id}});
 assert.deepEqual((await policy(identity)).allowedServerIds,['survival']);
});

async function publicServer(){await heartbeat('paper',[{id:'campus',label:'학교 인증 공개 서버'}]);await settings('campus',{enabled:true,accessMode:'university'});}
async function gameLink(){const identity={minecraftUuid:randomUUID(),minecraftName:'RegistryGuest',gameSessionId:randomUUID()};const result=await service(request(http).post('/v1/link-sessions')).send(identity).expect(201);return{...result.body,...identity,token:new URL(result.body.url).hash.slice(7)};}
function webLink(link,user){return browser(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`),user,true).send({token:link.token,consent:{accepted:true,version:privacyNotice.version}});}
function confirmGame(link){return service(request(http).post(`/v1/link-sessions/${link.id}/game-confirm`)).send({minecraftUuid:link.minecraftUuid,gameSessionId:link.gameSessionId});}
async function visibleServers(user){return(await browser(request(http).get('/v1/me/servers'),user).expect(200)).body.servers;}

test('university is opt-in: nonmembers see only allowed servers and can link without acquiring member status or prefix',async()=>{
 const outsider=await subject({membershipStatus:'inactive',verifiedUntil:new Date(0),roleLabel:'old member prefix'}),portal=await session(outsider,PORTAL);
 const original=await db.serverRecord.findMany({orderBy:{id:'asc'}});const link=await gameLink();
 assert.deepEqual(await visibleServers(portal),[]);assert.equal((await webLink(link,portal).expect(403)).body.code,'membership_required');
 await publicServer();
 assert.deepEqual(await db.serverRecord.findMany({where:{id:{in:original.map(row=>row.id)}},orderBy:{id:'asc'}}),original);
 assert.deepEqual(await visibleServers(portal),[{id:'campus',label:'학교 인증 공개 서버',sensitive:false}]);
 await webLink(link,portal).expect(200);await confirmGame(link).expect(200);
 const result=await policy({uuid:link.minecraftUuid});assert.equal(result.status,'active');assert.deepEqual(result.allowedServerIds,['campus']);assert.equal(result.display.roleLabel,'');assert.ok(Date.parse(result.expiresAt)-Date.parse(result.issuedAt)>59000);
 const profile=(await browser(request(http).get('/v1/me'),portal).expect(200)).body;assert.equal(profile.membership.status,'inactive');assert.equal(profile.membership.effectiveStatus,'revoked');
 assert.equal(await db.auditEvent.count({where:{action:'minecraft.linked',subjectId:outsider.id}}),1);
});

test('roster, members and selected keep the active membership gate even when the same nonmember has university access',async()=>{
 const outsider=await subject({membershipStatus:'inactive',verifiedUntil:new Date(Date.now()+3600000)}),portal=await session(outsider,PORTAL);
 await publicServer();await heartbeat('paper',[{id:'club',label:'회원 전용 비공개 이름'},{id:'selected',label:'선택 회원 전용 이름'}]);
 await settings('club',{enabled:true,accessMode:'members'});await settings('selected',{enabled:true,accessMode:'selected',allowedSubjectIds:[outsider.id]});
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryGuest',subjectId:outsider.id}});
 assert.deepEqual((await policy(identity)).allowedServerIds,['campus']);assert.deepEqual((await visibleServers(portal)).map(row=>row.id),['campus']);
 const response=JSON.stringify(await visibleServers(portal));assert.ok(!response.includes('회원 전용'));assert.ok(!response.includes('lobby'));assert.ok(!response.includes('survival'));
 await settings('campus',{enabled:false});const denied=await policy(identity);assert.deepEqual(denied.allowedServerIds,[]);assert.equal(denied.status,'revoked');assert.deepEqual(await visibleServers(portal),[]);
});

test('university still requires current real school identity, global non-suspension and personal scope',async()=>{
 await publicServer();const outsider=await subject({membershipStatus:'inactive',verifiedUntil:new Date(0)}),portal=await session(outsider,PORTAL);
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryBounds',subjectId:outsider.id}});
 const base={identityProvider:'usaint',universityVerifiedUntil:new Date(Date.now()+3600000),accessSuspended:false,membershipStatus:'inactive',scopeRestricted:false,scopeLimit:[]};
 for(const change of [{accessSuspended:true},{membershipStatus:'suspended'},{universityVerifiedUntil:new Date(0)},{universityVerifiedUntil:null},{identityProvider:'development'},{identityProvider:'unknown'},{scopeRestricted:true,scopeLimit:[]}]){
  await db.subject.update({where:{id:outsider.id},data:{...base,...change}});const denied=await policy(identity);assert.notEqual(denied.status,'active');assert.deepEqual(denied.allowedServerIds,[]);assert.deepEqual(await visibleServers(portal),[]);
 }
 await db.subject.update({where:{id:outsider.id},data:{...base,scopeRestricted:true,scopeLimit:['campus']}});assert.deepEqual((await policy(identity)).allowedServerIds,['campus']);
});

test('mixed university/member policy expires at roster TTL and recomputes to university alone after expiry',async()=>{
 await publicServer();const rosterUntil=new Date(Date.now()+20000),schoolUntil=new Date(Date.now()+45000);
 const member=await subject({verifiedUntil:rosterUntil,universityVerifiedUntil:schoolUntil,roleLabel:'회원'}),portal=await session(member,PORTAL);
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryExpiry',subjectId:member.id}});
 const mixed=await policy(identity);assert.deepEqual(mixed.allowedServerIds,['campus','lobby','survival']);assert.equal(Date.parse(mixed.expiresAt),rosterUntil.getTime());assert.equal(mixed.display.roleLabel,'회원');
 await db.subject.update({where:{id:member.id},data:{verifiedUntil:new Date(0)}});
 const campus=await policy(identity);assert.equal(campus.status,'active');assert.deepEqual(campus.allowedServerIds,['campus']);assert.equal(campus.display.roleLabel,'');assert.equal(Date.parse(campus.expiresAt),schoolUntil.getTime());assert.ok(campus.policyVersion>mixed.policyVersion);
 assert.equal((await browser(request(http).get('/v1/me'),portal).expect(200)).body.membership.effectiveStatus,'stale');
 await db.subject.update({where:{id:member.id},data:{universityVerifiedUntil:new Date(0)}});const denied=await policy(identity);assert.equal(denied.status,'stale');assert.deepEqual(denied.allowedServerIds,[]);assert.ok(denied.policyVersion>campus.policyVersion);
});

test('university-only personal scope ignores unused roster TTL while empty active-member scope is not active game authorization',async()=>{
 await publicServer();const member=await subject({verifiedUntil:new Date(Date.now()+10000),scopeRestricted:true,scopeLimit:['campus']});
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryLimited',subjectId:member.id}});
 const campus=await policy(identity);assert.deepEqual(campus.allowedServerIds,['campus']);assert.equal(Date.parse(campus.expiresAt)-Date.parse(campus.issuedAt),60000);
 await db.subject.update({where:{id:member.id},data:{scopeLimit:[]}});const denied=await policy(identity);assert.equal(denied.status,'revoked');assert.deepEqual(denied.allowedServerIds,[]);
});

test('university-only access with a member prefix caps the display lease at membership expiry',async()=>{
 await publicServer();const expiry=new Date(Date.now()+15000),member=await subject({verifiedUntil:expiry,roleLabel:'회원',scopeRestricted:true,scopeLimit:['campus']});
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryPrefix',subjectId:member.id}});
 const before=await policy(identity);assert.deepEqual(before.allowedServerIds,['campus']);assert.equal(before.display.roleLabel,'회원');assert.equal(Date.parse(before.expiresAt),expiry.getTime());
 await db.subject.update({where:{id:member.id},data:{verifiedUntil:new Date(0)}});const after=await policy(identity);
 assert.equal(after.status,'active');assert.deepEqual(after.allowedServerIds,['campus']);assert.equal(after.display.roleLabel,'');assert.equal(Date.parse(after.expiresAt)-Date.parse(after.issuedAt),60000);assert.ok(after.policyVersion>before.policyVersion);
});

test('game completion rechecks university eligibility after web approval and rolls back confirmation when permission disappears',async()=>{
 await publicServer();const outsider=await subject({membershipStatus:'inactive',verifiedUntil:new Date(0)}),portal=await session(outsider,PORTAL),link=await gameLink();
 await webLink(link,portal).expect(200);await settings('campus',{enabled:false});await confirmGame(link).expect(403);
 const pending=await db.linkSession.findUnique({where:{id:link.id}});assert.equal(pending.gameConfirmedAt,null);assert.equal(pending.status,'pending');assert.equal((await policy({uuid:link.minecraftUuid})).status,'unlinked');
 await settings('campus',{enabled:true});await db.subject.update({where:{id:outsider.id},data:{accessSuspended:true}});await confirmGame(link).expect(403);
 await db.subject.update({where:{id:outsider.id},data:{accessSuspended:false}});await confirmGame(link).expect(200);assert.equal((await policy({uuid:link.minecraftUuid})).status,'active');
});

test('admin eligibility can restore a university-only nonmember without expanding club scopes',async()=>{
 await publicServer();const outsider=await subject({membershipStatus:'inactive',verifiedUntil:new Date(0),accessSuspended:true,scopeRestricted:true,scopeLimit:[]});
 const rows=(await browser(request(http).get('/v1/admin/members')).expect(200)).body.members;assert.deepEqual(rows.find(row=>row.id===outsider.id).eligibleServerIds,['campus']);
 await browser(request(http).put(`/v1/admin/members/${outsider.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['lobby']}).expect(403);
 await browser(request(http).put(`/v1/admin/members/${outsider.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['campus']}).expect(200);
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryRestore',subjectId:outsider.id}});assert.deepEqual((await policy(identity)).allowedServerIds,['campus']);
});

test('profile membership freshness is independent from school freshness while all game scopes still require school verification',async()=>{
 await publicServer();const member=await subject({universityVerifiedUntil:new Date(0)}),portal=await session(member,PORTAL);
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistrySchool',subjectId:member.id}});
 const profile=(await browser(request(http).get('/v1/me'),portal).expect(200)).body;
 assert.equal(profile.membership.status,'active');assert.equal(profile.membership.effectiveStatus,'active');assert.equal(profile.universityVerifiedUntil,new Date(0).toISOString());
 const denied=await policy(identity);assert.equal(denied.status,'stale');assert.deepEqual(denied.allowedServerIds,[]);assert.deepEqual(await visibleServers(portal),[]);
});

test('additive university migration keeps an allowlisted database constraint',async()=>{
 await publicServer();assert.equal((await db.serverRecord.findUnique({where:{id:'campus'}})).accessMode,'university');
 await assert.rejects(db.serverRecord.create({data:{id:'unsupported',label:'Unsupported',enabled:true,accessMode:'everyone'}}),/ServerRecord_accessMode_check/);
 assert.equal(await db.serverRecord.count({where:{id:'unsupported'}}),0);
});
