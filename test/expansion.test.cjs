const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
const raw=process.env.TEST_DATABASE_URL;
if(!raw||!new URL(raw).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
const url=new URL(raw);url.searchParams.set('schema','expansion_test');
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
const count={playSeconds:60,blocksBroken:8,blocksPlaced:3,damageTakenMilli:4500,deaths:1,mobKills:2};
function batch(minecraft,changes={}){return{id:randomUUID(),serverId:'lobby',records:[{minecraftUuid:minecraft.uuid,epoch:minecraft.telemetryEpoch,...count}],...changes};}
function submit(input,status=200){return service(request(http).post('/v1/minecraft/stats/batches')).send(input).expect(status);}
function policy(uuid){return service(request(http).get(`/v1/minecraft/policies/${uuid}`)).expect(200);}
beforeEach(async()=>{
 app=await createApp();p=app.get(PassportService);db=p.db;http=app.getHttpServer();
 await db.$executeRawUnsafe('TRUNCATE TABLE "Subject", "MinecraftIdentity", "DiscordIdentity", "DiscordLinkSession", "AuditEvent", "RosterMembership", "RosterSnapshot", "PolicyEvent", "PlayerPresence", "ActivityBatch" RESTART IDENTITY CASCADE');
 const actor=await subject({displayName:'관리자검증'});await db.administrator.create({data:{subjectId:actor.id,enabled:true,totpSecret:''}});admin=await session(actor,'admin.example.test');
});
afterEach(async()=>{await app.close();});

test('member search combines exact HMAC school ID, names, IGN and Discord without returning raw IDs',async()=>{
 const a=await linked({displayName:'가상학생',universityKey:studentKey('99990001',p.config.matchingSecret)});
 await db.discordIdentity.create({data:{discordUserId:'200000000000000011',guildId:p.config.discord.guildId,username:'unified_search',displayName:'연동검색',subjectId:a.owner.id,verifiedAt:new Date()}});
 for(const q of ['가상','SyntheticIGN','unified_search','연동검색','200000000000000011','99990001']){
  const response=(await browser(request(http).get('/v1/admin/members').query({q})).expect(200)).body;assert.equal(response.total,1);assert.equal(response.members[0].id,a.owner.id);assert.match(response.members[0].revision,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(response).includes('99990001'));assert.ok(!JSON.stringify(response).includes(a.owner.universityKey));
 }
 assert.equal((await browser(request(http).get('/v1/admin/members').query({q:'99990002'})).expect(200)).body.total,0);
 await browser(request(http).get('/v1/admin/members').query({q:'x'.repeat(129)})).expect(400);
 await browser(request(http).get('/v1/admin/members'),a.portal).expect(403);
});
test('member filters use effective membership and cursor binds sorting, filter, limit and signature',async()=>{
 await subject({displayName:'A',membershipStatus:'active',verifiedUntil:new Date(0)});await subject({displayName:'B',membershipStatus:'inactive'});await subject({displayName:'C',accessSuspended:true});await subject({displayName:'D',membershipStatus:'suspended'});
 const totals={active:1,inactive:2,suspended:2,all:5};for(const[membership,total]of Object.entries(totals))assert.equal((await browser(request(http).get('/v1/admin/members').query({membership})).expect(200)).body.total,total);
 const page=(await browser(request(http).get('/v1/admin/members').query({limit:2,sort:'name'})).expect(200)).body;assert.equal(page.members.length,2);assert.ok(page.nextCursor);
 const next=(await browser(request(http).get('/v1/admin/members').query({limit:2,sort:'name',cursor:page.nextCursor})).expect(200)).body;assert.ok(next.members.every(row=>!page.members.some(old=>old.id===row.id)));
 for(const change of [{sort:'oldest'},{limit:3},{q:'A'},{cursor:page.nextCursor+'tampered'}])await browser(request(http).get('/v1/admin/members').query({limit:2,sort:'name',cursor:page.nextCursor,...change})).expect(400);
});
test('deletion requires CSRF, exact confirmation/current revision and protects own and last administrator',async()=>{
 const owner=await subject();const input={expectedRevision:await revision(owner.id),confirmation:owner.displayName};
 await browser(request(http).delete(`/v1/admin/members/${owner.id}`)).send(input).expect(403);
 assert.equal((await remove(owner,{confirmation:'wrong'},admin,400)).body.code,'confirmation_mismatch');
 await db.subject.update({where:{id:owner.id},data:{accessSuspended:true}});assert.equal((await remove(owner,{expectedRevision:input.expectedRevision},admin,409)).body.code,'subject_changed');
 assert.equal((await remove(admin.subject,{},admin,409)).body.code,'cannot_delete_self');
 await assert.rejects(()=>eraseSubject(p,admin.subject.id,{expectedRevision:input.expectedRevision,confirmation:admin.subject.displayName},null),error=>error.getResponse().code==='last_administrator');
 assert.ok(await db.subject.findUnique({where:{id:owner.id}}));
});
test('deleting account atomically erases personal records/statistics, preserves roster and fences Minecraft versions and old batches',async()=>{
 const a=await linked({universityKey:studentKey('99990001',p.config.matchingSecret)});const input=batch(a.minecraft);await submit(input);
 await db.rosterSnapshot.create({data:{id:'current',sourceKey:'fixture',digest:'fixture',fetchedAt:new Date(),expiresAt:new Date(Date.now()+900000),entryCount:1}});await db.rosterMembership.create({data:{studentKey:a.owner.universityKey,status:'active',roleLabel:'member',serverIds:['lobby'],snapshotId:'current'}});
 await db.serverRecord.update({where:{id:'lobby'},data:{allowedSubjectIds:[a.owner.id]}});
 await db.playerPresence.create({data:{minecraftUuid:a.minecraft.uuid,serverId:'lobby',observedAt:new Date(),expiresAt:new Date(Date.now()+90000)}});
 await remove(a.owner);
 assert.equal(await db.subject.findUnique({where:{id:a.owner.id}}),null);assert.equal(await db.webSession.count({where:{subjectId:a.owner.id}}),0);assert.equal(await db.consentReceipt.count({where:{subjectId:a.owner.id}}),0);assert.equal(await db.activityTotal.count(),0);assert.equal(await db.activityGeneration.count(),0);assert.equal(await db.playerPresence.count(),0);assert.equal(await db.rosterMembership.count(),1);
 assert.deepEqual((await db.serverRecord.findUnique({where:{id:'lobby'}})).allowedSubjectIds,[]);
 const tombstone=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});assert.equal(tombstone.subjectId,null);assert.equal(tombstone.name,'');assert.ok(tombstone.policyVersion>a.minecraft.policyVersion);assert.notEqual(tombstone.telemetryEpoch,a.minecraft.telemetryEpoch);
 assert.equal((await submit(input)).body.duplicate,true);assert.equal((await submit({...input,id:randomUUID()})).body.ignored,1);assert.equal(await db.activityTotal.count(),0);
 assert.equal((await browser(request(http).get('/v1/me'),a.portal).expect(401)).body.code,'session_required');
 const audit=await db.auditEvent.findFirst({where:{action:'admin.subject_deleted'}});assert.equal(audit.subjectId,null);assert.equal(audit.actorSubjectId,admin.subject.id);assert.ok(!JSON.stringify(audit).includes(a.owner.universityKey));
});
test('deleted Discord account retains only revocation jobs until matching role and nickname acknowledgments finish',async()=>{
 const owner=await subject();await consent(owner.id);const discordUserId='200000000000000013';
 await db.discordGuildSettings.update({where:{guildId:p.config.discord.guildId},data:{nicknameEnabled:true}});
 await db.discordIdentity.create({data:{discordUserId,guildId:p.config.discord.guildId,username:'private',displayName:'private display',subjectId:owner.id,verifiedAt:new Date()}});
 await policyTransaction(db,tx=>projectDiscordIdentity(tx,discordUserId));await remove(owner);
 let orphan=await db.discordIdentity.findUnique({where:{discordUserId},include:{roles:true,nicknames:true}});assert.equal(orphan.subjectId,null);assert.equal(orphan.username,'');assert.equal(orphan.displayName,'');assert.equal(orphan.eraseWhenRevoked,true);assert.ok(orphan.roles.every(role=>!role.desired));assert.ok(orphan.nicknames.every(nick=>nick.nickname===null));
 await purgeRevokedDeletedAccounts(p);assert.ok(await db.discordIdentity.findUnique({where:{discordUserId}}));
 for(const role of orphan.roles)await db.discordRoleState.update({where:{id:role.id},data:{appliedDesired:false,appliedVersion:role.version,leaseUntil:null}});for(const nick of orphan.nicknames)await db.discordNicknameState.update({where:{id:nick.id},data:{appliedNickname:null,appliedVersion:nick.version,leaseUntil:null}});
 await purgeRevokedDeletedAccounts(p);assert.equal(await db.discordIdentity.findUnique({where:{discordUserId}}),null);
});
test('old Discord consent remains valid while expanded game identity and collection require new explicit consent',async()=>{
 const owner=await subject({displayName:'검증학생님 환영합니다',admissionYear:'26'});await consent(owner.id,'2026-10-01.3');const minecraft=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'LegacyIGN',subjectId:owner.id}}),portal=await session(owner);
 assert.equal(await managementConsent(db,owner.id),true);let result=(await policy(minecraft.uuid)).body;assert.equal(result.status,'active');assert.equal(result.display.displayName,'');assert.equal(result.display.member,false);assert.equal(result.display.admissionYear,null);assert.deepEqual(result.telemetry,{enabled:false,epoch:null});
 await browser(request(http).post('/v1/me/privacy/consent'),portal,true).send({consent:{accepted:true,version:privacyNotice.version}}).expect(200);
 result=(await policy(minecraft.uuid)).body;assert.equal(result.display.displayName,'검증학생');assert.equal(result.display.admissionYear,'26');assert.equal(result.display.member,true);assert.equal(result.telemetry.enabled,true);assert.equal(result.telemetry.epoch,minecraft.telemetryEpoch);assert.deepEqual(result.allowedServers.map(s=>s.id),result.allowedServerIds);
 await browser(request(http).post('/v1/me/privacy/consent'),portal,true).send({consent:{accepted:true,version:privacyNotice.version}}).expect(200);assert.equal(await db.consentReceipt.count({where:{subjectId:owner.id,version:privacyNotice.version}}),1);
});
test('presence validates service credential and time, expires, and ignores older server snapshots',async()=>{
 const a=await linked(),observedAt=new Date().toISOString();const input={serverId:'lobby',players:[a.minecraft.uuid],observedAt};
 await request(http).post('/v1/minecraft/presence').send(input).expect(401);
 await service(request(http).post('/v1/minecraft/presence')).send({...input,observedAt:new Date(Date.now()-60000).toISOString()}).expect(400);
 await service(request(http).post('/v1/minecraft/presence')).send(input).expect(200);
 let result=(await service(request(http).get('/v1/minecraft/players').query({query:a.minecraft.name})).expect(200)).body.players[0];assert.equal(result.online,true);assert.equal(result.serverId,'lobby');
 await service(request(http).post('/v1/minecraft/presence')).send({...input,players:[],observedAt:new Date(Date.parse(observedAt)-1000).toISOString()}).expect(200);assert.equal(await db.playerPresence.count(),1);
 await db.playerPresence.update({where:{minecraftUuid:a.minecraft.uuid},data:{expiresAt:new Date(0)}});result=(await service(request(http).get('/v1/minecraft/players').query({query:a.minecraft.uuid})).expect(200)).body.players[0];assert.equal(result.online,false);assert.equal(result.serverId,null);
 await request(http).get('/v1/minecraft/players').query({query:a.minecraft.name}).expect(401);
});
test('activity batches authenticate, deduplicate concurrently and reject mutated retries without double counting',async()=>{
 const a=await linked(),input=batch(a.minecraft);
 await request(http).post('/v1/minecraft/stats/batches').send(input).expect(401);
 const results=await Promise.all([submit(input),submit(input),submit(input)]);assert.equal(results.filter(r=>!r.body.duplicate).length,1);
 const stats=(await browser(request(http).get('/v1/me/stats'),a.portal).expect(200)).body;assert.deepEqual(stats.totals,count);assert.equal(stats.servers[0].serverId,'lobby');
 assert.equal((await submit({...input,records:[{...input.records[0],playSeconds:61}]},409)).body.code,'statistics_batch_conflict');
 assert.deepEqual((await browser(request(http).get('/v1/me/stats'),a.portal).expect(200)).body.totals,count);
 await submit(batch(a.minecraft,{records:[{...input.records[0],playSeconds:-1}]}),400);await submit(batch(a.minecraft,{records:[{...input.records[0],playSeconds:2147483648}]}),400);
});
test('activity ignores wrong epochs, revoked access and missing consent; unlink rotates epoch and prevents replay after relink',async()=>{
 const a=await linked();for(const input of [batch(a.minecraft,{records:[{minecraftUuid:a.minecraft.uuid,epoch:randomUUID(),...count}]}),batch({...a.minecraft,uuid:randomUUID()})])assert.equal((await submit(input)).body.ignored,1);
 await db.subject.update({where:{id:a.owner.id},data:{accessSuspended:true}});assert.equal((await submit(batch(a.minecraft))).body.ignored,1);await db.subject.update({where:{id:a.owner.id},data:{accessSuspended:false}});
 await db.consentReceipt.deleteMany({where:{subjectId:a.owner.id}});assert.equal((await submit(batch(a.minecraft))).body.ignored,1);await consent(a.owner.id);
 await browser(request(http).delete(`/v1/admin/members/${a.owner.id}/minecraft`),admin,true).expect(200);const newer=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});assert.notEqual(newer.telemetryEpoch,a.minecraft.telemetryEpoch);
 await db.minecraftIdentity.update({where:{uuid:newer.uuid},data:{subjectId:a.owner.id}});assert.equal((await submit(batch(a.minecraft))).body.ignored,1);assert.equal((await submit(batch(newer))).body.received,1);
});
test('statistics are owner or administrator only and unauthorized server labels are absent',async()=>{
 const a=await linked(),b=await linked({displayName:'다른회원'});await submit(batch(a.minecraft));await submit(batch(b.minecraft));
 await request(http).get('/v1/me/stats').set('Host','portal.example.test').expect(401);await request(http).get('/v1/public/stats').expect(404);
 await browser(request(http).get(`/v1/admin/members/${a.owner.id}/stats`),b.portal).expect(403);
 assert.deepEqual((await browser(request(http).get('/v1/me/stats'),b.portal).expect(200)).body.totals,count);
 const aggregate=(await browser(request(http).get('/v1/admin/stats')).expect(200)).body;assert.equal(aggregate.totals.playSeconds,120);assert.equal(aggregate.playerCount,2);assert.ok(!JSON.stringify(aggregate).includes(a.owner.displayName));
 await db.subject.update({where:{id:a.owner.id},data:{scopeRestricted:true,scopeLimit:[]}});const hidden=(await browser(request(http).get('/v1/me/stats'),a.portal).expect(200)).body;assert.equal(hidden.servers.length,0);assert.equal(hidden.totals.playSeconds,60);
});

