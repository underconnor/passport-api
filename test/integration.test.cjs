const {test,before,after,beforeEach}=require('node:test');
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
async function webConfirm(link,user,status=200){return browser(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`),user).send({token:link.token}).expect(status);}
async function gameConfirm(link,status=200,body=link.identity){const {minecraftUuid,gameSessionId}=body;return service(request(http).post(`/v1/link-sessions/${link.id}/game-confirm`)).send({minecraftUuid,gameSessionId}).expect(status);}
async function getPolicy(uuid){return (await service(request(http).get(`/v1/minecraft/policies/${uuid}`)).expect(200)).body;}
before(async()=>{app=await createApp();db=app.get(PassportService).db;http=app.getHttpServer();});
after(async()=>{await app?.close();});
beforeEach(async()=>{await db.$executeRawUnsafe('TRUNCATE TABLE "AuditEvent", "PolicyEvent", "LinkSession", "WebSession", "MinecraftIdentity", "Subject" RESTART IDENTITY CASCADE');await seedDevelopment(db);});
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
test('expired link, expired web session, substituted token and absent CSRF fail',async()=>{
 const user=await login();const link=await createLink();
 await browser(request(http).post(`/v1/link-sessions/${link.id}/web-confirm`),user).send({token:'x'.repeat(43)}).expect(404);
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
