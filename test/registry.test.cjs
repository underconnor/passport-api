const {test,before,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const raw=process.env.TEST_DATABASE_URL;
if(!raw||!new URL(raw).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
const database=new URL(raw);database.searchParams.set('schema','registry_test');
Object.assign(process.env,{DATABASE_URL:database.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',API_SERVICE_TOKEN:'registry-service-'.repeat(4),PASSPORT_DISCORD_SERVICE_TOKEN:'registry-discord-'.repeat(4),DISCORD_GUILD_ID:'100000000000000001',DISCORD_MEMBER_ROLE_ID:'100000000000000002',SESSION_SECRET:'registry-session-'.repeat(4),ROSTER_MATCHING_SECRET:'registry-roster-'.repeat(4),DATA_ENCRYPTION_KEY:'cd'.repeat(32),ADMIN_MFA_REQUIRED:'false',SHEETS_SYNC_ENABLED:'false'});
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
 await db.$executeRawUnsafe('TRUNCATE TABLE "DiscordIdentity", "DiscordLinkSession", "ServerRecord", "ConsumedUniversityToken", "UniversityAuthRequest", "Administrator", "AuditEvent", "PolicyEvent", "LinkSession", "WebSession", "MinecraftIdentity", "Subject", "RosterMembership", "RosterSnapshot" RESTART IDENTITY CASCADE');
 app=await createApp();http=app.getHttpServer();const actor=await subject();admin=await session(actor);
 await db.administrator.create({data:{subjectId:actor.id,enabled:true,role:'owner',totpSecret:''}});
});
afterEach(async()=>{await app?.close();});

test('bootstrap preserves existing records and heartbeats discover disabled servers without changing settings revisions',async()=>{
 const initial=await db.serverRecord.findUnique({where:{id:'lobby'}});assert.equal(initial.enabled,true);assert.equal(initial.accessMode,'members');
 await request(http).post('/v1/minecraft/servers/heartbeat').send({source:'paper',servers:[{id:'creative',label:'건축'}]}).expect(401);
 assert.deepEqual((await heartbeat('paper',[{id:'creative',label:'건축'}])).body,{received:1,registered:1});
 const found=await db.serverRecord.findUnique({where:{id:'creative'}});assert.equal(found.enabled,false);assert.equal(found.accessMode,'members');
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
 await db.subject.update({where:{id:member.id},data:{membershipStatus:'inactive'}});assert.deepEqual((await policy(identity)).allowedServerIds,['creative']);
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
 assert.deepEqual(await visibleServers(portal),[{id:'campus',commandName:'campus',label:'학교 인증 공개 서버',sensitive:false}]);
 await webLink(link,portal).expect(200);await confirmGame(link).expect(200);
 const result=await policy({uuid:link.minecraftUuid});assert.equal(result.status,'active');assert.deepEqual(result.allowedServerIds,['campus']);assert.equal(result.display.roleLabel,'');assert.ok(Date.parse(result.expiresAt)-Date.parse(result.issuedAt)>59000);
 const profile=(await browser(request(http).get('/v1/me'),portal).expect(200)).body;assert.equal(profile.membership.status,'inactive');assert.equal(profile.membership.effectiveStatus,'revoked');
 assert.equal(await db.auditEvent.count({where:{action:'minecraft.linked',subjectId:outsider.id}}),1);
});

test('members servers keep the membership gate while selected grants explicitly chosen school users',async()=>{
 const outsider=await subject({membershipStatus:'inactive',verifiedUntil:new Date(Date.now()+3600000)}),portal=await session(outsider,PORTAL);
 await publicServer();await heartbeat('paper',[{id:'club',label:'회원 전용 비공개 이름'},{id:'selected',label:'선택 회원 전용 이름'}]);
 await settings('club',{enabled:true,accessMode:'members'});await settings('selected',{enabled:true,accessMode:'selected',allowedSubjectIds:[outsider.id]});
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'RegistryGuest',subjectId:outsider.id}});
 assert.deepEqual((await policy(identity)).allowedServerIds,['campus','selected']);assert.deepEqual((await visibleServers(portal)).map(row=>row.id),['campus','selected']);
 const response=JSON.stringify(await visibleServers(portal));assert.ok(!response.includes('비공개 이름'));assert.ok(!response.includes('lobby'));assert.ok(!response.includes('survival'));
 await settings('campus',{enabled:false});assert.deepEqual((await policy(identity)).allowedServerIds,['selected']);
 await settings('selected',{allowedSubjectIds:[]});const denied=await policy(identity);assert.deepEqual(denied.allowedServerIds,[]);assert.equal(denied.status,'revoked');assert.deepEqual(await visibleServers(portal),[]);
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
 await assert.rejects(db.serverRecord.create({data:{id:'unsupported',commandName:'unsupported',label:'Unsupported',enabled:true,accessMode:'everyone'}}),/ServerRecord_accessMode_check/);
 assert.equal(await db.serverRecord.count({where:{id:'unsupported'}}),0);
});

