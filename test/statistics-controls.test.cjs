const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
const raw=process.env.TEST_DATABASE_URL;
if(!raw||!new URL(raw).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
const url=new URL(raw);url.searchParams.set('schema','statistics_controls_test');
Object.assign(process.env,{DATABASE_URL:url.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',API_SERVICE_TOKEN:'expansion-service-'.repeat(4),PASSPORT_DISCORD_SERVICE_TOKEN:'expansion-discord-'.repeat(4),DISCORD_GUILD_ID:'100000000000000001',DISCORD_MEMBER_ROLE_ID:'100000000000000002',SESSION_SECRET:'expansion-session-'.repeat(4),ROSTER_MATCHING_SECRET:'expansion-roster-'.repeat(4),DATA_ENCRYPTION_KEY:'ab'.repeat(32),ADMIN_MFA_REQUIRED:'false',SHEETS_SYNC_ENABLED:'false'});
const {createApp}=require('../dist/app'),{PassportService}=require('../dist/passport.service');
const {hash,csrf}=require('../dist/security'),{privacyNotice}=require('../dist/privacy');
const {studentKey}=require('../dist/integrations/sheets');
const {accountRevision,eraseSubject,purgeRevokedDeletedAccounts}=require('../dist/members');
const {projectDiscordIdentity,managementConsent}=require('../dist/discord-policy');
const {policyTransaction}=require('../dist/database');
let app,p,db,http,admin;
const service=r=>r.set('Authorization',`Bearer ${p.config.serviceToken}`);
function browser(r,user=admin,mutation=false){r=r.set('Host',user.host).set('Cookie',user.cookie);return mutation?r.set('Origin',`https://${user.host}`).set('X-CSRF-Token',user.csrf):r;}
async function subject(changes={}){return db.subject.create({data:{universityKey:randomUUID(),displayName:'검증회원',identityProvider:'usaint',universityVerifiedUntil:new Date(Date.now()+3600000),membershipStatus:'active',verifiedUntil:new Date(Date.now()+900000),allowedServerIds:['lobby'],...changes}});}
async function session(subject,host='portal.example.test'){const token=randomBytes(32).toString('base64url');await db.webSession.create({data:{subjectId:subject.id,tokenHash:hash(token),audienceHost:host,expiresAt:new Date(Date.now()+3600000)}});return{subject,host,cookie:`__Host-passport_${host.startsWith('admin')?'admin':'portal'}_session=${token}`,csrf:csrf(p.config.sessionSecret,token)};}
async function consent(id,version=privacyNotice.version){await db.consentReceipt.create({data:{subjectId:id,version,source:'portal_login',contextId:randomUUID(),acceptedAt:new Date()}});}
async function linked(changes={}){const owner=await subject(changes);await consent(owner.id);const minecraft=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'SyntheticIGN',subjectId:owner.id}});return{owner,minecraft,portal:await session(owner)};}
async function revision(id){return accountRevision(await db.subject.findUnique({where:{id},include:{minecraft:true,administrator:true,discordIdentity:true}}));}
async function remove(owner,changes={},user=admin,status=200){return browser(request(http).delete(`/v1/admin/members/${owner.id}`),user,true).send({expectedRevision:await revision(owner.id),confirmation:owner.displayName,...changes}).expect(status);}
const count={playSeconds:60,blocksBroken:8,blocksPlaced:3,damageTakenMilli:4500,deaths:1,mobKills:2,playerKills:0,distanceCm:0};
function batch(minecraft,changes={}){return{id:randomUUID(),serverId:'lobby',records:[{minecraftUuid:minecraft.uuid,epoch:minecraft.telemetryEpoch,...count}],...changes};}
function submit(input,status=200){return service(request(http).post('/v1/minecraft/stats/batches')).send(input).expect(status);}
function policy(uuid){return service(request(http).get(`/v1/minecraft/policies/${uuid}`)).expect(200);}
beforeEach(async()=>{
 app=await createApp();p=app.get(PassportService);db=p.db;http=app.getHttpServer();
 await db.serverRecord.updateMany({data:{statisticsEnabled:true}});
 await db.serverRecord.deleteMany({where:{id:{notIn:['lobby','survival']}}});
 await db.$executeRawUnsafe('TRUNCATE TABLE "Subject", "MinecraftIdentity", "DiscordIdentity", "DiscordLinkSession", "AuditEvent", "RosterMembership", "RosterSnapshot", "PolicyEvent", "PlayerPresence", "ActivityBatch" RESTART IDENTITY CASCADE');
 const actor=await subject({displayName:'관리자검증'});await db.administrator.create({data:{subjectId:actor.id,enabled:true,role:'owner',totpSecret:''}});admin=await session(actor,'admin.example.test');
});
afterEach(async()=>{await app.close();});

