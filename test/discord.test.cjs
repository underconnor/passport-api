const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL required');
const database=new URL(process.env.TEST_DATABASE_URL);if(!database.pathname.endsWith('_test'))throw new Error('Dedicated test DB required');database.searchParams.set('schema','discord_test');
Object.assign(process.env,{DATABASE_URL:database.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',API_SERVICE_TOKEN:'minecraft-test-'.repeat(4),PASSPORT_DISCORD_SERVICE_TOKEN:'discord-test-'.repeat(4),DISCORD_GUILD_ID:'100000000000000001',DISCORD_MEMBER_ROLE_ID:'100000000000000002',SESSION_SECRET:'session-test-'.repeat(4),ROSTER_MATCHING_SECRET:'roster-test-'.repeat(4),DATA_ENCRYPTION_KEY:'ab'.repeat(32),ADMIN_MFA_REQUIRED:'false',SHEETS_SYNC_ENABLED:'false'});
const {createApp}=require('../dist/app'),{PassportService}=require('../dist/passport.service');
const {hash,csrf}=require('../dist/security'),{privacyNotice}=require('../dist/privacy');
const {universityAdapter}=require('../dist/university-auth');
const {studentKey}=require('../dist/integrations/sheets');
const {applyRosterSnapshot}=require('../dist/membership-sync');
const PORTAL='portal.example.test',ADMIN='admin.example.test',guildId=process.env.DISCORD_GUILD_ID;
const consent={accepted:true,version:privacyNotice.version};
let app,http,p,db,member,other,admin,originalVerify;
function browser(req,user,mutation=true){req=req.set('Host',user.host).set('Cookie',user.cookie);return mutation?req.set('Origin',`https://${user.host}`).set('X-CSRF-Token',user.csrf):req;}
function bot(req){return req.set('Authorization',`Bearer ${process.env.PASSPORT_DISCORD_SERVICE_TOKEN}`);}
const userId='200000000000000001';let interaction=300000000000000001n;
async function session(subjectId,host=PORTAL){const token=randomBytes(32).toString('base64url');await db.webSession.create({data:{tokenHash:hash(token),subjectId,audienceHost:host,expiresAt:new Date(Date.now()+3600000)}});return {subjectId,host,cookie:`__Host-passport_${host===PORTAL?'portal':'admin'}_session=${token}`,csrf:csrf(p.config.sessionSecret,token)};}
function linkBody(discordUserId=userId){return {discordUserId,guildId,discordUsername:'synthetic_user',discordDisplayName:'Synthetic Member',interactionId:String(interaction++)};}
async function createLink(discordUserId=userId){const r=await bot(request(http).post('/v1/discord/link-sessions')).send(linkBody(discordUserId)).expect(201);return {...r.body,token:new URL(r.body.url).hash.slice(7)};}
const path=link=>`/v1/discord/link-sessions/${link.id}`;
async function confirm(link,user=member){return browser(request(http).post(`${path(link)}/web-confirm`),user).send({token:link.token,consent}).expect(200);}
async function claim(){return(await bot(request(http).post('/v1/discord/roles/claim')).send({guildId,limit:10}).expect(200)).body.jobs;}
function ack(job,outcome='applied'){return bot(request(http).post(`/v1/discord/roles/${job.id}/ack`)).send({leaseToken:job.leaseToken,version:job.version,outcome});}
async function makeDue(){await db.discordRoleState.updateMany({data:{nextAttemptAt:new Date(0)}});}
async function profile(user=member){return(await browser(request(http).get('/v1/me'),user,false).expect(200)).body;}
beforeEach(async()=>{
 app=await createApp();p=app.get(PassportService);db=p.db;http=app.getHttpServer();
 await db.$executeRawUnsafe('TRUNCATE TABLE "Subject", "DiscordIdentity", "DiscordLinkSession", "DiscordRoleState", "AuditEvent", "RosterMembership", "RosterSnapshot", "ConsumedUniversityToken", "PolicyEvent" RESTART IDENTITY CASCADE');
 const data={displayName:'Synthetic',identityProvider:'usaint',membershipStatus:'active',allowedServerIds:['lobby'],verifiedUntil:new Date(Date.now()+900000),universityVerifiedUntil:new Date(Date.now()+3600000)};
 const a=await db.subject.create({data:{...data,universityKey:studentKey('99990001',p.config.matchingSecret)}}),b=await db.subject.create({data:{...data,universityKey:studentKey('99990002',p.config.matchingSecret)}});
 const operator=await db.subject.create({data:{...data,universityKey:studentKey('99990003',p.config.matchingSecret)}});
 member=await session(a.id);other=await session(b.id);admin=await session(operator.id,ADMIN);await db.administrator.create({data:{subjectId:operator.id,enabled:true,role:'owner',totpSecret:''}});
 originalVerify=universityAdapter.verify;universityAdapter.verify=async input=>({provider:'ssu-usaint',studentNumber:input.sIdno,name:'Synthetic',department:'Test',academicStatus:'ENROLLED',courseLabel:'학사 / 1학기 재학',parserVersion:'ssu-main-student-v1',verifiedAt:new Date()});
});
afterEach(async()=>{universityAdapter.verify=originalVerify;await app.close();});

test('Discord bot credential is separate, guild-bound and replay-safe with only hashed capabilities stored',async()=>{
 const body=linkBody();await request(http).post('/v1/discord/link-sessions').send(body).expect(401);
 await request(http).post('/v1/discord/link-sessions').set('Authorization',`Bearer ${p.config.serviceToken}`).send(body).expect(401);
 await bot(request(http).get(`/v1/minecraft/policies/${randomUUID()}`)).expect(401);
 await bot(request(http).post('/v1/discord/link-sessions')).send({...body,guildId:'999'}).expect(403);
 const first=await bot(request(http).post('/v1/discord/link-sessions')).send(body).expect(201);
 const raw=new URL(first.body.url).hash.slice(7),stored=await db.discordLinkSession.findUnique({where:{id:first.body.id}});
 assert.equal(stored.tokenHash,hash(raw));assert.equal(stored.interactionHash,hash(body.interactionId));assert.ok(!JSON.stringify(stored).includes(raw));
 assert.equal((await bot(request(http).post('/v1/discord/link-sessions')).send(body).expect(409)).body.code,'discord_interaction_consumed');
 await createLink();assert.equal((await db.discordLinkSession.findUnique({where:{id:first.body.id}})).status,'cancelled');
});
test('Discord inspection requires browser binding, CSRF, exact token and a live request',async()=>{
 const link=await createLink();await browser(request(http).post(`${path(link)}/inspect`),member,false).send({token:link.token}).expect(403);
 await browser(request(http).post(`${path(link)}/inspect`),member).send({token:randomBytes(32).toString('base64url')}).expect(404);
 const seen=await browser(request(http).post(`${path(link)}/inspect`),member).send({token:link.token}).expect(200);assert.equal(seen.body.discordId,userId);assert.equal(seen.body.displayName,'Synthetic Member');assert.equal(seen.body.subjectId,undefined);
 await db.discordLinkSession.update({where:{id:link.id},data:{expiresAt:new Date(0)}});await browser(request(http).post(`${path(link)}/inspect`),member).send({token:link.token}).expect(410);
});
test('Discord linking requires explicit current consent and valid non-suspended school authentication',async()=>{
 const link=await createLink();const send=body=>browser(request(http).post(`${path(link)}/web-confirm`),member).send(body);
 assert.equal((await send({token:link.token}).expect(400)).body.code,'consent_required');
 await send({token:link.token,consent:{accepted:true,version:'old'}}).expect(409);
 for(const change of [{membershipStatus:'suspended'},{membershipStatus:'active',accessSuspended:true},{accessSuspended:false,universityVerifiedUntil:new Date(0)}]){await db.subject.update({where:{id:member.subjectId},data:change});assert.equal((await send({token:link.token,consent}).expect(403)).body.code,'school_verification_required');}
 assert.equal(await db.discordIdentity.count(),0);assert.equal(await db.consentReceipt.count(),0);
});
test('nonmembers may verify school identity without acquiring a membership role',async()=>{
 await db.serverRecord.create({data:{id:'campus_discord_test',commandName:'campus_discord_test',label:'Synthetic university server',enabled:true,accessMode:'university'}});
 try {
  await db.subject.update({where:{id:member.subjectId},data:{membershipStatus:'inactive',verifiedUntil:new Date(0)}});
  const allowed=(await browser(request(http).get('/v1/me/servers'),member,false).expect(200)).body.servers;
  assert.deepEqual(allowed.map(row=>row.id),['campus_discord_test']);
  await confirm(await createLink());const roles=await db.discordRoleState.findMany();assert.equal(roles.length,1);assert.equal(roles[0].kind,'verification');assert.equal(roles[0].desired,true);
 } finally {await db.serverRecord.delete({where:{id:'campus_discord_test'}});}
});
test('Discord completion is one-to-one and atomic with current consent, audit and durable role intent',async()=>{
 await db.subject.update({where:{id:member.subjectId},data:{discordId:userId,discordUpdatedAt:new Date()}});assert.equal((await profile()).discordConnection,null);
 const link=await createLink();const results=await Promise.all([browser(request(http).post(`${path(link)}/web-confirm`),member).send({token:link.token,consent}),browser(request(http).post(`${path(link)}/web-confirm`),member).send({token:link.token,consent})]);assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
 assert.equal(await db.discordIdentity.count({where:{subjectId:member.subjectId}}),1);assert.equal(await db.consentReceipt.count({where:{source:'discord_link',contextId:link.id,version:privacyNotice.version}}),1);assert.equal(await db.auditEvent.count({where:{action:'discord.linked'}}),1);assert.equal(await db.discordRoleState.count(),1);
 assert.equal((await profile()).discordConnection.roleStatus,'pending');assert.equal((await profile()).discordReference.verificationStatus,'self_reported');
 await bot(request(http).post('/v1/discord/link-sessions')).send(linkBody()).expect(409);
 const different=await createLink('200000000000000002');await browser(request(http).post(`${path(different)}/web-confirm`),member).send({token:different.token,consent}).expect(409);assert.equal(await db.discordIdentity.count(),1);
});
test('Discord role leases survive API recreation and reject replay while successful roles are periodically reconciled',async()=>{
 await confirm(await createLink());const [job]=await claim();assert.equal(job.desired,true);assert.equal(job.version,'1');assert.deepEqual(await claim(),[]);
 await app.close();app=await createApp();p=app.get(PassportService);db=p.db;http=app.getHttpServer();assert.deepEqual(await claim(),[]);
 await ack({...job,leaseToken:randomBytes(32).toString('base64url')}).expect(409);await ack(job).expect(204);await ack(job).expect(409);assert.equal((await profile()).discordConnection.roleStatus,'granted');
 await makeDue();const [next]=await claim();assert.equal(next.version,job.version);assert.notEqual(next.leaseToken,job.leaseToken);await ack(next).expect(204);
});
test('Different Discord links racing for one school subject leave exactly one identity receipt and role',async()=>{
 const links=[await createLink(),await createLink('200000000000000002')];
 const results=await Promise.all(links.map(link=>browser(request(http).post(`${path(link)}/web-confirm`),member).send({token:link.token,consent})));
 assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
 assert.equal(results.find(result=>result.status===409).body.code,'discord_already_linked');
 assert.equal(await db.discordIdentity.count({where:{subjectId:member.subjectId}}),1);
 assert.equal(await db.consentReceipt.count({where:{subjectId:member.subjectId,source:'discord_link'}}),1);
 assert.equal(await db.discordRoleState.count(),1);assert.equal(await db.auditEvent.count({where:{action:'discord.linked'}}),1);
});
test('Suspension fences an in-flight grant without stealing its lease and ignores Minecraft-only scope limits',async()=>{
 await confirm(await createLink());const [job]=await claim();
 await browser(request(http).put(`/v1/admin/members/${member.subjectId}/access`),admin).send({suspended:false,restricted:true,serverIds:[]}).expect(200);assert.equal((await db.discordRoleState.findUnique({where:{id:job.id}})).version,1n);
 await browser(request(http).put(`/v1/admin/members/${member.subjectId}/access`),admin).send({suspended:true,restricted:true,serverIds:[]}).expect(200);
 let row=await db.discordRoleState.findUnique({where:{id:job.id}});assert.equal(row.desired,false);assert.equal(row.version,2n);assert.equal(row.leaseHash,hash(job.leaseToken));assert.deepEqual(await claim(),[]);
 await ack(job).expect(409);const [revoke]=await claim();assert.equal(revoke.desired,false);assert.equal(revoke.version,'2');await ack(revoke).expect(204);assert.equal((await profile()).discordConnection.roleStatus,'revoked');
});
test('Roster loss preserves school verification, while school expiry rejects late grants and revokes',async()=>{
 await confirm(await createLink());let [job]=await claim();await ack(job).expect(204);
 const options={allowedServerIds:['lobby']};await applyRosterSnapshot(db,{entries:[{studentKey:studentKey('99990001',p.config.matchingSecret),status:'inactive',roleLabel:'',serverIds:[]}],sourceKey:'c'.repeat(64),fetchedAt:new Date()},options);
 await makeDue();[job]=await claim();assert.equal(job.desired,true);await ack(job).expect(204);
 await makeDue();[job]=await claim();assert.equal(job.desired,true);
 await db.subject.update({where:{id:member.subjectId},data:{universityVerifiedUntil:new Date(0)}});await ack(job).expect(409);[job]=await claim();assert.equal(job.desired,false);await ack(job,'member_absent').expect(204);
 assert.equal((await profile()).discordConnection.roleStatus,'revoked');
});
test('Role retries are bounded, safe-code-only and missing members do not appear granted',async()=>{
 await confirm(await createLink());let [job]=await claim();await ack(job).expect(204);await makeDue();[job]=await claim();await ack(job,'member_absent').expect(204);assert.equal((await profile()).discordConnection.roleStatus,'failed');
 let row=await db.discordRoleState.findUnique({where:{id:job.id}});assert.equal(row.lastError,'member_absent');assert.ok(row.nextAttemptAt>Date.now()+50000);
 await makeDue();[job]=await claim();await bot(request(http).post(`/v1/discord/roles/${job.id}/ack`)).send({leaseToken:job.leaseToken,version:job.version,outcome:'retry',error:'secret raw upstream error'}).expect(400);
 await ack(job,'configuration_error').expect(204);row=await db.discordRoleState.findUnique({where:{id:job.id}});assert.equal(row.lastError,'configuration_error');assert.ok(row.nextAttemptAt>Date.now()+290000);
 await makeDue();[job]=await claim();await ack(job,'retry').expect(204);row=await db.discordRoleState.findUnique({where:{id:job.id}});assert.equal(row.lastError,'retry');assert.ok(row.nextAttemptAt<=Date.now()+300000);
});
test('Grant leases stop at known school validity and expired leases cannot acknowledge or block recovery',async()=>{
 const until=new Date(Date.now()+30000);await db.subject.update({where:{id:member.subjectId},data:{universityVerifiedUntil:until}});
 await confirm(await createLink());const [job]=await claim();assert.equal(job.expiresAt,until.toISOString());
 await db.discordRoleState.update({where:{id:job.id},data:{leaseUntil:new Date(0)}});await ack(job).expect(409);
 const [next]=await claim();assert.notEqual(next.leaseToken,job.leaseToken);await ack(next).expect(204);
});
test('Administrator Discord unlink preserves Minecraft, cancels capabilities, revokes roles and leaves an audit trail',async()=>{
 const link=await createLink();await confirm(link);const minecraft=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'SyntheticGame',subjectId:member.subjectId}});
 await db.subject.update({where:{id:member.subjectId},data:{discordId:'123',discordUpdatedAt:new Date()}});
 await browser(request(http).delete(`/v1/admin/members/${member.subjectId}/discord`),member).expect(403);await browser(request(http).delete(`/v1/admin/members/${member.subjectId}/discord`),admin,false).expect(403);
 const list=(await browser(request(http).get('/v1/admin/members'),admin,false).expect(200)).body.members;assert.equal(list.find(x=>x.id===member.subjectId).discordConnection.discordId,userId);
 assert.deepEqual((await browser(request(http).delete(`/v1/admin/members/${member.subjectId}/discord`),admin).expect(200)).body,{unlinked:true});assert.equal((await profile()).discordConnection,null);assert.equal((await profile()).discordReference,null);assert.equal((await db.minecraftIdentity.findUnique({where:{uuid:minecraft.uuid}})).subjectId,member.subjectId);
 assert.equal((await db.discordRoleState.findFirst()).desired,false);assert.equal(await db.auditEvent.count({where:{action:'admin.discord_unlinked',actorSubjectId:admin.subjectId}}),1);await browser(request(http).post(`${path(link)}/inspect`),member).send({token:link.token}).expect(409);
 const newLink=await createLink();await confirm(newLink,other);assert.equal((await profile(other)).discordConnection.discordId,userId);
});
test('School callback confirms a Discord capability with rotated session and separate consent receipts',async()=>{
 const link=await createLink();const anon=await session(null);const options={allowedServerIds:['lobby']};await applyRosterSnapshot(db,{entries:[{studentKey:studentKey('99990001',p.config.matchingSecret),status:'active',roleLabel:'회원',serverIds:['lobby']}],sourceKey:'c'.repeat(64),fetchedAt:new Date()},options);
 const started=await browser(request(http).post('/v1/auth/university/start'),anon).send({discordLink:{id:link.id,token:link.token},consent}).expect(200);const callback=new URL(new URL(started.body.url).searchParams.get('apiReturnUrl'));
 const stored=await db.universityAuthRequest.findFirst();assert.ok(!stored.returnContext.includes(link.token));
 const result=await browser(request(http).get(callback.pathname),anon,false).query({sIdno:'99990001',sToken:'synthetic-'+randomBytes(24).toString('hex')}).expect(303);assert.equal(result.headers.location,`/discord/link/${link.id}#token=${link.token}`);
 const fresh={...anon,cookie:result.headers['set-cookie'][0].split(';')[0]};assert.notEqual(fresh.cookie,anon.cookie);const me=(await browser(request(http).get('/v1/me'),fresh,false).expect(200)).body;assert.equal(me.discordConnection.discordId,userId);assert.equal(await db.consentReceipt.count({where:{source:'portal_login'}}),1);assert.equal(await db.consentReceipt.count({where:{source:'discord_link'}}),1);
});
test('Expired Discord completion preserves successful school login and returns only a safe error',async()=>{
 const link=await createLink();const anon=await session(null);const started=await browser(request(http).post('/v1/auth/university/start'),anon).send({discordLink:{id:link.id,token:link.token},consent}).expect(200);const callback=new URL(new URL(started.body.url).searchParams.get('apiReturnUrl'));
 await db.discordLinkSession.update({where:{id:link.id},data:{expiresAt:new Date(0)}});
 const result=await browser(request(http).get(callback.pathname),anon,false).query({sIdno:'99990001',sToken:'synthetic-'+randomBytes(24).toString('hex')}).expect(303);assert.equal(result.headers.location,`/discord/link/${link.id}?discord_link_error=discord_link_expired#token=${link.token}`);
 await browser(request(http).get('/v1/me'),{...anon,cookie:result.headers['set-cookie'][0].split(';')[0]},false).expect(200);assert.equal(await db.discordIdentity.count(),0);
});
