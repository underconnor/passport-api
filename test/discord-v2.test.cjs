const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL required');
const url=new URL(process.env.TEST_DATABASE_URL);if(!url.pathname.endsWith('_test'))throw new Error('Dedicated test DB required');url.searchParams.set('schema','discord_v2_test');
Object.assign(process.env,{DATABASE_URL:url.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',API_SERVICE_TOKEN:'minecraft-test-'.repeat(4),PASSPORT_DISCORD_SERVICE_TOKEN:'discord-test-'.repeat(4),DISCORD_GUILD_ID:'100000000000000001',DISCORD_MEMBER_ROLE_ID:'100000000000000002',SESSION_SECRET:'session-test-'.repeat(4),ROSTER_MATCHING_SECRET:'roster-test-'.repeat(4),DATA_ENCRYPTION_KEY:'ab'.repeat(32),ADMIN_MFA_REQUIRED:'false',SHEETS_SYNC_ENABLED:'false'});
const {createApp}=require('../dist/app'),{PassportService}=require('../dist/passport.service');
const {hash,csrf}=require('../dist/security'),{privacyNotice}=require('../dist/privacy');
const {policyTransaction}=require('../dist/database');
const {refreshDiscordSubject,projectDiscordIdentity}=require('../dist/discord-policy');
const {seedDiscordSettings}=require('../dist/discord-management');
const {applyRosterSnapshot}=require('../dist/membership-sync');
const {studentKey}=require('../dist/integrations/sheets');
const guildId=process.env.DISCORD_GUILD_ID,verificationRoleId=process.env.DISCORD_MEMBER_ROLE_ID;
const memberRoleId='100000000000000003',semesterRole='100000000000000004',nextSemesterRole='100000000000000005',replacementRole='100000000000000006';
const discordUserId='200000000000000001',consent={accepted:true,version:privacyNotice.version};
let app,p,db,http,member,admin,interaction=300000000000000001n;
function bot(req){return req.set('Authorization',`Bearer ${process.env.PASSPORT_DISCORD_SERVICE_TOKEN}`);}
function browser(req,user=member,mutate=true){req=req.set('Host',user.host).set('Cookie',user.cookie);return mutate?req.set('Origin',`https://${user.host}`).set('X-CSRF-Token',user.csrf):req;}
async function session(subjectId,host='portal.example.test'){const token=randomBytes(32).toString('base64url');await db.webSession.create({data:{tokenHash:hash(token),subjectId,audienceHost:host,expiresAt:new Date(Date.now()+3600000)}});return {subjectId,host,cookie:`__Host-passport_${host.startsWith('admin')?'admin':'portal'}_session=${token}`,csrf:csrf(p.config.sessionSecret,token)};}
async function currentSettings(){return(await browser(request(http).get('/v1/admin/discord'),admin,false).expect(200)).body.settings;}
async function configure(changes={}){const old=await currentSettings();return(await browser(request(http).put('/v1/admin/discord'),admin).send({memberRoleId:old.memberRoleId,currentSemester:old.currentSemester,semesterRoles:old.semesterRoles,nicknameEnabled:old.nicknameEnabled,...changes,expectedRevision:old.revision}).expect(200)).body.settings;}
async function complete(){const made=(await bot(request(http).post('/v1/discord/link-sessions')).send({discordUserId,guildId,discordUsername:'synthetic',discordDisplayName:'Synthetic',interactionId:String(interaction++)}).expect(201)).body;await browser(request(http).post(`/v1/discord/link-sessions/${made.id}/web-confirm`)).send({token:new URL(made.url).hash.slice(7),consent}).expect(200);}
async function claim(kind='roles',limit=20){const config=(await bot(request(http).get('/v2/discord/config')).expect(200)).body;const result=await bot(request(http).post(`/v2/discord/${kind}/claim`)).send({contractVersion:2,guildId,settingsRevision:config.settingsRevision,limit}).expect(200);assert.equal(result.body.contractVersion,2);return result.body.jobs;}
function ack(job,outcome='applied',kind='roles'){return bot(request(http).post(`/v2/discord/${kind}/${job.id}/ack`)).send({contractVersion:2,leaseToken:job.leaseToken,version:job.version,outcome});}
async function due(){await db.discordRoleState.updateMany({data:{nextAttemptAt:new Date(0)}});await db.discordNicknameState.updateMany({data:{nextAttemptAt:new Date(0)}});}
async function refresh(){await policyTransaction(db,tx=>refreshDiscordSubject(tx,member.subjectId));}
async function profile(){return(await browser(request(http).get('/v1/me'),member,false).expect(200)).body.discordConnection;}
async function fullSettings(){return configure({memberRoleId,currentSemester:'26-2',semesterRoles:[{semester:'26-2',roleId:semesterRole}],nicknameEnabled:true});}
async function appliedRoles(){for(const job of await claim())await ack(job).expect(204);}
beforeEach(async()=>{
 app=await createApp();p=app.get(PassportService);db=p.db;http=app.getHttpServer();
 await db.$executeRawUnsafe('TRUNCATE TABLE "Subject", "DiscordIdentity", "DiscordLinkSession", "DiscordGuildSettings", "AuditEvent", "RosterMembership", "RosterSnapshot", "PolicyEvent" RESTART IDENTITY CASCADE');await seedDiscordSettings(db,p.config.discord);
 const subject=await db.subject.create({data:{displayName:'김학생',identityProvider:'usaint',universityKey:studentKey('99990001',p.config.matchingSecret),membershipStatus:'active',allowedServerIds:['lobby'],verifiedUntil:new Date(Date.now()+900000),universityVerifiedUntil:new Date(Date.now()+3600000)}});
 member=await session(subject.id);admin=await session(subject.id,'admin.example.test');await db.administrator.create({data:{subjectId:subject.id,enabled:true,totpSecret:''}});
});
afterEach(async()=>{await app.close();});

test('Discord settings require admin host, CSRF, current school login and optimistic revision',async()=>{
 await browser(request(http).get('/v1/admin/discord'),member,false).expect(403);
 const initial=await currentSettings();assert.equal(initial.verificationRoleId,verificationRoleId);assert.equal(initial.memberRoleId,null);
 const input={memberRoleId,currentSemester:'26-2',semesterRoles:[{semester:'26-2',roleId:semesterRole}],nicknameEnabled:true,expectedRevision:initial.revision};
 await browser(request(http).put('/v1/admin/discord'),admin,false).send(input).expect(403);
 for(const change of [{memberRoleId:guildId},{memberRoleId:verificationRoleId},{currentSemester:'27-1'},{semesterRoles:[{semester:'26-2',roleId:semesterRole},{semester:'26-2',roleId:nextSemesterRole}]},{expectedRevision:'01'},{unexpected:'secret'}])await browser(request(http).put('/v1/admin/discord'),admin).send({...input,...change}).expect(400);
 const changed=await fullSettings();assert.equal(changed.revision,'2');await seedDiscordSettings(db,p.config.discord);assert.deepEqual(await currentSettings(),changed);
 assert.equal((await browser(request(http).put('/v1/admin/discord'),admin).send(input).expect(409)).body.code,'discord_settings_changed');
 await browser(request(http).post('/v1/admin/discord/reconcile'),admin).send({expectedRevision:'1'}).expect(409);
 await browser(request(http).post('/v1/admin/discord/reconcile'),admin).send({expectedRevision:'2'}).expect(200);
 assert.equal(await db.auditEvent.count({where:{action:'admin.discord_settings_changed'}}),1);assert.equal(await db.auditEvent.count({where:{action:'admin.discord_reconcile_requested'}}),1);
 await db.subject.update({where:{id:member.subjectId},data:{universityVerifiedUntil:new Date(0)}});await browser(request(http).get('/v1/admin/discord'),admin,false).expect(403);
});

test('V2 bot credentials, strict version and revision fence new jobs from legacy workers',async()=>{
 await fullSettings();await complete();const conf=(await bot(request(http).get('/v2/discord/config')).expect(200)).body;
 assert.deepEqual(conf,{contractVersion:2,settingsRevision:'2',guildId,managedRoleIds:[verificationRoleId,memberRoleId,semesterRole],nicknameEnabled:true});
 await request(http).get('/v2/discord/config').expect(401);await request(http).get('/v2/discord/config').set('Authorization',`Bearer ${p.config.serviceToken}`).expect(401);
 const input={contractVersion:2,guildId,settingsRevision:'2',limit:20};
 for(const change of [{contractVersion:1},{contractVersion:undefined},{limit:21},{settingsRevision:'0'}])await bot(request(http).post('/v2/discord/roles/claim')).send({...input,...change}).expect(400);
 await bot(request(http).post('/v2/discord/roles/claim')).send({...input,guildId:'999'}).expect(403);await bot(request(http).post('/v2/discord/roles/claim')).send({...input,settingsRevision:'1'}).expect(409);
 const legacy=(await bot(request(http).post('/v1/discord/roles/claim')).send({guildId,limit:20}).expect(200)).body.jobs;assert.equal(legacy.length,1);assert.equal(legacy[0].roleId,verificationRoleId);
 const jobs=await claim();assert.deepEqual(jobs.map(j=>j.kind).sort(),['member','semester']);
 for(const job of jobs){await bot(request(http).post(`/v1/discord/roles/${job.id}/ack`)).send({leaseToken:job.leaseToken,version:job.version,outcome:'applied'}).expect(404);await ack(job).expect(204);}
});

test('Valid-school nonmembers receive verification and a nickname but no current-member or semester grants',async()=>{
 await fullSettings();await db.subject.update({where:{id:member.subjectId},data:{membershipStatus:'inactive',verifiedUntil:new Date(0)}});await complete();
 const jobs=await claim();assert.equal(jobs.find(j=>j.kind==='verification').desired,true);assert.equal(jobs.find(j=>j.kind==='member').desired,false);assert.equal(jobs.some(j=>j.kind==='semester'),false);
 assert.equal((await claim('nicknames'))[0].nickname,'김학생');assert.equal(await db.membershipSemester.count(),0);
 const me=(await browser(request(http).get('/v1/me'),member,false).expect(200)).body;assert.equal(me.membership.effectiveStatus,'revoked');assert.deepEqual((await browser(request(http).get('/v1/me/servers'),member,false).expect(200)).body.servers,[]);
});

test('Current consent records verified membership evidence, while legacy consent renews idempotently with UUID receipts',async()=>{
 await fullSettings();await db.discordIdentity.create({data:{discordUserId,guildId,subjectId:member.subjectId,username:'synthetic',displayName:'Synthetic',verifiedAt:new Date()}});await db.consentReceipt.create({data:{subjectId:member.subjectId,source:'discord_link',contextId:randomUUID(),version:'2026-10-01.2',acceptedAt:new Date()}});await refresh();
 assert.equal(await db.membershipSemester.count(),0);assert.equal(await db.discordNicknameState.count(),0);assert.equal((await profile()).managementConsentRequired,true);
 assert.equal((await db.discordRoleState.findFirst({where:{kind:'verification'}})).desired,true);assert.equal((await db.discordRoleState.findFirst({where:{kind:'member'}})).desired,false);
 await browser(request(http).post('/v1/me/discord/consent'),member,false).send({consent}).expect(403);await browser(request(http).post('/v1/me/discord/consent')).send({consent:{accepted:true,version:'old'}}).expect(409);
 await Promise.all([1,2].map(()=>browser(request(http).post('/v1/me/discord/consent')).send({consent}).expect(200)));
 const receipts=await db.consentReceipt.findMany({where:{version:privacyNotice.version}});assert.equal(receipts.length,1);assert.match(receipts[0].contextId,/^[0-9a-f-]{36}$/);assert.equal(await db.membershipSemester.count(),1);assert.equal(await db.discordNicknameState.count(),1);assert.equal((await profile()).managementConsentRequired,false);
 const unverified=await db.subject.create({data:{universityKey:randomUUID(),displayName:'Synthetic',identityProvider:'development',membershipStatus:'active',verifiedUntil:new Date(Date.now()+900000)}});await db.consentReceipt.create({data:{subjectId:unverified.id,source:'portal_login',contextId:randomUUID(),version:privacyNotice.version,acceptedAt:new Date()}});await policyTransaction(db,tx=>refreshDiscordSubject(tx,unverified.id));assert.equal(await db.membershipSemester.count({where:{subjectId:unverified.id}}),0);
});

test('Leaving removes only the current-member role; rejoining a later explicit semester preserves accumulated terms',async()=>{
 await fullSettings();await complete();await appliedRoles();
 await applyRosterSnapshot(db,{entries:[{studentKey:studentKey('99990001',p.config.matchingSecret),status:'inactive',roleLabel:'',serverIds:[]}],sourceKey:'c'.repeat(64),fetchedAt:new Date()},{allowedServerIds:['lobby']});
 let roles=await db.discordRoleState.findMany();assert.equal(roles.find(r=>r.kind==='member').desired,false);assert.equal(roles.find(r=>r.kind==='verification').desired,true);assert.equal(roles.find(r=>r.kind==='semester').desired,true);
 await configure({currentSemester:'27-1',semesterRoles:[{semester:'26-2',roleId:semesterRole},{semester:'27-1',roleId:nextSemesterRole}]});assert.equal(await db.membershipSemester.count(),1);
 await applyRosterSnapshot(db,{entries:[{studentKey:studentKey('99990001',p.config.matchingSecret),status:'active',roleLabel:'회원',serverIds:['lobby']}],sourceKey:'c'.repeat(64),fetchedAt:new Date()},{allowedServerIds:['lobby']});
 assert.deepEqual((await profile()).membershipSemesters,['26-2','27-1']);roles=await db.discordRoleState.findMany();assert.equal(roles.filter(r=>r.kind==='semester'&&r.desired).length,2);assert.equal(roles.find(r=>r.kind==='member').desired,true);
});

test('School expiry, suspension and administrator unlink revoke all managed kinds while preserving evidence',async()=>{
 await fullSettings();await complete();await appliedRoles();const [nickname]=await claim('nicknames');await ack(nickname,'applied','nicknames').expect(204);
 await db.subject.update({where:{id:member.subjectId},data:{universityVerifiedUntil:new Date(0)}});await due();let jobs=await claim();assert.ok(jobs.every(j=>!j.desired));for(const job of jobs)await ack(job).expect(204);assert.equal((await claim('nicknames'))[0].nickname,null);
 await db.subject.update({where:{id:member.subjectId},data:{universityVerifiedUntil:new Date(Date.now()+3600000)}});await refresh();
 await browser(request(http).put(`/v1/admin/members/${member.subjectId}/access`),admin).send({suspended:true,restricted:false,serverIds:[]}).expect(200);assert.equal(await db.discordRoleState.count({where:{desired:true}}),0);
 await browser(request(http).put(`/v1/admin/members/${member.subjectId}/access`),admin).send({suspended:false,restricted:false,serverIds:[]}).expect(200);assert.equal(await db.discordRoleState.count({where:{desired:true}}),3);
 await browser(request(http).delete(`/v1/admin/members/${member.subjectId}/discord`),admin).expect(200);assert.equal(await db.discordRoleState.count({where:{desired:true}}),0);assert.equal(await db.membershipSemester.count(),1);assert.equal((await db.discordNicknameState.findFirst()).nickname,null);
 await complete();assert.deepEqual((await profile()).membershipSemesters,['26-2']);
});

test('Role replacement revokes its previous target before granting and exposes one current semester status',async()=>{
 await fullSettings();await complete();await appliedRoles();await configure({semesterRoles:[{semester:'26-2',roleId:replacementRole}]});
 const config=(await bot(request(http).get('/v2/discord/config')).expect(200)).body;assert.ok(config.managedRoleIds.includes(semesterRole));assert.ok(config.managedRoleIds.includes(replacementRole));
 let jobs=await claim();const revoke=jobs.find(j=>j.roleId===semesterRole);assert.ok(revoke&&!revoke.desired);assert.equal(jobs.some(j=>j.roleId===replacementRole),false);for(const job of jobs)await ack(job).expect(204);
 await db.discordRoleState.updateMany({where:{roleId:replacementRole},data:{nextAttemptAt:new Date(0)}});jobs=await claim();assert.equal(jobs.find(j=>j.roleId===replacementRole).desired,true);for(const job of jobs)await ack(job).expect(204);
 assert.deepEqual((await profile()).roles.semesters.map(r=>r.semester),['26-2']);
 const settings=await currentSettings();await browser(request(http).put('/v1/admin/discord'),admin).send({memberRoleId:semesterRole,currentSemester:settings.currentSemester,semesterRoles:settings.semesterRoles,nicknameEnabled:true,expectedRevision:settings.revision}).expect(400);
});

test('Minecraft completion and unlink update nicknames, while hierarchy failure leaves roles successful',async()=>{
 await fullSettings();await complete();await appliedRoles();let [nick]=await claim('nicknames');await ack(nick,'not_manageable','nicknames').expect(204);
 let state=await profile();assert.equal(state.roleStatus,'granted');assert.equal(state.nickname.status,'failed');assert.equal(state.nickname.lastError,'not_manageable');
 const mc={minecraftUuid:randomUUID(),minecraftName:'A',gameSessionId:randomUUID()},service=req=>req.set('Authorization',`Bearer ${p.config.serviceToken}`);
 const made=(await service(request(http).post('/v1/link-sessions')).send(mc).expect(201)).body;
 await browser(request(http).post(`/v1/link-sessions/${made.id}/web-confirm`)).send({token:new URL(made.url).hash.slice(7),consent}).expect(200);await service(request(http).post(`/v1/link-sessions/${made.id}/game-confirm`)).send({minecraftUuid:mc.minecraftUuid,gameSessionId:mc.gameSessionId}).expect(200);
 [nick]=await claim('nicknames');assert.equal(nick.nickname,'김학생 / A');await ack(nick,'applied','nicknames').expect(204);state=await profile();assert.equal(state.nickname.status,'applied');assert.equal(state.nickname.desired,'김학생 / A');
 await browser(request(http).delete(`/v1/admin/members/${member.subjectId}/minecraft`),admin).expect(200);[nick]=await claim('nicknames');assert.equal(nick.nickname,'김학생');await ack(nick,'applied','nicknames').expect(204);
 const list=(await browser(request(http).get('/v1/admin/members'),admin,false).expect(200)).body.members;assert.equal(list.find(r=>r.id===member.subjectId).discordConnection.nickname.desired,'김학생');
});

test('Nickname leases are independent, bounded by school validity and fenced on settings change',async()=>{
 await fullSettings();await complete();const until=new Date(Date.now()+30000);await db.subject.update({where:{id:member.subjectId},data:{universityVerifiedUntil:until}});
 const roleJobs=await claim(),[nick]=await claim('nicknames');assert.equal(nick.expiresAt,until.toISOString());assert.deepEqual(await claim('nicknames'),[]);
 await ack({...nick,leaseToken:randomBytes(32).toString('base64url')},'applied','nicknames').expect(409);
 await configure({nicknameEnabled:false});assert.deepEqual(await claim('nicknames'),[]);await ack(nick,'applied','nicknames').expect(409);
 const [release]=await claim('nicknames');assert.equal(release.nickname,null);assert.notEqual(release.version,nick.version);await ack(release,'member_absent','nicknames').expect(204);assert.equal((await profile()).nickname.status,'disabled');
 for(const role of roleJobs)await ack(role).expect(204);assert.equal((await profile()).roleStatus,'granted');
 await configure({nicknameEnabled:true});const [next]=await claim('nicknames');await db.discordNicknameState.update({where:{id:next.id},data:{leaseUntil:new Date(0)}});await ack(next,'applied','nicknames').expect(409);const [retry]=await claim('nicknames');await ack(retry,'configuration_error','nicknames').expect(204);
 const overview=(await browser(request(http).get('/v1/admin/discord'),admin,false).expect(200)).body;assert.equal(overview.status.nicknames.failed,1);assert.equal(overview.status.roles.failed,0);
});

test('Completed revocations share the due queue fairly with a new grant across repeated ticks',async()=>{
 await complete();await db.discordRoleState.updateMany({data:{nextAttemptAt:new Date(1000)}});
 const identities=Array.from({length:36},(_,i)=>({discordUserId:String(400000000000000000n+BigInt(i)),guildId,username:'synthetic',displayName:'Synthetic',verifiedAt:new Date()}));await db.discordIdentity.createMany({data:identities});
 await db.discordRoleState.createMany({data:identities.map(i=>({discordUserId:i.discordUserId,guildId,roleId:verificationRoleId,desired:false,appliedDesired:false,appliedVersion:1n,nextAttemptAt:new Date(0)}))});
 // A successful cleanup is requeued for later. It must not permanently outrank a grant.
 let grant=false;for(let tick=0;tick<19;tick++){const jobs=await claim('roles',2);for(const job of jobs){if(job.discordUserId===discordUserId){assert.equal(job.desired,true);grant=true;}await ack(job).expect(204);}if(grant)break;}
 assert.equal(grant,true);
});

test('A full candidate page blocked on old-role removal rotates so an independent grant progresses',async()=>{
 await configure({memberRoleId:replacementRole});
 const subjects=Array.from({length:100},()=>({id:randomUUID(),universityKey:randomUUID(),displayName:'Synthetic',identityProvider:'usaint',membershipStatus:'active',verifiedUntil:new Date(Date.now()+900000),universityVerifiedUntil:new Date(Date.now()+3600000)}));await db.subject.createMany({data:subjects});
 const identities=subjects.map((s,i)=>({discordUserId:String(500000000000000000n+BigInt(i)),guildId,subjectId:s.id,username:'synthetic',displayName:'Synthetic',verifiedAt:new Date()}));await db.discordIdentity.createMany({data:identities});
 await db.consentReceipt.createMany({data:subjects.map(s=>({subjectId:s.id,contextId:randomUUID(),source:'discord_link',version:privacyNotice.version,acceptedAt:new Date()}))});
 await db.discordRoleState.createMany({data:identities.flatMap(i=>[{discordUserId:i.discordUserId,guildId,roleId:memberRoleId,kind:'member',desired:false,appliedDesired:true,nextAttemptAt:new Date(Date.now()+300000),lastError:'configuration_error'},{discordUserId:i.discordUserId,guildId,roleId:replacementRole,kind:'member',desired:true,validUntil:new Date(Date.now()+900000),nextAttemptAt:new Date(0)}])});
 await complete();await db.discordRoleState.updateMany({where:{discordUserId},data:{nextAttemptAt:new Date(1000)}});
 assert.deepEqual(await claim('roles',1),[]);
 const jobs=await claim('roles',1);assert.equal(jobs.length,1);assert.equal(jobs[0].discordUserId,discordUserId);assert.equal(jobs[0].desired,true);
});

// A historical successful revoke does not prove the outcome of a later grant in flight.
test('Role handoff waits for a current-version revoke even after an older successful removal',async()=>{
 await configure({memberRoleId});await db.subject.update({where:{id:member.subjectId},data:{membershipStatus:'inactive'}});await complete();await appliedRoles();
 await db.subject.update({where:{id:member.subjectId},data:{membershipStatus:'active'}});await refresh();
 const [grant]=await claim();assert.equal(grant.roleId,memberRoleId);assert.equal(grant.desired,true);
 await configure({memberRoleId:replacementRole});
 let jobs=await claim();assert.equal(jobs.some(j=>j.roleId===replacementRole),false);for(const job of jobs)await ack(job).expect(204);
 await ack(grant).expect(409);await due();jobs=await claim();assert.equal(jobs.some(j=>j.roleId===replacementRole),false);const revoke=jobs.find(j=>j.roleId===memberRoleId);assert.equal(revoke.desired,false);for(const job of jobs)await ack(job).expect(204);
 await db.discordRoleState.updateMany({where:{roleId:replacementRole},data:{nextAttemptAt:new Date(0)}});jobs=await claim();assert.equal(jobs.find(j=>j.roleId===replacementRole).desired,true);
});