test('server display labels and normalized command names stay independent across policy, portal and registry DTOs',async()=>{
 const member=await subject(),portal=await session(member,PORTAL),identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'NamedServer',subjectId:member.id}});
 await db.activityGeneration.create({data:{epoch:identity.telemetryEpoch,subjectId:member.id,minecraftUuid:identity.uuid}});
 await db.activityTotal.create({data:{epoch:identity.telemetryEpoch,serverId:'lobby',playSeconds:321n}});
 const memberBefore=await db.subject.findUnique({where:{id:member.id}}),initial=await policy(identity);
 assert.equal(initial.allowedServers.find(server=>server.id==='lobby').commandName,'lobby');
 const updated=(await settings('lobby',{label:'대학생 로비',commandName:'CAMPUS-로비'})).body.server;
 assert.equal(updated.id,'lobby');assert.equal(updated.label,'대학생 로비');assert.equal(updated.commandName,'campus-로비');
 const changed=await policy(identity);assert.deepEqual(changed.allowedServerIds,initial.allowedServerIds);assert.equal(changed.policyVersion,initial.policyVersion+1);
 assert.deepEqual(changed.allowedServers.find(server=>server.id==='lobby'),{id:'lobby',label:'대학생 로비',commandName:'campus-로비'});
 for(const response of [(await visibleServers(portal)),(await browser(request(http).get('/v1/admin/servers')).expect(200)).body.servers,(await service(request(http).get('/v1/minecraft/servers')).expect(200)).body.servers,(await browser(request(http).get('/v1/admin/overview')).expect(200)).body.servers]){
  assert.equal(response.find(server=>server.id==='lobby').commandName,'campus-로비');assert.equal(response.find(server=>server.id==='lobby').label,'대학생 로비');
 }
 await settings('lobby',{label:'표시 이름만 수정'});const preserved=await db.serverRecord.findUnique({where:{id:'lobby'}});assert.equal(preserved.commandName,'campus-로비');
 await settings('lobby',{commandName:'안내'});const renamed=await db.serverRecord.findUnique({where:{id:'lobby'}});assert.equal(renamed.label,'표시 이름만 수정');assert.equal(renamed.commandName,'안내');
 await heartbeat('paper',[{id:'lobby',label:'do not overwrite'}]);await heartbeat('velocity',[{id:'lobby',label:'ignored'}]);
 await seedServerRegistry(db,[{id:'lobby',label:'seed ignored'}]);const after=await db.serverRecord.findUnique({where:{id:'lobby'}});assert.equal(after.label,renamed.label);assert.equal(after.commandName,renamed.commandName);assert.equal(after.updatedAt.getTime(),renamed.updatedAt.getTime());
 assert.deepEqual(await db.subject.findUnique({where:{id:member.id}}),memberBefore);assert.equal((await db.activityTotal.findUnique({where:{epoch_serverId:{epoch:identity.telemetryEpoch,serverId:'lobby'}}})).playSeconds,321n);
 assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}})).telemetryEpoch,identity.telemetryEpoch);
 const audit=await db.auditEvent.findFirst({where:{action:'admin.server_updated'},orderBy:{createdAt:'asc'}});assert.equal(audit.details.before.commandName,'lobby');assert.equal(audit.details.after.commandName,'campus-로비');
});

test('server commands reject normalized duplicates and every other immutable ID without partial changes',async()=>{
 await settings('survival',{commandName:'WILD'});
 const before=await db.serverRecord.findUnique({where:{id:'lobby'}}),events=await db.policyEvent.count(),audits=await db.auditEvent.count();
 for(const commandName of ['wild','WILD','survival'])assert.equal((await settings('lobby',{label:'must roll back',commandName},409)).body.code,'server_command_conflict');
 assert.deepEqual(await db.serverRecord.findUnique({where:{id:'lobby'}}),before);assert.equal(await db.policyEvent.count(),events);assert.equal(await db.auditEvent.count(),audits);
 await settings('survival',{commandName:'야생'});assert.equal((await settings('lobby',{commandName:'야생'},409)).body.code,'server_command_conflict');
 assert.equal((await settings('lobby',{commandName:'LOBBY'})).body.server.commandName,'lobby');
});

test('concurrent server command claims serialize to one winner and heartbeat collisions roll back all discovery',async()=>{
 const records=await db.serverRecord.findMany({where:{id:{in:['lobby','survival']}}});
 const results=await Promise.all(records.map(current=>browser(request(http).put(`/v1/admin/servers/${current.id}`),admin,true).send({label:current.label,sensitive:current.sensitive,enabled:current.enabled,accessMode:current.accessMode,allowedSubjectIds:current.allowedSubjectIds,expectedUpdatedAt:current.updatedAt.toISOString(),commandName:'공용'})));
 assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);assert.equal(results.find(result=>result.status===409).body.code,'server_command_conflict');
 assert.equal(await db.serverRecord.count({where:{commandName:'공용'}}),1);
 await settings('lobby',{commandName:'future'});
 const old=await db.serverRecord.findUnique({where:{id:'lobby'}}),count=await db.serverRecord.count();
 assert.equal((await heartbeat('paper',[{id:'lobby',label:'ignored'},{id:'new_server',label:'new'},{id:'future',label:'collision'}],409)).body.code,'server_command_conflict');
 assert.equal(await db.serverRecord.count(),count);assert.equal(await db.serverRecord.count({where:{id:'new_server'}}),0);assert.deepEqual((await db.serverRecord.findUnique({where:{id:'lobby'}})).paperSeenAt,old.paperSeenAt);
 await heartbeat('paper',[{id:'fresh_server',label:'새 서버'}]);assert.equal((await db.serverRecord.findUnique({where:{id:'fresh_server'}})).commandName,'fresh_server');
});