async function settings(user){return (await browser(request(http).get('/v1/me/statistics-settings'),user).expect(200)).body;}
async function setCollection(user,enabled,changes={},status=200){return browser(request(http).put('/v1/me/statistics-settings'),user,true).send({enabled,expectedRevision:(await settings(user)).revision,...changes}).expect(status);}
async function serverCollection(id,enabled,user=admin,status=200){const s=await db.serverRecord.findUnique({where:{id}});return browser(request(http).put(`/v1/admin/servers/${id}`),user,true).send({label:s.label,sensitive:s.sensitive,enabled:s.enabled,accessMode:s.accessMode,allowedSubjectIds:s.allowedSubjectIds,expectedUpdatedAt:s.updatedAt.toISOString(),statisticsEnabled:enabled}).expect(status);}
async function preview(scope,user=admin,status=200){return browser(request(http).post('/v1/admin/stats/reset/preview'),user,true).send(scope).expect(status);}
async function reset(scope,pre,user=admin,status=200,changes={}){return browser(request(http).post('/v1/admin/stats/reset'),user,true).send({...scope,expectedRevision:pre.expectedRevision,confirmation:pre.confirmation,...changes}).expect(status);}
async function own(a){return(await browser(request(http).get('/v1/me/stats'),a.portal).expect(200)).body;}
async function roleSession(role){const owner=await subject();await db.administrator.create({data:{subjectId:owner.id,enabled:true,role,totpSecret:''}});return session(owner,'admin.example.test');}

