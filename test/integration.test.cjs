const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const request=require('supertest');
if(!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; use a dedicated database whose name ends in _test');
const database=new URL(process.env.TEST_DATABASE_URL);
if(!database.pathname.endsWith('_test')) throw new Error('Refusing to reset a database not ending in _test');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
Object.assign(process.env,{NODE_ENV:'test',PASSPORT_AUTH_MODE:'development',WEB_ORIGIN:'http://localhost:5173',ADMIN_ORIGIN:'http://localhost:5174',API_SERVICE_TOKEN:'service-test-'.repeat(4),SESSION_SECRET:'session-test-'.repeat(4)});
const {createApp}=require('../dist/app');
const {PassportService}=require('../dist/passport.service');
const {seedDevelopment}=require('../dist/seed-development');
const {privacyNotice}=require('../dist/privacy');
const skinModule=require('../dist/integrations/minecraft-skin');
const consent={accepted:true,version:privacyNotice.version};
let app,db,http;
const service=r=>r.set('Authorization',`Bearer ${process.env.API_SERVICE_TOKEN}`);
const host=r=>r.set('Host','localhost:5173');
let linkCounter=0;
async function login(identity='member') {
 const session=await host(request(http).get('/v1/auth/session')).expect(200);
 let cookie=session.headers['set-cookie'][0].split(';')[0], csrf=session.body.csrfToken;
 const logged=await host(request(http).post('/v1/auth/development')).set('Origin','http://localhost:5173').set('Cookie',cookie).set('X-CSRF-Token',csrf).send({identity}).expect(200);
 return {cookie:logged.headers['set-cookie'][0].split(';')[0],csrf:logged.body.csrfToken,profile:logged.body};
}
function browser(r,user){return host(r).set('Origin','http://localhost:5173').set('Cookie',user.cookie).set('X-CSRF-Token',user.csrf);}
async function createLink(uuid=randomUUID()) {
 const identity={minecraftUuid:uuid,minecraftName:`Test${++linkCounter}`,gameSessionId:randomUUID()};
 const created=await service(request(http).post('/v1/link-sessions')).send(identity).expect(201);
 return {...created.body,identity,token:new URLSearchParams(new URL(created.body.url).hash.slice(1)).get('token')};
}
async function webConfirm(link,user,status=200){return browser(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`),user).send({token:link.token,consent}).expect(status);}
async function gameConfirm(link,status=200,body=link.identity){const {minecraftUuid,gameSessionId}=body;return service(request(http).post(`/v1/link-sessions/${link.id}/game-confirm`)).send({minecraftUuid,gameSessionId}).expect(status);}
async function gameInspect(link,status=200,body=link.identity){const {minecraftUuid,gameSessionId}=body;return service(request(http).post(`/v1/link-sessions/${link.id}/game-inspect`)).send({minecraftUuid,gameSessionId}).expect(status);}
async function getPolicy(uuid){return (await service(request(http).get(`/v1/minecraft/policies/${uuid}`)).expect(200)).body;}
afterEach(async()=>{await app?.close();});
beforeEach(async()=>{
 // Each test owns its limiter state; production limits remain fully enabled.
 app=await createApp();db=app.get(PassportService).db;http=app.getHttpServer();
 await db.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent", "PolicyEvent", "LinkSession", "WebSession", "MinecraftIdentity", "Subject" RESTART IDENTITY CASCADE');await seedDevelopment(db);
});
test('service endpoints reject missing or bad credentials and unknown UUID fails closed',async()=>{
 const uuid=randomUUID();await request(http).get(`/v1/minecraft/policies/${uuid}`).expect(401);
 await request(http).get(`/v1/minecraft/policies/${uuid}`).set('Authorization','Bearer wrong').expect(401);
 const policy=await getPolicy(uuid);assert.equal(policy.status,'unlinked');assert.deepEqual(policy.allowedServerIds,[]);assert.equal(policy.subjectId,null);assert.equal(Date.parse(policy.expiresAt)-Date.parse(policy.issuedAt),60000);
});
test('login rotates host-only HttpOnly sessions; cross-origin, wrong host and old session are rejected',async()=>{
 const anon=await host(request(http).get('/v1/auth/session')).expect(200);const oldCookie=anon.headers['set-cookie'][0].split(';')[0];
 assert.match(anon.headers['set-cookie'][0],/HttpOnly/);assert.doesNotMatch(anon.headers['set-cookie'][0],/Domain=/);
 await host(request(http).post('/v1/auth/development')).set('Origin','https://attacker.example').set('Cookie',oldCookie).set('X-CSRF-Token',anon.body.csrfToken).send({identity:'member'}).expect(403);
 const logged=await host(request(http).post('/v1/auth/development')).set('Origin','http://localhost:5173').set('Cookie',oldCookie).set('X-CSRF-Token',anon.body.csrfToken).send({identity:'member'}).expect(200);
 assert.notEqual(oldCookie,logged.headers['set-cookie'][0].split(';')[0]);
 await host(request(http).get('/v1/me')).set('Cookie',oldCookie).expect(401);
 await request(http).get('/v1/me').set('Host','localhost:5174').set('Cookie',logged.headers['set-cookie'][0].split(';')[0]).expect(401);
});
test('web confirmation alone does not grant access; correct game session completes once',async()=>{
 const user=await login();const link=await createLink();await webConfirm(link,user);
 assert.equal((await getPolicy(link.identity.minecraftUuid)).status,'unlinked');
 await gameConfirm(link,403,{...link.identity,gameSessionId:randomUUID()});
 const complete=await gameConfirm(link);assert.equal(complete.body.status,'linked');
 const policy=await getPolicy(link.identity.minecraftUuid);assert.equal(policy.status,'active');assert.deepEqual(policy.allowedServerIds,['lobby','survival']);assert.ok(policy.policyVersion>=2);
 await gameConfirm(link,409);await webConfirm(link,user,409);
 assert.equal(await db.auditEvent.count({where:{action:'minecraft.linked'}}),1);
});
test('game confirmation before web confirmation also requires both',async()=>{
 const user=await login();const link=await createLink();assert.equal((await gameConfirm(link)).body.status,'pending');
 assert.equal((await getPolicy(link.identity.minecraftUuid)).status,'unlinked');assert.equal((await webConfirm(link,user)).body.status,'linked');
});
test('game inspection requires service identity and the exact game session, and never exposes web capabilities',async()=>{
 const link=await createLink();const {minecraftUuid,gameSessionId}=link.identity;
 await request(http).post(`/v1/link-sessions/${link.id}/game-inspect`).send({minecraftUuid,gameSessionId}).expect(401);
 await gameInspect(link,403,{...link.identity,gameSessionId:randomUUID()});
 await gameInspect(link,403,{...link.identity,minecraftUuid:randomUUID()});
 await gameInspect({...link,id:randomUUID()},404);
 const before={links:await db.linkSession.findMany(),audits:await db.auditEvent.count(),events:await db.policyEvent.count()};
 const inspected=await gameInspect(link);
 assert.deepEqual(inspected.body,{id:link.id,status:'pending',expiresAt:link.expiresAt,webConfirmed:false,gameConfirmed:false});
 assert.match(inspected.headers['cache-control'],/no-store/);
 assert.deepEqual(await db.linkSession.findMany(),before.links);
 assert.equal(await db.auditEvent.count(),before.audits);assert.equal(await db.policyEvent.count(),before.events);
});
test('game polling observes web confirmation and completed links while confirmation retries stay consumed',async()=>{
 const user=await login();const link=await createLink();
 assert.equal((await gameInspect(link)).body.webConfirmed,false);
 await webConfirm(link,user);
 assert.deepEqual((await gameInspect(link)).body,{id:link.id,status:'pending',expiresAt:link.expiresAt,webConfirmed:true,gameConfirmed:false});
 await gameConfirm(link);await gameConfirm(link,409);
 const complete=await gameInspect(link);assert.equal(complete.body.status,'linked');assert.equal(complete.body.gameConfirmed,true);
 assert.equal(await db.auditEvent.count({where:{action:'minecraft.linked'}}),1);
 assert.equal(await db.policyEvent.count({where:{minecraftUuid:link.identity.minecraftUuid}}),1);
 await gameInspect(link,403,{...link.identity,gameSessionId:randomUUID()});
 await db.minecraftIdentity.update({where:{uuid:link.identity.minecraftUuid},data:{subjectId:null}});
 await gameInspect(link,409);
});
test('game inspection rejects expired and cancelled requests, including already completed expired links',async()=>{
 const user=await login();const link=await createLink();await gameConfirm(link);
 assert.equal((await gameInspect(link)).body.gameConfirmed,true);
 await webConfirm(link,user);assert.equal((await gameInspect(link)).body.status,'linked');
 await db.linkSession.update({where:{id:link.id},data:{expiresAt:new Date(Date.now()-1000)}});
 await gameInspect(link,410);
 const pending=await createLink();await db.linkSession.update({where:{id:pending.id},data:{expiresAt:new Date(Date.now()-1000)}});await gameInspect(pending,410);
 const cancelled=await createLink();const {minecraftUuid,gameSessionId}=cancelled.identity;
 await service(request(http).delete(`/v1/link-sessions/${cancelled.id}`)).send({minecraftUuid,gameSessionId}).expect(204);
 await gameInspect(cancelled,409);
});
test('expired link, expired web session, substituted token and absent CSRF fail',async()=>{
 const user=await login();const link=await createLink();
 await browser(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`),user).send({token:'x'.repeat(43),consent}).expect(404);
 await host(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`)).set('Cookie',user.cookie).set('Origin','http://localhost:5173').send({token:link.token}).expect(403);
 await db.linkSession.update({where:{id:link.id},data:{expiresAt:new Date(Date.now()-1000)}});await webConfirm(link,user,410);await gameConfirm(link,410);
 const current=await createLink();await webConfirm(current,user);await db.webSession.updateMany({data:{expiresAt:new Date(Date.now()-1000)}});await gameConfirm(current,401);assert.equal((await getPolicy(current.identity.minecraftUuid)).status,'unlinked');
});
test('outsider cannot claim a game account and duplicate subject or UUID cannot relink',async()=>{
 const user=await login();const outsider=await login('outsider');const link=await createLink();await webConfirm(link,outsider,403);await webConfirm(link,user);await gameConfirm(link);
 await service(request(http).post('/v1/link-sessions')).send(link.identity).expect(409);
 const other=await createLink();await webConfirm(other,user);await gameConfirm(other,409);assert.equal((await getPolicy(other.identity.minecraftUuid)).status,'unlinked');
});
test('new attempt cancels old link and disconnect cancellation revokes pending capability',async()=>{
 const user=await login();const link=await createLink();const next=await createLink(link.identity.minecraftUuid);await webConfirm(link,user,409);
 const {minecraftUuid,gameSessionId}=next.identity;
 await service(request(http).delete(`/v1/link-sessions/${next.id}`)).send({minecraftUuid,gameSessionId}).expect(204);await webConfirm(next,user,409);
});
test('another browser cannot take over a confirmed link; logout invalidates confirmation',async()=>{
 const first=await login();const second=await login();const link=await createLink();await webConfirm(link,first);await webConfirm(link,second,409);
 await browser(request(http).post('/v1/auth/logout'),first).expect(204);await gameConfirm(link,401);
});
test('concurrent completion yields one link and one audit event',async()=>{
 const user=await login();const link=await createLink();await webConfirm(link,user);const {minecraftUuid,gameSessionId}=link.identity;
 const results=await Promise.all([1,2].map(()=>service(request(http).post(`/v1/link-sessions/${link.id}/game-confirm`)).send({minecraftUuid,gameSessionId})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(await db.auditEvent.count({where:{action:'minecraft.linked'}}),1);
});
test('membership revocation and freshness deny scope and advance policy version',async()=>{
 const user=await login();const link=await createLink();await webConfirm(link,user);await gameConfirm(link);const first=await getPolicy(link.identity.minecraftUuid);
 await db.subject.update({where:{id:user.profile.id},data:{membershipStatus:'suspended'}});const denied=await getPolicy(link.identity.minecraftUuid);assert.equal(denied.status,'suspended');assert.deepEqual(denied.allowedServerIds,[]);assert.ok(denied.policyVersion>first.policyVersion);
 await db.subject.update({where:{id:user.profile.id},data:{membershipStatus:'active',verifiedUntil:new Date(Date.now()+30000)}});const short=await getPolicy(link.identity.minecraftUuid);assert.ok(Date.parse(short.expiresAt)-Date.parse(short.issuedAt)<=30000);
 await db.subject.update({where:{id:user.profile.id},data:{verifiedUntil:new Date(Date.now()-1000)}});assert.equal((await getPolicy(link.identity.minecraftUuid)).status,'stale');
});
test('self-reported Discord CRUD validates uint64, allows duplicate claims and never grants membership',async()=>{
 const user=await login();const outsider=await login('outsider');
 const result=await browser(request(http).put('/v1/me/discord-id'),user).send({id:'18446744073709551615'}).expect(200);assert.equal(result.body.verificationStatus,'self_reported');
 await browser(request(http).put('/v1/me/discord-id'),user).send({id:'18446744073709551616'}).expect(400);
 await browser(request(http).put('/v1/me/discord-id'),outsider).send({id:'18446744073709551615'}).expect(200);
 const me=await browser(request(http).get('/v1/me'),outsider).expect(200);assert.equal(me.body.membership.status,'inactive');
 await browser(request(http).delete('/v1/me/discord-id'),user).expect(204);assert.equal((await browser(request(http).get('/v1/me'),user).expect(200)).body.discordReference,null);
});
test('portal and admin cookies coexist on the same hostname, and TTL removes expired sessions',async()=>{
 const user=await login();
 const admin=await request(http).get('/v1/auth/session').set('Host','localhost:5174').expect(200);
 const adminCookie=admin.headers['set-cookie'][0].split(';')[0];
 assert.notEqual(user.cookie.split('=')[0],adminCookie.split('=')[0]);
 await host(request(http).get('/v1/me')).set('Cookie',`${user.cookie}; ${adminCookie}`).expect(200);
 await db.webSession.updateMany({data:{expiresAt:new Date(Date.now()-1000)}});
 await app.get(PassportService).cleanup();assert.equal(await db.webSession.count(),0);
});
test('school provider and admin remain explicitly unavailable',async()=>{
 const user=await login();await browser(request(http).post('/v1/auth/university/start'),user).send({}).expect(503);
 await browser(request(http).get('/v1/admin/overview'),user).expect(403);
});
test('privacy notice and explicit current consent gate linking and create one immutable receipt',async()=>{
 const notice=await request(http).get('/v1/privacy').expect(200);assert.equal(notice.body.version,privacyNotice.version);assert.ok(notice.body.items.length);assert.match(notice.body.retention,/백업/);
 const user=await login();assert.equal(user.profile.privacyConsent.accepted,false);const link=await createLink();
 for(const input of [undefined,{accepted:false,version:privacyNotice.version}]){
  const result=await browser(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`),user).send({token:link.token,consent:input}).expect(400);assert.equal(result.body.code,'consent_required');
 }
 const stale=await browser(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`),user).send({token:link.token,consent:{accepted:true,version:'previous-version'}}).expect(409);assert.equal(stale.body.code,'consent_version_mismatch');
 assert.equal(await db.consentReceipt.count(),0);assert.equal((await db.linkSession.findUnique({where:{id:link.id}})).webConfirmedAt,null);
 await webConfirm(link,user);await gameConfirm(link);await webConfirm(link,user,409);
 const rows=await db.consentReceipt.findMany();assert.equal(rows.length,1);assert.equal(rows[0].source,'minecraft_link');assert.equal(rows[0].contextId,link.id);assert.equal(rows[0].version,privacyNotice.version);
 const me=await browser(request(http).get('/v1/me'),user).expect(200);assert.equal(me.body.privacyConsent.accepted,true);assert.ok(me.body.privacyConsent.acceptedAt);
});
test('skin routes require the owning session or bound link capability and never change linking state',async()=>{
 const original=skinModule.minecraftSkin;let calls=0;const seen=[];
 skinModule.minecraftSkin=async uuid=>{calls++;seen.push(uuid);return{dataUrl:null,model:null};};
 try{
  const anon=await host(request(http).get('/v1/auth/session')).expect(200);const anonymous={cookie:anon.headers['set-cookie'][0].split(';')[0],csrf:anon.body.csrfToken};const link=await createLink();
  await browser(request(http).post(`/v1/link-sessions/${link.id}/skin`),anonymous).send({token:'x'.repeat(43)}).expect(404);
  await host(request(http).post(`/v1/link-sessions/${link.id}/skin`)).set('Cookie',anonymous.cookie).set('Origin','http://localhost:5173').send({token:link.token}).expect(403);assert.equal(calls,0);
  assert.deepEqual((await browser(request(http).post(`/v1/link-sessions/${link.id}/skin`),anonymous).send({token:link.token}).expect(200)).body,{dataUrl:null,model:null});assert.deepEqual(seen,[link.identity.minecraftUuid]);
  assert.equal((await db.linkSession.findUnique({where:{id:link.id}})).webConfirmedAt,null);assert.equal(await db.consentReceipt.count(),0);
  await host(request(http).get('/v1/me/minecraft-skin')).set('Cookie',anonymous.cookie).expect(401);
  const user=await login();assert.equal((await browser(request(http).get('/v1/me/minecraft-skin'),user).expect(200)).body.dataUrl,null);assert.equal(calls,1);
  await webConfirm(link,user);await gameConfirm(link);await browser(request(http).get('/v1/me/minecraft-skin'),user).expect(200);assert.equal(calls,2);
  const outsider=await login('outsider');await browser(request(http).get('/v1/me/minecraft-skin'),outsider).query({uuid:link.identity.minecraftUuid}).expect(200);assert.equal(calls,2);
  await db.linkSession.update({where:{id:link.id},data:{expiresAt:new Date(Date.now()-1)}});await browser(request(http).post(`/v1/link-sessions/${link.id}/skin`),anonymous).send({token:link.token}).expect(410);assert.equal(calls,2);
 }finally{skinModule.minecraftSkin=original;}
});
test('legacy or mismatched consent receipts cannot complete a pending link',async()=>{
 const user=await login();const other=await login('outsider');
 for(const mode of ['missing','old-version','wrong-link','wrong-subject']){
  const link=await createLink();await webConfirm(link,user);
  const where={subjectId:user.profile.id,source:'minecraft_link',contextId:link.id};
  if(mode==='missing')await db.consentReceipt.deleteMany({where});
  else await db.consentReceipt.updateMany({where,data:mode==='old-version'?{version:'obsolete'}:mode==='wrong-link'?{contextId:randomUUID()}:{subjectId:other.profile.id}});
  const rejected=await gameConfirm(link,403);assert.equal(rejected.body.code,'consent_required');
  const stored=await db.linkSession.findUnique({where:{id:link.id}});assert.equal(stored.status,'pending');assert.equal(stored.gameConfirmedAt,null);
  assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:link.identity.minecraftUuid}})).subjectId,null);
 }
 assert.equal(await db.auditEvent.count({where:{action:'minecraft.linked'}}),0);
});
test('policy events require service identity and recover initial, retained and reset cursors without numeric loss',async()=>{
 await request(http).get('/v1/minecraft/events').expect(401);
 const initial=await service(request(http).get('/v1/minecraft/events')).expect(200);assert.equal(initial.body.reset,true);assert.equal(initial.body.cursor,'0');
 const uuid=randomUUID();await db.policyEvent.createMany({data:[{minecraftUuid:uuid,policyVersion:2},{minecraftUuid:uuid,policyVersion:3}]});
 const next=await service(request(http).get('/v1/minecraft/events?after=0')).expect(200);assert.equal(next.body.reset,false);assert.deepEqual(next.body.events.map(e=>e.policyVersion),[2,3]);assert.equal(typeof next.body.events[0].id,'string');
 const empty=await service(request(http).get(`/v1/minecraft/events?after=${next.body.cursor}`)).expect(200);assert.deepEqual(empty.body.events,[]);
 await service(request(http).get('/v1/minecraft/events?after=-1')).expect(400);await service(request(http).get('/v1/minecraft/events?after=9999999999999999999')).expect(400);
 await db.policyEvent.deleteMany({where:{id:1n}});const retained=await service(request(http).get('/v1/minecraft/events?after=0')).expect(200);assert.equal(retained.body.reset,true);
 const restored=await service(request(http).get('/v1/minecraft/events?after=999')).expect(200);assert.equal(restored.body.reset,true);assert.equal(restored.body.cursor,next.body.cursor);
});