test('command edits retain host, role, CSRF, unknown-field and optimistic-concurrency validation',async()=>{
 const before=await db.serverRecord.findUnique({where:{id:'lobby'}});
 for(const commandName of ['',null,'two words','/lobby','a'.repeat(65),'ㄱ','😀'])await settings('lobby',{commandName},400);
 const viewer=await subject();await db.administrator.create({data:{subjectId:viewer.id,enabled:true,role:'viewer',totpSecret:''}});await settings('lobby',{commandName:'안내'},403,await session(viewer));
 await settings('lobby',{commandName:'안내'},403,await session(admin.subject,PORTAL));
 const body={label:before.label,sensitive:before.sensitive,enabled:before.enabled,accessMode:before.accessMode,allowedSubjectIds:before.allowedSubjectIds,expectedUpdatedAt:before.updatedAt.toISOString(),commandName:'안내'};
 await browser(request(http).put('/v1/admin/servers/lobby')).send(body).expect(403);
 await browser(request(http).put('/v1/admin/servers/lobby'),admin,true).send({...body,id:'other'}).expect(400);
 await browser(request(http).put('/v1/admin/servers/lobby'),admin,true).send(body).expect(200);
 assert.equal((await browser(request(http).put('/v1/admin/servers/lobby'),admin,true).send({...body,commandName:'stale'}).expect(409)).body.code,'server_changed');
 assert.equal((await db.serverRecord.findUnique({where:{id:'lobby'}})).commandName,'안내');
});

test('commandName participates in policy fingerprints even when a persisted configuration update bypasses the API',async()=>{
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'PolicyNames',subjectId:admin.subject.id}}),before=await policy(identity);
 await db.serverRecord.update({where:{id:'lobby'},data:{commandName:'안내'}});
 const after=await policy(identity);assert.equal(after.policyVersion,before.policyVersion+1);assert.deepEqual(after.allowedServerIds,before.allowedServerIds);assert.equal(after.allowedServers.find(server=>server.id==='lobby').commandName,'안내');
});

test('command-name migration backfills IDs atomically without changing labels, revisions, permission arrays or historical server keys',async()=>{
 const schema='command_migration_'+randomUUID().replaceAll('-','');
 const sql=require('node:fs').readFileSync('prisma/migrations/20261002030000_server_command_name/migration.sql','utf8').replace(/^--.*$/gm,'');
 await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
  await tx.$executeRawUnsafe('CREATE TABLE "ServerRecord" ("id" TEXT PRIMARY KEY,"label" TEXT NOT NULL,"allowedSubjectIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],"updatedAt" TIMESTAMP(3) NOT NULL)');
  await tx.$executeRawUnsafe('CREATE TABLE "ActivityTotal" ("serverId" TEXT NOT NULL,"playSeconds" BIGINT NOT NULL)');
  await tx.$executeRawUnsafe('INSERT INTO "ServerRecord" VALUES (\'lobby\',\'로비 표시\',ARRAY[]::UUID[],\'2026-01-01\'),(\'survival\',\'생존 표시\',ARRAY[]::UUID[],\'2026-01-02\')');
  await tx.$executeRawUnsafe('INSERT INTO "ActivityTotal" VALUES (\'lobby\',321)');
  const before=await tx.$queryRawUnsafe(`SELECT "id","label","allowedSubjectIds","updatedAt" FROM "${schema}"."ServerRecord" ORDER BY "id"`);
  // Keep PL/pgSQL's dollar-quoted trigger body intact when executing this migration in the isolated schema.
  let dollarQuoted=false,statement='';const statements=[];
  for(const token of sql.split(/(\$\$|;)/)){if(token==='$$')dollarQuoted=!dollarQuoted;if(token===';'&&!dollarQuoted){statements.push(statement.trim());statement='';}else statement+=token;}
  if(statement.trim())statements.push(statement.trim());
  for(const statement of statements.filter(value=>value&&!['BEGIN','COMMIT'].includes(value)))await tx.$executeRawUnsafe(statement);
  const rows=await tx.$queryRawUnsafe(`SELECT "id","label","allowedSubjectIds","updatedAt","commandName" FROM "${schema}"."ServerRecord" ORDER BY "id"`);assert.deepEqual(rows.map(({commandName,...row})=>row),before);assert.deepEqual(rows.map(row=>row.commandName),['lobby','survival']);
  assert.equal((await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."ActivityTotal"`))[0].playSeconds,321n);
  await tx.$executeRawUnsafe('INSERT INTO "ServerRecord" ("id","label","updatedAt") VALUES (\'legacy_insert\',\'Old API insert\',CURRENT_TIMESTAMP)');
  const legacy=(await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."ServerRecord" WHERE "id"='legacy_insert'`))[0];assert.equal(legacy.commandName,'legacy_insert');assert.equal(legacy.label,'Old API insert');
  const column=(await tx.$queryRawUnsafe('SELECT "is_nullable" FROM information_schema.columns WHERE table_schema=$1 AND table_name=\'ServerRecord\' AND column_name=\'commandName\'',schema))[0];assert.equal(column.is_nullable,'NO');
  await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
 },{timeout:30000});
 await assert.rejects(db.serverRecord.create({data:{id:'duplicated_command',commandName:'lobby',label:'Synthetic'}}),error=>error.code==='P2002');
 await assert.rejects(db.serverRecord.create({data:{id:'invalid_command',commandName:'UPPER CASE',label:'Synthetic'}}),/ServerRecord_commandName_check/);
 await assert.rejects(db.$executeRawUnsafe('UPDATE "ServerRecord" SET "commandName"=NULL WHERE "id"=\'lobby\''),error=>error.code==='P2010'&&error.meta?.code==='23502');
 assert.equal((await db.serverRecord.findUnique({where:{id:'lobby'}})).commandName,'lobby');
});