test('own collection toggle uses CSRF/current revision and never bypasses missing consent',async()=>{
 const a=await linked(),initial=await settings(a.portal);assert.deepEqual(initial,{enabled:true,revision:initial.revision,consentGranted:true});
 await browser(request(http).put('/v1/me/statistics-settings'),a.portal).send({enabled:false,expectedRevision:initial.revision}).expect(403);
 const off=(await setCollection(a.portal,false)).body;assert.equal(off.enabled,false);assert.notEqual(off.revision,initial.revision);
 assert.equal((await setCollection(a.portal,true,{expectedRevision:initial.revision},409)).body.code,'statistics_settings_changed');
 await db.consentReceipt.deleteMany({where:{subjectId:a.owner.id}});await setCollection(a.portal,true);
 assert.equal((await settings(a.portal)).consentGranted,false);assert.equal((await policy(a.minecraft.uuid)).body.telemetry.enabled,false);
 await browser(request(http).post('/v1/me/stats/reset'),a.portal,true).send({}).expect(404);
});
test('own off/on preserves history and presence/name while fencing all old/offline epochs',async()=>{
 const a=await linked();await submit(batch(a.minecraft));const before=(await policy(a.minecraft.uuid)).body;
 await setCollection(a.portal,false);let pol=(await policy(a.minecraft.uuid)).body;
 assert.equal(pol.telemetry.enabled,false);assert.equal(pol.telemetry.presenceEnabled,true);assert.equal(pol.display.displayName,before.display.displayName);assert.equal(pol.telemetry.epoch,null);assert.deepEqual(pol.telemetry.serverIds,[]);
 const during=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});assert.notEqual(during.telemetryEpoch,a.minecraft.telemetryEpoch);
 assert.equal((await submit(batch(a.minecraft))).body.ignored,1);assert.equal((await submit(batch(during))).body.ignored,1);
 assert.equal((await own(a)).totals.playSeconds,60);assert.equal((await own(a)).collection.effective,false);
 await service(request(http).post('/v1/minecraft/presence')).send({serverId:'lobby',observedAt:new Date().toISOString(),players:[a.minecraft.uuid]}).expect(200);assert.equal((await own(a)).presence.online,true);
 await setCollection(a.portal,true);const newer=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});
 assert.notEqual(newer.telemetryEpoch,during.telemetryEpoch);for(const identity of[a.minecraft,during])assert.equal((await submit(batch(identity))).body.ignored,1);
 assert.equal((await submit(batch(newer))).body.received,1);assert.equal((await own(a)).totals.playSeconds,120);
});
test('server collection toggle excludes preserved history/totals and policy serverIds without changing admission',async()=>{
 const a=await linked({allowedServerIds:['lobby','survival']});await submit(batch(a.minecraft));await submit(batch(a.minecraft,{serverId:'survival'}));
 await serverCollection('lobby',false);let stats=await own(a);assert.equal(stats.totals.playSeconds,60);assert.deepEqual(stats.collection.excludedServerIds,['lobby']);assert.equal(stats.servers.find(s=>s.serverId==='lobby').collectionEnabled,false);assert.equal(stats.servers.find(s=>s.serverId==='lobby').playSeconds,0);assert.equal(await db.activityTotal.count(),2);
 const pol=(await policy(a.minecraft.uuid)).body;assert.deepEqual(pol.allowedServerIds,['lobby','survival']);assert.deepEqual(pol.telemetry.serverIds,['survival']);assert.equal(pol.telemetry.presenceEnabled,true);
 const off=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});assert.equal((await submit(batch(off))).body.ignored,1);assert.equal((await submit(batch(a.minecraft,{serverId:'survival'}))).body.ignored,1);
 await serverCollection('lobby',true);assert.equal((await own(a)).totals.playSeconds,120);assert.equal((await submit(batch(off))).body.ignored,1);
});
test('production lobby is off when discovered and heartbeat never overwrites configured collection',async()=>{
 const body={source:'paper',servers:[{id:'ssu_lobby',label:'운영 로비'}]};await service(request(http).post('/v1/minecraft/servers/heartbeat')).send(body).expect(200);
 assert.equal((await db.serverRecord.findUnique({where:{id:'ssu_lobby'}})).statisticsEnabled,false);
 await serverCollection('ssu_lobby',true);await service(request(http).post('/v1/minecraft/servers/heartbeat')).send(body).expect(200);assert.equal((await db.serverRecord.findUnique({where:{id:'ssu_lobby'}})).statisticsEnabled,true);
});
test('totals never include currently inaccessible or excluded server history and global player count uses included rows',async()=>{
 const a=await linked();await submit(batch(a.minecraft));await db.subject.update({where:{id:a.owner.id},data:{scopeRestricted:true,scopeLimit:[]}});const hidden=await own(a);assert.equal(hidden.totals.playSeconds,0);assert.equal(hidden.servers.length,0);assert.deepEqual(hidden.collection.excludedServerIds,[]);
 await serverCollection('lobby',false);const all=(await browser(request(http).get('/v1/admin/stats')).expect(200)).body;assert.equal(all.playerCount,0);assert.equal(all.totals.playSeconds,0);assert.equal(await db.activityTotal.count(),1);
});
test('reset preview requires admin write/CSRF and protects administrator subjects from operators',async()=>{
 const a=await linked(),scope={scope:'subject',subjectId:a.owner.id};await submit(batch(a.minecraft));
 await browser(request(http).post('/v1/admin/stats/reset/preview')).send(scope).expect(403);
 await preview(scope,await roleSession('viewer'),403);await preview(scope,a.portal,403);
 const operator=await roleSession('operator');const pre=(await preview(scope,operator)).body;await reset(scope,pre,operator);
 await db.administrator.create({data:{subjectId:a.owner.id,role:'viewer',enabled:true,totpSecret:''}});await preview(scope,operator,403);
 await preview(scope,admin);assert.equal((await preview({scope:'subject',subjectId:randomUUID()},admin,404)).body.code,'subject_not_found');await preview({scope:'all',subjectId:a.owner.id},admin,400);
});
test('subject reset deletes all eight counters only for selected subject and fences duplicate/unknown old batches',async()=>{
 const a=await linked(),b=await linked(),input=batch(a.minecraft,{records:[{minecraftUuid:a.minecraft.uuid,epoch:a.minecraft.telemetryEpoch,...count,playerKills:7,distanceCm:999}]});await submit(input);await submit(batch(b.minecraft));
 const scope={scope:'subject',subjectId:a.owner.id},pre=(await preview(scope)).body;assert.equal(pre.totals.playerKills,7);assert.equal(pre.totals.distanceCm,999);assert.equal(pre.affectedSubjects,1);
 await reset(scope,pre,admin,400,{confirmation:'잘못된 확인'});await reset(scope,pre);await reset(scope,pre,admin,409);
 assert.equal((await own(a)).totals.playSeconds,0);assert.equal((await own(b)).totals.playSeconds,60);
 assert.equal((await submit(input)).body.duplicate,true);assert.equal((await submit({...input,id:randomUUID()})).body.ignored,1);assert.equal((await own(a)).totals.playerKills,0);
 const audit=await db.auditEvent.findFirst({where:{action:'admin.statistics_reset'}});assert.equal(audit.subjectId,a.owner.id);assert.equal(audit.details.totals.distanceCm,999);assert.ok(!JSON.stringify(audit).includes(a.owner.displayName));
});
test('reset preview accepts incrementing counters but rejects new target generations or changed epochs',async()=>{
 const a=await linked();await submit(batch(a.minecraft));const scope={scope:'subject',subjectId:a.owner.id},pre=(await preview(scope)).body;
 await submit(batch(a.minecraft));await reset(scope,pre);assert.equal((await own(a)).totals.playSeconds,0);
 const current=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});await submit(batch(current));const stale=(await preview(scope)).body;await setCollection(a.portal,false);await reset(scope,stale,admin,409);
 const all=(await preview({scope:'all'})).body;const b=await linked();await submit(batch(b.minecraft));await reset({scope:'all'},all,admin,409);
});
test('server reset preserves other server confirmed totals and blocks never-before-uploaded offline batches',async()=>{
 const a=await linked({allowedServerIds:['lobby','survival']}),b=await linked();await submit(batch(a.minecraft));await submit(batch(a.minecraft,{serverId:'survival'}));const offline=batch(b.minecraft);
 const scope={scope:'server',serverId:'lobby'},pre=(await preview(scope)).body;await reset(scope,pre);assert.equal((await own(a)).totals.playSeconds,60);assert.equal((await submit(offline)).body.ignored,1);
 const fresh=await db.minecraftIdentity.findUnique({where:{uuid:b.minecraft.uuid}});assert.equal((await submit(batch(fresh))).body.received,1);
});
test('concurrent reset versus old batch serializes so cleared totals cannot be restored',async()=>{
 const a=await linked();await submit(batch(a.minecraft));const scope={scope:'subject',subjectId:a.owner.id},pre=(await preview(scope)).body;
 await Promise.all([reset(scope,pre),submit(batch(a.minecraft))]);assert.equal((await own(a)).totals.playSeconds,0);
 const all=(await preview({scope:'all'})).body;await reset({scope:'all'},all);const after=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});assert.notEqual(after.telemetryEpoch,a.minecraft.telemetryEpoch);
});
test('all reset includes excluded historical rows, keeps collection preferences and preserves account data',async()=>{
 const a=await linked();await submit(batch(a.minecraft));await serverCollection('lobby',false);await setCollection(a.portal,false);
 const scope={scope:'all'},pre=(await preview(scope)).body;assert.equal(pre.totals.playSeconds,60);await reset(scope,pre);assert.equal(await db.activityTotal.count(),0);assert.ok(await db.subject.findUnique({where:{id:a.owner.id}}));assert.equal((await settings(a.portal)).enabled,false);assert.equal((await db.serverRecord.findUnique({where:{id:'lobby'}})).statisticsEnabled,false);
});
test('concurrent user toggles use optimistic revision and generate one durable policy change',async()=>{
 const a=await linked(),initial=await settings(a.portal),events=await db.policyEvent.count();
 const submitToggle=()=>browser(request(http).put('/v1/me/statistics-settings'),a.portal,true).send({enabled:false,expectedRevision:initial.revision});
 const responses=await Promise.all([submitToggle(),submitToggle()]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal(await db.policyEvent.count(),events+1);assert.equal(await db.auditEvent.count({where:{action:'subject.statistics_collection_updated'}}),1);
});
