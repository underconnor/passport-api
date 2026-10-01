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
 await db.administrator.create({data:{subjectId:actor.id,enabled:true,totpSecret:''}});
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