const discordBot=r=>r.set('Authorization',`Bearer ${process.env.PASSPORT_DISCORD_SERVICE_TOKEN}`);
let discordSequence=500000000000000000n;
async function connectDiscord(portal){
 const value=String(++discordSequence),result=await discordBot(request(http).post('/v1/discord/link-sessions')).send({discordUserId:value,guildId:process.env.DISCORD_GUILD_ID,discordUsername:'synthetic_registry',interactionId:value}).expect(201);
 const token=new URL(result.body.url).hash.slice(7);
 await browser(request(http).post(`/v1/discord/link-sessions/${result.body.id}/web-confirm`),portal,true).send({token,consent:{accepted:true,version:privacyNotice.version}}).expect(200);
 return result.body;
}
async function disconnectDiscord(owner,status=200){return browser(request(http).delete(`/v1/admin/members/${owner.id}/discord`),admin,true).expect(status);}
async function discordServers(){
 for(const rule of ['any','linked','unlinked']){
  await heartbeat('paper',[{id:`campus_${rule}`,label:`학교 ${rule}`}]);
  await settings(`campus_${rule}`,{enabled:true,accessMode:'university',discordRequirement:rule});
 }
}
const activityCounters={playSeconds:30,blocksBroken:2,blocksPlaced:1,damageTakenMilli:1000,deaths:0,mobKills:0,playerKills:0,distanceCm:20};
async function activityFor(identity,serverId,epoch=identity.telemetryEpoch){return(await service(request(http).post('/v1/minecraft/stats/batches')).send({id:randomUUID(),serverId,records:[{minecraftUuid:identity.uuid,epoch,...activityCounters}]}).expect(200)).body;}

test('Discord settings default to any, preserve old university edits and normalize other modes without changing immutable scopes',async()=>{
 const original=await db.serverRecord.findUnique({where:{id:'lobby'}});assert.equal(original.discordRequirement,'any');
 const legacy=await db.$queryRawUnsafe("INSERT INTO \"ServerRecord\" (\"id\",\"label\") VALUES ('legacy_discord','Legacy insert') RETURNING \"discordRequirement\",\"commandName\"");assert.deepEqual(legacy,[{discordRequirement:'any',commandName:'legacy_discord'}]);
 await publicServer();assert.equal((await db.serverRecord.findUnique({where:{id:'campus'}})).discordRequirement,'any');
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'SettingsEpoch',subjectId:admin.subject.id}});await policy(identity);
 let response=await settings('campus',{discordRequirement:'linked'});assert.equal(response.body.server.discordRequirement,'linked');
 const changed=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});assert.notEqual(changed.telemetryEpoch,identity.telemetryEpoch);assert.equal(await db.policyEvent.count({where:{minecraftUuid:identity.uuid}}),1);
 response=await settings('campus',{label:'새 표시명'});assert.equal(response.body.server.discordRequirement,'linked');
 assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}})).telemetryEpoch,changed.telemetryEpoch);
 await heartbeat('paper',[{id:'campus',label:'ignored'}]);await seedServerRegistry(db,[{id:'campus',label:'ignored'}]);
 assert.equal((await db.serverRecord.findUnique({where:{id:'campus'}})).discordRequirement,'linked');
 response=await settings('campus',{accessMode:'selected',allowedSubjectIds:[admin.subject.id],discordRequirement:'unlinked'});assert.equal(response.body.server.discordRequirement,'any');
 assert.deepEqual(response.body.server.allowedSubjectIds,[admin.subject.id]);assert.equal(response.body.server.id,'campus');
 response=await settings('campus',{accessMode:'university'});assert.equal(response.body.server.discordRequirement,'any');
 for(const discordRequirement of ['',null,'invalid',true])await settings('campus',{discordRequirement},400);
 await assert.rejects(db.serverRecord.update({where:{id:'campus'},data:{discordRequirement:'invalid'}}),/ServerRecord_discordRequirement_check/);
 const current=await db.serverRecord.findUnique({where:{id:'campus'}});
 const body={label:current.label,enabled:true,sensitive:false,accessMode:'university',discordRequirement:'linked',allowedSubjectIds:[],expectedUpdatedAt:current.updatedAt.toISOString()};
 await browser(request(http).put('/v1/admin/servers/campus')).send(body).expect(403);
 const outsider=await session(await subject(),PORTAL);await browser(request(http).put('/v1/admin/servers/campus'),outsider,true).send(body).expect(403);
 await browser(request(http).put('/v1/admin/servers/campus'),admin,true).send(body).expect(200);
 await browser(request(http).put('/v1/admin/servers/campus'),admin,true).send(body).expect(409);
 const audit=await db.auditEvent.findFirst({where:{action:'admin.server_updated',objectId:'campus'},orderBy:{createdAt:'desc'}});assert.equal(audit.details.after.discordRequirement,'linked');
});