test('database rejects unknown consent sources and malformed admission-year hints',async()=>{
 const owner=await subject();await assert.rejects(()=>db.consentReceipt.create({data:{subjectId:owner.id,version:privacyNotice.version,source:'invented',contextId:randomUUID(),acceptedAt:new Date()}}));await assert.rejects(()=>db.subject.update({where:{id:owner.id},data:{admissionYear:'XX'}}));assert.equal((await db.subject.findUnique({where:{id:owner.id}})).admissionYear,null);
});

test('web member rows and private statistics expose current presence with per-server totals and scope hiding',async()=>{
 const a=await linked(),b=await linked({displayName:'별도회원'});await db.subject.update({where:{id:b.owner.id},data:{allowedServerIds:['survival']}});
 for(const[identity,serverId]of[[a.minecraft,'lobby'],[b.minecraft,'survival']])await service(request(http).post('/v1/minecraft/presence')).send({serverId,observedAt:new Date().toISOString(),players:[identity.uuid]}).expect(200);
 const listed=(await browser(request(http).get('/v1/admin/members').query({q:a.minecraft.name})).expect(200)).body.members.find(row=>row.id===a.owner.id);assert.equal(listed.presence.online,true);assert.equal(listed.presence.serverId,'lobby');assert.ok(listed.presence.serverLabel);assert.ok(listed.presence.lastSeenAt);
 const own=(await browser(request(http).get('/v1/me/stats'),a.portal).expect(200)).body;assert.equal(own.presence.online,true);assert.equal(own.presence.serverId,'lobby');assert.deepEqual(own.servers.map(row=>row.serverId),['lobby']);assert.equal(own.servers[0].onlinePlayerCount,1);
 const all=(await browser(request(http).get('/v1/admin/stats')).expect(200)).body;assert.equal(all.onlinePlayerCount,2);assert.equal(all.servers.find(row=>row.serverId==='lobby').onlinePlayerCount,1);assert.equal(all.servers.find(row=>row.serverId==='survival').onlinePlayerCount,1);assert.equal(all.totals.playSeconds,0);
 await db.subject.update({where:{id:a.owner.id},data:{scopeRestricted:true,scopeLimit:[]}});const hidden=(await browser(request(http).get('/v1/me/stats'),a.portal).expect(200)).body;assert.deepEqual(hidden.presence,{online:false,serverId:null,serverLabel:null,lastSeenAt:null});assert.equal(hidden.servers.length,0);
 const adminDetail=(await browser(request(http).get(`/v1/admin/members/${a.owner.id}/stats`)).expect(200)).body;assert.equal(adminDetail.presence.online,true);assert.equal(adminDetail.presence.serverId,'lobby');
 await db.playerPresence.updateMany({data:{expiresAt:new Date(0)}});assert.equal((await browser(request(http).get('/v1/admin/stats')).expect(200)).body.onlinePlayerCount,0);
});

