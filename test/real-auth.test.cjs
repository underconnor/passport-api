const {test,before,after,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
if(!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
const database=new URL(process.env.TEST_DATABASE_URL);
if(!database.pathname.endsWith('_test')) throw new Error('Refusing a non-test database');
database.searchParams.set('schema','auth_test');
Object.assign(process.env,{DATABASE_URL:database.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',API_SERVICE_TOKEN:'test-service-'.repeat(5),SESSION_SECRET:'test-session-'.repeat(5),ROSTER_MATCHING_SECRET:'test-roster-'.repeat(5),DATA_ENCRYPTION_KEY:'ab'.repeat(32),ADMIN_BOOTSTRAP_TOKEN:'test-bootstrap-'.repeat(5),ADMIN_MFA_REQUIRED:'true',SHEETS_SYNC_ENABLED:'false'});
const {createApp}=require('../dist/app');
const {PassportService}=require('../dist/passport.service');
const {universityAdapter}=require('../dist/university-auth');
const {UniversityVerificationError}=require('../dist/integrations/usaint');
const {studentKey}=require('../dist/integrations/sheets');
const {applyRosterSnapshot}=require('../dist/membership-sync');
const {hash}=require('../dist/security');
const {totpAt}=require('../dist/totp');
const PORTAL='portal.example.test',ADMIN='admin.example.test';
const db=new PrismaClient({datasources:{db:{url:database.href}}});
let app,http,service,verifyCalls;
const originalVerify=universityAdapter.verify;
const rosterOptions={allowedServerIds:['lobby','survival']};
const rosterRows=()=>Array.from({length:5},(_,i)=>({studentKey:studentKey(String(99990001+i),process.env.ROSTER_MATCHING_SECRET),status:'active',roleLabel:'회원',serverIds:['lobby','survival']}));
const origin=host=>`https://${host}`;
const cookieOf=res=>res.headers['set-cookie']?.[0]?.split(';')[0];
function browser(req,user,mutation=false){req=req.set('Host',user.host).set('Cookie',user.cookie);return mutation?req.set('Origin',origin(user.host)).set('X-CSRF-Token',user.csrf):req;}
function serviceRequest(req){return req.set('Authorization',`Bearer ${process.env.API_SERVICE_TOKEN}`);}
async function anonymous(host=PORTAL){const response=await request(http).get('/v1/auth/session').set('Host',host).expect(200);return{host,cookie:cookieOf(response),csrf:response.body.csrfToken,response};}
async function begin(user,input={}) {
 const result=await browser(request(http).post('/v1/auth/university/start'),user,true).send(input).expect(200);
 const callback=new URL(new URL(result.body.url).searchParams.get('apiReturnUrl'));
 return{path:callback.pathname,callback,result};
}
async function callback(user,attempt,studentNumber='99990001',token=`synthetic-${randomBytes(24).toString('hex')}`){return browser(request(http).get(attempt.path),user).query({sIdno:studentNumber,sToken:token}).expect(303);}
async function login(studentNumber='99990001',host=PORTAL,token) {
 const user=await anonymous(host);const oldCookie=user.cookie;const attempt=await begin(user);const result=await callback(user,attempt,studentNumber,token);
 assert.equal(result.headers.location,'/');user.cookie=cookieOf(result);assert.ok(user.cookie);assert.notEqual(user.cookie,oldCookie);
 const me=await browser(request(http).get('/v1/me'),user).expect(200);user.csrf=me.body.csrfToken;user.profile=me.body;return user;
}
async function enroll(user){const result=await browser(request(http).post('/v1/admin/enrollment'),user,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(200);return result.body.secret;}
async function mfa(user,secret,step=Math.floor(Date.now()/30000)) {
 const result=await browser(request(http).post('/v1/admin/mfa'),user,true).send({code:totpAt(secret,step)}).expect(200);
 if(cookieOf(result))user.cookie=cookieOf(result);if(result.body.csrfToken)user.csrf=result.body.csrfToken;return result;
}
async function administrator(){const user=await login('99990001',ADMIN);user.secret=await enroll(user);user.step=Math.floor(Date.now()/30000);await mfa(user,user.secret,user.step);return user;}
async function minecraft(subjectId){return db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'AuthTestPlayer',subjectId,policyVersion:1}});}
async function policy(uuid){return(await serviceRequest(request(http).get(`/v1/minecraft/policies/${uuid}`)).expect(200)).body;}
before(async()=>{await db.$connect();});
after(async()=>{universityAdapter.verify=originalVerify;await db.$disconnect();});
beforeEach(async()=>{
 await db.$executeRawUnsafe('TRUNCATE TABLE "ConsumedUniversityToken", "UniversityAuthRequest", "Administrator", "AuditEvent", "PolicyEvent", "LinkSession", "WebSession", "MinecraftIdentity", "Subject", "RosterMembership", "RosterSnapshot" RESTART IDENTITY CASCADE');
 verifyCalls=0;
 // This stub is installed only in this test process; no real school or member data is used.
 universityAdapter.verify=async input=>{verifyCalls++;return{provider:'ssu-usaint',studentNumber:input.sIdno,name:`Synthetic ${input.sIdno.slice(-2)}`,department:'Test department',academicStatus:'ENROLLED',courseLabel:'학사 / 1학기 재학',parserVersion:'ssu-main-student-v1',verifiedAt:new Date()};};
 await applyRosterSnapshot(db,{entries:rosterRows(),sourceKey:'c'.repeat(64),fetchedAt:new Date()},rosterOptions);
 app=await createApp();service=app.get(PassportService);http=app.getHttpServer();
});
afterEach(async()=>{await app?.close();});

test('school start requires same-host origin and CSRF; callback state is browser-bound and expires',async()=>{
 const user=await anonymous();const other=await anonymous();
 assert.match(user.response.headers['set-cookie'][0],/^__Host-passport_portal_session=/);assert.match(user.response.headers['set-cookie'][0],/Secure/);assert.match(user.response.headers['set-cookie'][0],/HttpOnly/);assert.doesNotMatch(user.response.headers['set-cookie'][0],/Domain=/);
 await browser(request(http).post('/v1/auth/university/start'),user).set('Origin',origin(PORTAL)).send({}).expect(403);
 await browser(request(http).post('/v1/auth/university/start'),user,true).set('Origin','https://attacker.example').send({}).expect(403);
 const attempt=await begin(user);assert.equal(attempt.callback.origin,origin(PORTAL));assert.match(new URL(attempt.result.body.url).hostname,/^smartid\.ssu\.ac\.kr$/);
 assert.equal((await callback(other,attempt)).headers.location,'/?auth_error=university_state_invalid');assert.equal(verifyCalls,0);
 await db.universityAuthRequest.updateMany({data:{expiresAt:new Date(Date.now()-1)}});
 assert.equal((await callback(user,attempt)).headers.location,'/?auth_error=university_request_expired');assert.equal(verifyCalls,0);
});
test('verified school identity matches HMAC roster, rotates cookie and rejects reused school token',async()=>{
 const token='synthetic-school-token-'+randomBytes(16).toString('hex');const first=await anonymous();const oldCookie=first.cookie;const attempt=await begin(first);const returned=await callback(first,attempt,'99990001',token);
 assert.equal(returned.headers.location,'/');first.cookie=cookieOf(returned);assert.notEqual(first.cookie,oldCookie);
 await request(http).get('/v1/me').set('Host',PORTAL).set('Cookie',oldCookie).expect(401);
 const me=await browser(request(http).get('/v1/me'),first).expect(200);assert.equal(me.body.identityProvider,'usaint');assert.equal(me.body.membership.status,'active');
 const subject=await db.subject.findUnique({where:{id:me.body.id}});assert.equal(subject.universityKey,studentKey('99990001',process.env.ROSTER_MATCHING_SECRET));assert.ok(subject.universityVerifiedUntil>Date.now());
 const stored=await db.consumedUniversityToken.findMany();assert.equal(stored.length,1);assert.equal(stored[0].tokenHash,hash(`ssu-token:${token}`));assert.ok(!JSON.stringify(stored).includes(token));
 const second=await anonymous();const secondAttempt=await begin(second);assert.equal((await callback(second,secondAttempt,'99990001',token)).headers.location,'/?auth_error=university_token_consumed');
 await browser(request(http).get('/v1/me'),second).expect(401);assert.equal(await db.subject.count(),1);
});
test('unknown or expired roster never grants a verified school user game access',async()=>{
 const outsider=await login('99990999');assert.equal(outsider.profile.membership.status,'inactive');assert.deepEqual((await browser(request(http).get('/v1/me/servers'),outsider).expect(200)).body.servers,[]);
 const game=await minecraft(outsider.profile.id);assert.equal((await policy(game.uuid)).status,'revoked');
 await db.rosterSnapshot.updateMany({data:{expiresAt:new Date(Date.now()-1)}});
 const stale=await login('99990002');assert.deepEqual((await browser(request(http).get('/v1/me/servers'),stale).expect(200)).body.servers,[]);
 assert.equal((await policy((await minecraft(stale.profile.id)).uuid)).status,'stale');
});
test('school reauthentication restores a linked expired identity and emits its new policy version',async()=>{
 const member=await login();const game=await minecraft(member.profile.id);await policy(game.uuid);
 await db.subject.update({where:{id:member.profile.id},data:{universityVerifiedUntil:new Date(Date.now()-1)}});
 const expired=await policy(game.uuid);assert.equal(expired.status,'stale');
 const eventsBefore=await db.policyEvent.count({where:{minecraftUuid:game.uuid}});
 const renewed=await login();assert.equal(renewed.profile.id,member.profile.id);assert.ok(Date.parse(renewed.profile.universityVerifiedUntil)>Date.now());
 const identity=await db.minecraftIdentity.findUnique({where:{uuid:game.uuid}});assert.equal(identity.policyVersion,expired.policyVersion+1);assert.equal(identity.policyFingerprint,'');
 assert.equal(await db.policyEvent.count({where:{minecraftUuid:game.uuid}}),eventsBefore+1);
 const event=await db.policyEvent.findFirst({where:{minecraftUuid:game.uuid},orderBy:{id:'desc'}});assert.equal(event.policyVersion,identity.policyVersion);
 const restored=await policy(game.uuid);assert.equal(restored.status,'active');assert.equal(restored.policyVersion,identity.policyVersion);assert.deepEqual(restored.allowedServerIds,['lobby','survival']);
});
test('school failure consumes its request and expired browser session cannot finish in-flight verification',async()=>{
 const user=await anonymous();const attempt=await begin(user);universityAdapter.verify=async()=>{throw new UniversityVerificationError('rejected');};
 assert.equal((await callback(user,attempt)).headers.location,'/?auth_error=university_rejected');assert.equal((await callback(user,attempt)).headers.location,'/?auth_error=university_request_consumed');
 const next=await begin(user);universityAdapter.verify=async input=>{await db.webSession.updateMany({data:{expiresAt:new Date(Date.now()-1)}});return{studentNumber:input.sIdno,name:'Synthetic',department:'Test',academicStatus:'ENROLLED'};};
 assert.equal((await callback(user,next)).headers.location,'/?auth_error=university_request_expired');assert.equal(await db.subject.count(),0);
});
test('school return preserves encrypted game-link context only in the URL fragment',async()=>{
 const created=await serviceRequest(request(http).post('/v1/link-sessions')).send({minecraftUuid:randomUUID(),minecraftName:'LinkTest',gameSessionId:randomUUID()}).expect(201);
 const linkToken=new URLSearchParams(new URL(created.body.url).hash.slice(1)).get('token');const user=await anonymous();
 await browser(request(http).post('/v1/auth/university/start'),user,true).send({link:{id:created.body.id,token:'x'.repeat(43)}}).expect(403);
 const attempt=await begin(user,{link:{id:created.body.id,token:linkToken}});const stored=await db.universityAuthRequest.findFirst();assert.ok(stored.returnContext);assert.ok(!stored.returnContext.includes(linkToken));assert.ok(!attempt.result.body.url.includes(linkToken));
 const result=await callback(user,attempt);assert.equal(result.headers.location,`/link/${created.body.id}#token=${linkToken}`);
 assert.equal((await db.linkSession.findUnique({where:{id:created.body.id}})).status,'pending');
});
test('duplicate callback races verify once and create exactly one school session',async()=>{
 const user=await anonymous();const attempt=await begin(user);const token='synthetic-race-'+randomBytes(24).toString('hex');
 const results=await Promise.all([callback(user,attempt,'99990001',token),callback(user,attempt,'99990001',token)]);
 assert.equal(results.filter(result=>result.headers.location==='/').length,1);assert.equal(verifyCalls,1);assert.equal(await db.subject.count(),1);assert.equal(await db.auditEvent.count({where:{action:'university.login'}}),1);
});
test('admin bootstrap requires school identity, private host, correct token and a single first subject',async()=>{
 const portal=await login();await browser(request(http).get('/v1/admin/session'),portal).expect(403);
 const admin=await login('99990001',ADMIN);await browser(request(http).get('/v1/admin/members'),admin).expect(403);
 await browser(request(http).post('/v1/admin/enrollment'),admin,true).send({bootstrapToken:'incorrect-bootstrap-'.repeat(3)}).expect(403);
 const secret=await enroll(admin);assert.match(secret,/^[A-Z2-7]+$/);assert.notEqual((await db.administrator.findUnique({where:{subjectId:admin.profile.id}})).totpSecret,secret);
 await browser(request(http).get('/v1/admin/overview'),admin).expect(403);
 const other=await login('99990002',ADMIN);await browser(request(http).post('/v1/admin/enrollment'),other,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(409);
 await mfa(admin,secret);await browser(request(http).get('/v1/admin/overview'),admin).expect(200);
 await browser(request(http).post('/v1/admin/enrollment'),admin,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(409);
});
test('optional MFA still requires school login, registered admin, bootstrap and CSRF without claiming MFA happened',async()=>{
 service.config.adminMfaRequired=false;
 const user=await login('99990001',ADMIN);
 const before=await browser(request(http).get('/v1/admin/session'),user).expect(200);
 assert.equal(before.body.mfaRequired,false);assert.equal(before.body.authorized,false);
 await browser(request(http).get('/v1/admin/overview'),user).expect(403);
 await browser(request(http).post('/v1/admin/enrollment'),user).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(403);
 await browser(request(http).post('/v1/admin/enrollment'),user,true).send({bootstrapToken:'wrong-bootstrap-'.repeat(4)}).expect(403);
 const enrolled=await browser(request(http).post('/v1/admin/enrollment'),user,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(200);
 assert.deepEqual(enrolled.body,{enrolled:true,mfaRequired:false});
 const stored=await db.administrator.findUnique({where:{subjectId:user.profile.id}});assert.equal(stored.enabled,true);assert.equal(stored.totpSecret,'');
 const status=await browser(request(http).get('/v1/admin/session'),user).expect(200);
 assert.equal(status.body.authorized,true);assert.equal(status.body.mfaVerified,false);assert.equal(status.body.mfaVerifiedUntil,null);
 await browser(request(http).get('/v1/admin/overview'),user).expect(200);
 assert.equal((await browser(request(http).post('/v1/admin/mfa'),user,true).send({code:'000000'}).expect(403)).body.code,'mfa_not_enrolled');
 const other=await login('99990002',ADMIN);await browser(request(http).get('/v1/admin/overview'),other).expect(403);
 await browser(request(http).post('/v1/admin/enrollment'),other,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(409);
 let calls=0;service.membership.preview=async()=>{calls++;return{databaseChanged:false};};
 await browser(request(http).post('/v1/admin/roster/preview'),user).send({}).expect(403);assert.equal(calls,0);
 await browser(request(http).post('/v1/admin/roster/preview'),user,true).send({}).expect(200);assert.equal(calls,1);
 await db.subject.update({where:{id:user.profile.id},data:{universityVerifiedUntil:new Date(Date.now()-1)}});
 assert.equal((await browser(request(http).get('/v1/admin/overview'),user).expect(403)).body.code,'university_login_required');
 assert.equal((await browser(request(http).get('/v1/admin/session'),user).expect(200)).body.authorized,false);
});
test('disabling MFA preserves an existing TOTP secret and required mode still rejects an unverified session',async()=>{
 const user=await login('99990001',ADMIN);await enroll(user);
 const original=await db.administrator.findUnique({where:{subjectId:user.profile.id}});
 service.config.adminMfaRequired=false;
 await browser(request(http).post('/v1/admin/enrollment'),user,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(200);
 assert.equal((await db.administrator.findUnique({where:{subjectId:user.profile.id}})).totpSecret,original.totpSecret);
 assert.equal((await browser(request(http).get('/v1/admin/session'),user).expect(200)).body.authorized,true);
 service.config.adminMfaRequired=true;
 const status=await browser(request(http).get('/v1/admin/session'),user).expect(200);
 assert.equal(status.body.authorized,false);assert.equal(status.body.mfaRequired,true);assert.equal(status.body.enrollmentPending,false);assert.equal(status.body.mfaVerified,false);
 assert.equal((await browser(request(http).get('/v1/admin/overview'),user).expect(403)).body.code,'mfa_required');
});
test('reenabling MFA lets only the same registered subject enroll an absent secret with bootstrap',async()=>{
 service.config.adminMfaRequired=false;const user=await login('99990001',ADMIN);
 await browser(request(http).post('/v1/admin/enrollment'),user,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(200);
 service.config.adminMfaRequired=true;
 const pending=await browser(request(http).get('/v1/admin/session'),user).expect(200);
 assert.equal(pending.body.enrolled,true);assert.equal(pending.body.enrollmentPending,true);assert.equal(pending.body.authorized,false);
 await browser(request(http).get('/v1/admin/overview'),user).expect(403);
 const other=await login('99990002',ADMIN);
 await browser(request(http).post('/v1/admin/enrollment'),other,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(409);
 await browser(request(http).post('/v1/admin/enrollment'),user,true).send({bootstrapToken:'wrong-bootstrap-'.repeat(4)}).expect(403);
 const enrollment=await browser(request(http).post('/v1/admin/enrollment'),user,true).send({bootstrapToken:process.env.ADMIN_BOOTSTRAP_TOKEN}).expect(200);
 assert.equal(enrollment.body.mfaRequired,true);assert.ok(enrollment.body.secret);assert.ok(enrollment.body.otpauthUrl);
 await browser(request(http).get('/v1/admin/overview'),user).expect(403);
 await mfa(user,enrollment.body.secret);
 const done=await browser(request(http).get('/v1/admin/session'),user).expect(200);
 assert.equal(done.body.authorized,true);assert.equal(done.body.enrollmentPending,false);assert.equal(done.body.mfaVerified,true);
});
test('MFA elevates only a rotated session, rejects code replay and expires after fifteen minutes',async()=>{
 const admin=await login('99990001',ADMIN);const secret=await enroll(admin);const oldCookie=admin.cookie,oldCsrf=admin.csrf,step=Math.floor(Date.now()/30000);const result=await mfa(admin,secret,step);
 assert.notEqual(admin.cookie,oldCookie);assert.notEqual(admin.csrf,oldCsrf);assert.ok(Date.parse(result.body.mfaVerifiedUntil)-Date.now()<=900000);
 await request(http).get('/v1/admin/overview').set('Host',ADMIN).set('Cookie',oldCookie).expect(401);
 const replay=await browser(request(http).post('/v1/admin/mfa'),admin,true).send({code:totpAt(secret,step)}).expect(403);assert.equal(replay.body.code,'mfa_invalid');
 await db.webSession.updateMany({data:{mfaVerifiedUntil:new Date(Date.now()-1)}});const expired=await browser(request(http).get('/v1/admin/overview'),admin).expect(403);assert.equal(expired.body.code,'mfa_required');
});
test('five invalid TOTP attempts lock verification, and a valid code succeeds only after lock expiry',async()=>{
 const admin=await login('99990001',ADMIN);const secret=await enroll(admin);const step=Math.floor(Date.now()/30000);const possible=new Set([step-1,step,step+1].map(s=>totpAt(secret,s)));let invalid='000000';while(possible.has(invalid))invalid=String(Number(invalid)+1).padStart(6,'0');
 for(let i=0;i<5;i++)await browser(request(http).post('/v1/admin/mfa'),admin,true).send({code:invalid}).expect(403);
 const locked=await browser(request(http).post('/v1/admin/mfa'),admin,true).send({code:totpAt(secret,Math.floor(Date.now()/30000))}).expect(403);assert.equal(locked.body.code,'mfa_locked');
 await db.administrator.update({where:{subjectId:admin.profile.id},data:{lockedUntil:new Date(Date.now()-1)}});
 await mfa(admin,secret);assert.equal((await db.administrator.findUnique({where:{subjectId:admin.profile.id}})).failedAttempts,0);
});
test('admin restriction and suspension update game policy, audit actor and outbox; roster refresh preserves overrides',async()=>{
 const admin=await administrator();const member=await login('99990002');const game=await minecraft(member.profile.id);const initial=await policy(game.uuid);
 const url=`/v1/admin/members/${member.profile.id}/access`;
 await browser(request(http).put(url),admin,true).send({suspended:false,restricted:true,serverIds:['unknown']}).expect(403);
 await browser(request(http).put(url),admin,true).send({suspended:false,restricted:true,serverIds:['lobby']}).expect(200);
 const restricted=await policy(game.uuid);assert.deepEqual(restricted.allowedServerIds,['lobby']);assert.ok(restricted.policyVersion>initial.policyVersion);
 const previous=await db.rosterSnapshot.findUnique({where:{id:'current'}});await applyRosterSnapshot(db,{entries:rosterRows(),sourceKey:previous.sourceKey,fetchedAt:new Date(Math.max(Date.now(),previous.fetchedAt.getTime()+1))},rosterOptions);
 assert.deepEqual((await policy(game.uuid)).allowedServerIds,['lobby']);
 await browser(request(http).put(url),admin,true).send({suspended:true,restricted:true,serverIds:['lobby']}).expect(200);
 const suspended=await policy(game.uuid);assert.equal(suspended.status,'suspended');assert.deepEqual(suspended.allowedServerIds,[]);assert.ok(suspended.policyVersion>restricted.policyVersion);
 assert.equal(await db.policyEvent.count({where:{minecraftUuid:game.uuid}}),2);
 const event=await db.auditEvent.findFirst({where:{action:'admin.access_changed',subjectId:member.profile.id}});assert.equal(event.actorSubjectId,admin.profile.id);assert.ok(event.details.before);assert.ok(event.details.after);
});
test('admin unlink invalidates the current Minecraft identity and pending link attempts',async()=>{
 const admin=await administrator();const member=await login('99990002');const game=await minecraft(member.profile.id);const initial=await policy(game.uuid);
 await db.linkSession.create({data:{minecraftUuid:game.uuid,minecraftName:game.name,tokenHash:hash(randomUUID()),gameSessionHash:hash(randomUUID()),expiresAt:new Date(Date.now()+60000)}});
 await browser(request(http).delete(`/v1/admin/members/${member.profile.id}/minecraft`),admin,true).expect(200);
 const denied=await policy(game.uuid);assert.equal(denied.status,'unlinked');assert.ok(denied.policyVersion>initial.policyVersion);assert.equal(await db.linkSession.count({where:{minecraftUuid:game.uuid,status:'pending'}}),0);
 assert.equal(await db.auditEvent.count({where:{action:'admin.minecraft_unlinked',actorSubjectId:admin.profile.id}}),1);
});
test('expired school identity denies admin and shortens game policy leases independently of roster freshness',async()=>{
 const admin=await administrator();const game=await minecraft(admin.profile.id);
 await db.subject.update({where:{id:admin.profile.id},data:{universityVerifiedUntil:new Date(Date.now()+20000)}});const short=await policy(game.uuid);assert.ok(Date.parse(short.expiresAt)-Date.parse(short.issuedAt)<=20000);
 await db.subject.update({where:{id:admin.profile.id},data:{universityVerifiedUntil:new Date(Date.now()-1)}});
 assert.equal((await policy(game.uuid)).status,'stale');assert.equal((await browser(request(http).get('/v1/admin/overview'),admin).expect(403)).body.code,'university_login_required');
});
test('roster actions require administrator MFA and same-site mutation protection before invoking sync',async()=>{
 let calls=0;service.membership.preview=async()=>{calls++;return{digest:'e'.repeat(64),risks:[],databaseChanged:false};};
 const user=await login('99990001',ADMIN);await browser(request(http).post('/v1/admin/roster/preview'),user,true).send({}).expect(403);assert.equal(calls,0);
 const secret=await enroll(user);await mfa(user,secret);
 await browser(request(http).post('/v1/admin/roster/preview'),user).send({}).expect(403);assert.equal(calls,0);
 await browser(request(http).post('/v1/admin/roster/preview'),user,true).send({}).expect(200);assert.equal(calls,1);
});