test('actual Discord connection scopes policy, portal, admin eligibility, personal statistics, ingestion and presence equally',async()=>{
 await discordServers();
 const owner=await subject({membershipStatus:'inactive',verifiedUntil:new Date(0),discordId:'999999999999999999',discordUpdatedAt:new Date()}),portal=await session(owner,PORTAL);
 await db.consentReceipt.create({data:{subjectId:owner.id,version:privacyNotice.version,source:'portal_login',contextId:randomUUID(),acceptedAt:new Date()}});
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'DiscordMatrix',subjectId:owner.id}});
 async function check(expected){
  assert.deepEqual((await policy(identity)).allowedServerIds,expected);assert.deepEqual((await visibleServers(portal)).map(row=>row.id),expected);
  const member=(await browser(request(http).get('/v1/admin/members').query({ids:owner.id})).expect(200)).body.members[0];assert.deepEqual(member.eligibleServerIds,expected);
  for(const url of ['/v1/me/stats',`/v1/minecraft/players/${identity.uuid}/stats`]){
   const result=await (url.includes('/minecraft/')?service(request(http).get(url)):browser(request(http).get(url),portal)).expect(200);
   assert.deepEqual(result.body.servers.map(row=>row.serverId),expected);assert.equal(result.body.collection.effective,expected.length>0);
  }
  const fresh=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});
  for(const rule of ['any','linked','unlinked']){
   const serverId=`campus_${rule}`,allowed=expected.includes(serverId);
   assert.equal((await activityFor(fresh,serverId)).received,allowed?1:0);
   const presence=await service(request(http).post('/v1/minecraft/presence')).send({serverId,observedAt:new Date().toISOString(),players:[identity.uuid]}).expect(200);assert.equal(presence.body.received,allowed?1:0);
  }
 }
 await check(['campus_any','campus_unlinked']);
 await browser(request(http).put(`/v1/admin/members/${owner.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['campus_linked']}).expect(403);
 await connectDiscord(portal);await check(['campus_any','campus_linked']);
 await browser(request(http).put(`/v1/admin/members/${owner.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['campus_linked']}).expect(200);
 assert.deepEqual((await policy(identity)).allowedServerIds,['campus_linked']);
 await browser(request(http).put(`/v1/admin/members/${owner.id}/access`),admin,true).send({suspended:false,restricted:false,serverIds:[]}).expect(200);
 await disconnectDiscord(owner);await check(['campus_any','campus_unlinked']);
});

test('Discord link and unlink atomically publish policy invalidation and rotate epochs so old batches cannot regain authorization',async()=>{
 await discordServers();const owner=await subject({membershipStatus:'inactive',verifiedUntil:new Date(0)}),portal=await session(owner,PORTAL);
 await db.consentReceipt.create({data:{subjectId:owner.id,version:privacyNotice.version,source:'portal_login',contextId:randomUUID(),acceptedAt:new Date()}});
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'DiscordEpoch',subjectId:owner.id}});await policy(identity);
 for(const linked of [true,false,true]){
  const before=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}}),events=await db.policyEvent.count({where:{minecraftUuid:identity.uuid}});
  if(linked)await connectDiscord(portal);else await disconnectDiscord(owner);
  const after=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});assert.equal(after.policyVersion,before.policyVersion+1);assert.equal(after.policyFingerprint,'');assert.notEqual(after.telemetryEpoch,before.telemetryEpoch);
  assert.equal(await db.policyEvent.count({where:{minecraftUuid:identity.uuid}}),events+1);
  const event=await db.policyEvent.findFirst({where:{minecraftUuid:identity.uuid},orderBy:{id:'desc'}});assert.equal(event.policyVersion,after.policyVersion);
  const result=await policy(identity);assert.equal(result.policyVersion,after.policyVersion);assert.equal(result.telemetry.epoch,after.telemetryEpoch);
  assert.equal((await activityFor(after,'campus_any',before.telemetryEpoch)).received,0);assert.equal((await activityFor(after,'campus_any')).received,1);
 }
 const receipts=await db.consentReceipt.count({where:{subjectId:owner.id,source:'discord_link'}});assert.equal(receipts,2);
 await disconnectDiscord(owner);const before=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}}),events=await db.policyEvent.count({where:{minecraftUuid:identity.uuid}});
 await disconnectDiscord(owner);const after=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});assert.equal(after.policyVersion,before.policyVersion);assert.equal(after.telemetryEpoch,before.telemetryEpoch);assert.equal(await db.policyEvent.count({where:{minecraftUuid:identity.uuid}}),events);
});