test('previous .4 game and Discord permissions survive .5 notice, while renewal records .5 exactly once',async()=>{
 const a=await linked();await db.consentReceipt.updateMany({where:{subjectId:a.owner.id},data:{version:'2026-10-01.4'}});
 assert.equal((await policy(a.minecraft.uuid)).body.telemetry.enabled,true);assert.equal(await managementConsent(db,a.owner.id),true);
 const before=(await browser(request(http).get('/v1/me'),a.portal).expect(200)).body;assert.equal(before.privacyConsent.accepted,false);
 for(let i=0;i<2;i++)await browser(request(http).post('/v1/me/privacy/consent'),a.portal,true).send({consent:{accepted:true,version:privacyNotice.version}}).expect(200);
 assert.equal(await db.consentReceipt.count({where:{subjectId:a.owner.id,version:privacyNotice.version}}),1);
 assert.equal((await browser(request(http).get('/v1/me'),a.portal).expect(200)).body.studentId,null);
});

test('semester expiry migration is idempotent, preserves expired identities and updates game and Discord projections atomically',async()=>{
 const {migrateSchoolVerificationExpiry}=require('../dist/school-expiry');
 await db.subject.update({where:{id:admin.subject.id},data:{universityExpiryPolicyVersion:1}});
 const now=new Date('2026-10-01T10:00:00Z'),verifiedAt=new Date('2026-10-01T00:00:00Z'),old=new Date('2027-03-30T00:00:00Z');
 const a=await linked({universityVerifiedAt:verifiedAt,universityVerifiedUntil:old});
 const expired=await subject({universityVerifiedAt:verifiedAt,universityVerifiedUntil:new Date('2026-10-01T01:00:00Z')});
 const missing=await subject({universityVerifiedAt:verifiedAt,universityVerifiedUntil:null});
 const stale=await linked({universityVerifiedAt:new Date('2026-08-01T00:00:00Z'),universityVerifiedUntil:new Date('2027-01-28T00:00:00Z')});
 const discordUserId='200000000000000077';await db.discordIdentity.create({data:{discordUserId,guildId:p.config.discord.guildId,username:'expiry_fixture',subjectId:a.owner.id,verifiedAt}});
 await policyTransaction(db,tx=>projectDiscordIdentity(tx,discordUserId,now));
 const dry=await migrateSchoolVerificationExpiry(db,false,now);assert.equal(dry.changed,2);
 assert.equal((await db.subject.findUnique({where:{id:a.owner.id}})).universityVerifiedUntil.toISOString(),old.toISOString());
 const first=await migrateSchoolVerificationExpiry(db,true,now);assert.equal(first.changed,2);assert.equal(first.expiredPreserved,1);
 const after=await db.subject.findUnique({where:{id:a.owner.id}});assert.equal(after.universityVerifiedUntil.toISOString(),'2027-02-28T15:00:00.000Z');assert.equal(after.studentIdCiphertext,null);
 assert.equal((await db.subject.findUnique({where:{id:expired.id}})).universityVerifiedUntil.toISOString(),'2026-10-01T01:00:00.000Z');
 assert.equal((await db.subject.findUnique({where:{id:missing.id}})).universityVerifiedUntil,null);
 assert.equal((await db.subject.findUnique({where:{id:stale.owner.id}})).universityVerifiedUntil.toISOString(),'2026-08-31T15:00:00.000Z');
 const game=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});assert.equal(game.policyVersion,a.minecraft.policyVersion+1);assert.equal(game.policyFingerprint,'');
 const event=await db.policyEvent.findFirst({where:{minecraftUuid:game.uuid},orderBy:{id:'desc'}});assert.equal(event.policyVersion,game.policyVersion);
 const role=await db.discordRoleState.findFirst({where:{discordUserId,kind:'verification'}});assert.equal(role.validUntil.toISOString(),after.universityVerifiedUntil.toISOString());assert.equal(role.desired,true);
 const events=await db.policyEvent.count();assert.deepEqual(await migrateSchoolVerificationExpiry(db,true,now),{candidates:0,changed:0,marked:0,expiredPreserved:0,applied:true});assert.equal(await db.policyEvent.count(),events);
});

test('erasing an account removes its encrypted student ID and never puts it in an audit record',async()=>{
 const {sealStudentId}=require('../dist/school-identity');const key=studentKey('99998888',p.config.matchingSecret),cipher=sealStudentId('99998888',key,p.config.encryptionKey);
 const a=await linked({universityKey:key,studentIdCiphertext:cipher});await remove(a.owner);
 assert.equal(await db.subject.count({where:{studentIdCiphertext:cipher}}),0);
 const audit=JSON.stringify(await db.auditEvent.findMany());assert.ok(!audit.includes(cipher));assert.ok(!audit.includes('99998888'));
});