test('two-sided Minecraft linking rechecks Discord scope at web and final game confirmation',async()=>{
 await publicServer();await settings('campus',{discordRequirement:'linked'});
 const owner=await subject({membershipStatus:'inactive',verifiedUntil:new Date(0)}),portal=await session(owner,PORTAL),link=await gameLink();
 assert.equal((await webLink(link,portal).expect(403)).body.code,'membership_required');
 await connectDiscord(portal);await webLink(link,portal).expect(200);await disconnectDiscord(owner);
 assert.equal((await confirmGame(link).expect(403)).body.code,'membership_required');
 assert.equal((await db.linkSession.findUnique({where:{id:link.id}})).gameConfirmedAt,null);assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:link.minecraftUuid}})).subjectId,null);
 await connectDiscord(portal);await confirmGame(link).expect(200);assert.deepEqual((await policy({uuid:link.minecraftUuid})).allowedServerIds,['campus']);
});

test('Discord linkage never bypasses school expiry, membership suspension or personal suspension',async()=>{
 await discordServers();const owner=await subject(),portal=await session(owner,PORTAL);await connectDiscord(portal);
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'DiscordExpiry',subjectId:owner.id}});
 assert.ok((await policy(identity)).allowedServerIds.includes('campus_linked'));
 for(const change of [{universityVerifiedUntil:new Date(0)},{membershipStatus:'suspended'},{accessSuspended:true}]){
  await db.subject.update({where:{id:owner.id},data:{universityVerifiedUntil:new Date(Date.now()+3600000),membershipStatus:'active',accessSuspended:false,...change}});
  assert.deepEqual((await policy(identity)).allowedServerIds,[]);assert.deepEqual(await visibleServers(portal),[]);
 }
 await db.subject.update({where:{id:owner.id},data:{accessSuspended:false,membershipStatus:'active',verifiedUntil:new Date(0)}});
 assert.deepEqual((await policy(identity)).allowedServerIds,['campus_any','campus_linked']);
});

test('selected school users can complete Minecraft linking without roster membership and retain a valid lease until school expiry',async()=>{
 const owner=await subject({membershipStatus:'inactive',verifiedUntil:new Date(0),roleLabel:'old role'}),portal=await session(owner,PORTAL);
 await settings('lobby',{accessMode:'selected',allowedSubjectIds:[owner.id]});
 const link=await gameLink();await webLink(link,portal).expect(200);await confirmGame(link).expect(200);
 let result=await policy({uuid:link.minecraftUuid});assert.equal(result.status,'active');assert.deepEqual(result.allowedServerIds,['lobby']);assert.equal(result.display.member,false);assert.equal(result.display.roleLabel,'');assert.ok(Date.parse(result.expiresAt)-Date.parse(result.issuedAt)>59000);
 assert.deepEqual((await visibleServers(portal)).map(row=>row.id),['lobby']);
 assert.deepEqual((await browser(request(http).get('/v1/admin/members').query({ids:owner.id})).expect(200)).body.members[0].eligibleServerIds,['lobby']);
 assert.deepEqual((await browser(request(http).get('/v1/me/stats'),portal).expect(200)).body.servers.map(row=>row.serverId),['lobby']);
 const notSelected=await session(await subject({membershipStatus:'inactive',verifiedUntil:new Date(0)}),PORTAL);assert.deepEqual(await visibleServers(notSelected),[]);
 await db.subject.update({where:{id:owner.id},data:{scopeRestricted:true,scopeLimit:[]}});assert.deepEqual((await policy({uuid:link.minecraftUuid})).allowedServerIds,[]);
 await db.subject.update({where:{id:owner.id},data:{scopeRestricted:false,universityVerifiedUntil:new Date(Date.now()+15000)}});
 result=await policy({uuid:link.minecraftUuid});assert.ok(Date.parse(result.expiresAt)-Date.parse(result.issuedAt)<=15000);assert.ok(Date.parse(result.expiresAt)>Date.parse(result.issuedAt));
 for(const change of [{accessSuspended:true},{accessSuspended:false,membershipStatus:'suspended'},{membershipStatus:'inactive',universityVerifiedUntil:new Date(0)}]){
  await db.subject.update({where:{id:owner.id},data:change});assert.deepEqual((await policy({uuid:link.minecraftUuid})).allowedServerIds,[]);assert.deepEqual(await visibleServers(portal),[]);
 }
});

test('members admission ignores empty or obsolete roster scopes consistently across policy, portal, admin, statistics and collection',async()=>{
 const owner=await subject({allowedServerIds:[]}),portal=await session(owner,PORTAL);
 const link=await gameLink();await webLink(link,portal).expect(200);await confirmGame(link).expect(200);
 const identity=await db.minecraftIdentity.findUnique({where:{uuid:link.minecraftUuid}});
 for(const allowedServerIds of [[],['removed_legacy_server'],['lobby']]){
  await db.subject.update({where:{id:owner.id},data:{allowedServerIds}});
  assert.deepEqual((await policy(identity)).allowedServerIds,['lobby','survival']);assert.deepEqual((await visibleServers(portal)).map(row=>row.id),['lobby','survival']);
  const member=(await browser(request(http).get('/v1/admin/members').query({ids:owner.id})).expect(200)).body.members[0];assert.deepEqual(member.eligibleServerIds,['lobby','survival']);
  for(const serverId of ['lobby','survival']){assert.equal((await activityFor(identity,serverId)).received,1);assert.equal((await service(request(http).post('/v1/minecraft/presence')).send({serverId,observedAt:new Date().toISOString(),players:[identity.uuid]}).expect(200)).body.received,1);}
  for(const url of ['/v1/me/stats',`/v1/minecraft/players/${identity.uuid}/stats`])assert.deepEqual((await (url.includes('/minecraft/')?service(request(http).get(url)):browser(request(http).get(url),portal)).expect(200)).body.servers.map(row=>row.serverId),['lobby','survival']);
 }
 await browser(request(http).put(`/v1/admin/members/${owner.id}/access`),admin,true).send({suspended:false,restricted:true,serverIds:['survival']}).expect(200);
 assert.deepEqual((await policy(identity)).allowedServerIds,['survival']);assert.equal((await activityFor(identity,'lobby')).received,0);
 await db.subject.update({where:{id:owner.id},data:{verifiedUntil:new Date(0)}});assert.deepEqual((await policy(identity)).allowedServerIds,[]);assert.equal((await activityFor(identity,'survival')).received,0);
});

test('retired roster settings are rejected while membership sync still grants and revokes members independently of legacy server lists',async()=>{
 const before=await db.serverRecord.findUnique({where:{id:'lobby'}});assert.equal((await settings('lobby',{accessMode:'roster'},400)).body.code,'invalid_request');
 assert.deepEqual(await db.serverRecord.findUnique({where:{id:'lobby'}}),before);
 const {applyRosterSnapshot}=require('../dist/membership-sync'),{studentKey}=require('../dist/integrations/sheets');
 const key=studentKey('99990123',process.env.ROSTER_MATCHING_SECRET),owner=await subject({universityKey:key,membershipStatus:'inactive',allowedServerIds:[],verifiedUntil:new Date(0)}),portal=await session(owner,PORTAL);
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'MembersSync',subjectId:owner.id}});assert.deepEqual((await policy(identity)).allowedServerIds,[]);
 const now=new Date();await applyRosterSnapshot(db,{entries:[{studentKey:key,status:'active',roleLabel:'회원',serverIds:[]}],sourceKey:'a'.repeat(64),fetchedAt:now},{allowedServerIds:['lobby','survival']});
 assert.deepEqual((await db.subject.findUnique({where:{id:owner.id}})).allowedServerIds,[]);assert.deepEqual((await policy(identity)).allowedServerIds,['lobby','survival']);assert.deepEqual((await visibleServers(portal)).map(row=>row.id),['lobby','survival']);
 const next={entries:[{studentKey:key,status:'inactive',roleLabel:'',serverIds:[]}],sourceKey:'a'.repeat(64),fetchedAt:new Date(now.getTime()+1)};
 const {rosterDigest}=require('../dist/membership-sync');await applyRosterSnapshot(db,next,{allowedServerIds:['lobby','survival'],expectedApprovalDigest:rosterDigest(next)});
 assert.deepEqual((await policy(identity)).allowedServerIds,[]);assert.deepEqual(await visibleServers(portal),[]);
});

function statementsFromMigration(file){
 const sql=require('node:fs').readFileSync(file,'utf8').replace(/^--.*$/gm,'');let dollarQuoted=false,statement='';const statements=[];
 for(const token of sql.split(/(\$\$|;)/)){if(token==='$$')dollarQuoted=!dollarQuoted;if(token===';'&&!dollarQuoted){statements.push(statement.trim());statement='';}else statement+=token;}
 if(statement.trim())statements.push(statement.trim());return statements.filter(value=>value&&!['BEGIN','COMMIT'].includes(value));
}
test('members migration preserves selected settings, subject overrides, telemetry and history while atomically revising changed servers and policies',async()=>{
 const statements=statementsFromMigration('prisma/migrations/20261003020000_members_server_access/migration.sql');
 assert.equal(statements[0],'SELECT pg_advisory_xact_lock(1346458451, 1347374153)');
 for(const hasLegacy of [true,false]){
  const schema='members_migration_'+randomUUID().replaceAll('-',''),owner=randomUUID(),uuid=randomUUID(),unlinked=randomUUID(),epoch=randomUUID();
  await db.$transaction(async tx=>{
   await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
   await tx.$executeRawUnsafe('CREATE TABLE "ServerRecord" (LIKE "registry_test"."ServerRecord" INCLUDING ALL)');
   await tx.$executeRawUnsafe('ALTER TABLE "ServerRecord" DROP CONSTRAINT "ServerRecord_accessMode_check"');
   await tx.$executeRawUnsafe('ALTER TABLE "ServerRecord" ADD CONSTRAINT "ServerRecord_accessMode_check" CHECK ("accessMode" IN (\'roster\',\'members\',\'selected\',\'university\'))');
   await tx.$executeRawUnsafe('ALTER TABLE "ServerRecord" ALTER COLUMN "accessMode" SET DEFAULT \'roster\'');
   await tx.$executeRawUnsafe('CREATE TABLE "MinecraftIdentity" ("uuid" UUID PRIMARY KEY,"subjectId" UUID,"policyVersion" INTEGER NOT NULL,"policyFingerprint" TEXT NOT NULL,"telemetryEpoch" UUID NOT NULL,"updatedAt" TIMESTAMP(3) NOT NULL)');
   await tx.$executeRawUnsafe('CREATE TABLE "PolicyEvent" ("id" BIGSERIAL PRIMARY KEY,"minecraftUuid" UUID NOT NULL,"policyVersion" INTEGER NOT NULL,"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP)');
   await tx.$executeRawUnsafe('CREATE TABLE "Subject" ("id" UUID PRIMARY KEY,"scopeRestricted" BOOLEAN NOT NULL,"scopeLimit" TEXT[] NOT NULL,"accessSuspended" BOOLEAN NOT NULL,"allowedServerIds" TEXT[] NOT NULL)');
   await tx.$executeRawUnsafe('CREATE TABLE "ActivityTotal" ("serverId" TEXT NOT NULL,"epoch" UUID NOT NULL,"playSeconds" BIGINT NOT NULL)');
   for(const [id,mode] of [['club',hasLegacy?'roster':'members'],['chosen','selected'],['campus','university']])await tx.$executeRawUnsafe('INSERT INTO "ServerRecord" ("id","commandName","label","enabled","statisticsEnabled","accessMode","discordRequirement","allowedSubjectIds","updatedAt") VALUES ($1,$1,$1,true,false,$2,$3,ARRAY[$4::UUID],\'2026-01-01\')',id,mode,mode==='university'?'linked':'any',owner);
   await tx.$executeRawUnsafe('INSERT INTO "MinecraftIdentity" VALUES ($1::UUID,$2::UUID,7,\'fingerprint\',$3::UUID,\'2026-01-01\'),($4::UUID,NULL,3,\'unlinked\',$3::UUID,\'2026-01-01\')',uuid,owner,epoch,unlinked);
   await tx.$executeRawUnsafe('INSERT INTO "Subject" VALUES ($1::UUID,true,ARRAY[\'club\'],true,ARRAY[]::TEXT[])',owner);
   await tx.$executeRawUnsafe('INSERT INTO "ActivityTotal" VALUES (\'club\',$1::UUID,123)',epoch);
   // Qualify each fixture schema so prepared reads cannot inherit another fixture table shape.
   const before=await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."ServerRecord" ORDER BY "id"`),subjectBefore=await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."Subject"`),historyBefore=await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."ActivityTotal"`);
   for(const statement of statements)await tx.$executeRawUnsafe(statement);
   const rows=await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."ServerRecord" ORDER BY "id"`);
   for(let i=0;i<rows.length;i++){const {accessMode,updatedAt,...same}=rows[i],{accessMode:oldMode,updatedAt:oldRevision,...original}=before[i];assert.deepEqual(same,original);assert.equal(accessMode,oldMode==='roster'?'members':oldMode);if(oldMode==='roster')assert.ok(updatedAt>oldRevision);else assert.deepEqual(updatedAt,oldRevision);}
   const identities=await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."MinecraftIdentity"`),linked=identities.find(row=>row.uuid===uuid),anonymous=identities.find(row=>row.uuid===unlinked);
   assert.equal(linked.policyVersion,hasLegacy?8:7);assert.equal(linked.policyFingerprint,hasLegacy?'':'fingerprint');assert.equal(linked.telemetryEpoch,epoch);assert.equal(anonymous.policyVersion,3);assert.equal(anonymous.telemetryEpoch,epoch);
   const events=await tx.$queryRawUnsafe(`SELECT "minecraftUuid","policyVersion" FROM "${schema}"."PolicyEvent"`);assert.deepEqual(events,hasLegacy?[{minecraftUuid:uuid,policyVersion:8}]:[]);
   assert.deepEqual(await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."Subject"`),subjectBefore);assert.deepEqual(await tx.$queryRawUnsafe(`SELECT * FROM "${schema}"."ActivityTotal"`),historyBefore);
   await tx.$executeRawUnsafe('INSERT INTO "ServerRecord" ("id","commandName","label","accessMode") VALUES (\'old_insert\',\'old_insert\',\'Old API\',\'roster\')');
   await tx.$executeRawUnsafe('INSERT INTO "ServerRecord" ("id","commandName","label") VALUES (\'default_insert\',\'default_insert\',\'Default\')');
   await tx.$executeRawUnsafe('UPDATE "ServerRecord" SET "accessMode"=\'roster\' WHERE "id"=\'old_insert\'');
   assert.deepEqual((await tx.$queryRawUnsafe(`SELECT "accessMode" FROM "${schema}"."ServerRecord" WHERE "id" IN ('old_insert','default_insert')`)).map(row=>row.accessMode),['members','members']);
   const constraint=(await tx.$queryRawUnsafe('SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname=\'ServerRecord_accessMode_check\'',`"${schema}"."ServerRecord"`))[0].definition;assert.ok(!constraint.includes('roster'));assert.ok(constraint.includes('members'));
   await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  },{timeout:30000});
 }
});
