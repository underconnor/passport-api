const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
const raw=process.env.TEST_DATABASE_URL;
if(!raw||!new URL(raw).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
const url=new URL(raw);url.searchParams.set('schema','operators_test');
Object.assign(process.env,{DATABASE_URL:url.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',API_SERVICE_TOKEN:'operators-service-'.repeat(4),PASSPORT_DISCORD_SERVICE_TOKEN:'operators-discord-'.repeat(4),DISCORD_GUILD_ID:'100000000000000001',DISCORD_MEMBER_ROLE_ID:'100000000000000002',SESSION_SECRET:'operators-session-'.repeat(4),ROSTER_MATCHING_SECRET:'operators-roster-'.repeat(4),DATA_ENCRYPTION_KEY:'ab'.repeat(32),ADMIN_BOOTSTRAP_TOKEN:'operators-bootstrap-'.repeat(4),ADMIN_MFA_REQUIRED:'false',SHEETS_SYNC_ENABLED:'false'});
const {createApp}=require('../dist/app'),{PassportService}=require('../dist/passport.service');
const {hash,csrf}=require('../dist/security'),{seal}=require('../dist/sealed'),{totpAt}=require('../dist/totp');
const {accountRevision,eraseSubject}=require('../dist/members'),{adminContext,requireAdminTransaction}=require('../dist/admin');
const {policyTransaction}=require('../dist/database'),{applyRosterSnapshot}=require('../dist/membership-sync');
let app,p,db,http,owner;
const service=r=>r.set('Authorization',`Bearer ${p.config.serviceToken}`);
function browser(r,user=owner,mutation=false){r=r.set('Host',user.host).set('Cookie',user.cookie);return mutation?r.set('Origin',`https://${user.host}`).set('X-CSRF-Token',user.csrf):r;}
async function subject(changes={}){return db.subject.create({data:{universityKey:randomUUID(),displayName:'Synthetic member',identityProvider:'usaint',universityVerifiedUntil:new Date(Date.now()+3600000),membershipStatus:'active',verifiedUntil:new Date(Date.now()+900000),allowedServerIds:['lobby'],...changes}});}
async function session(subject,host='admin.example.test'){const token=randomBytes(32).toString('base64url');const row=await db.webSession.create({data:{subjectId:subject.id,tokenHash:hash(token),audienceHost:host,expiresAt:new Date(Date.now()+3600000)}});return{subject,host,token,sessionId:row.id,cookie:`__Host-passport_${host.startsWith('admin')?'admin':'portal'}_session=${token}`,csrf:csrf(p.config.sessionSecret,token)};}
async function admin(role='operator'){const s=await subject();await db.administrator.create({data:{subjectId:s.id,enabled:true,role,totpSecret:''}});return session(s);}
async function invite(target,role='operator',actor=owner,status=200){return browser(request(http).post('/v1/admin/operator-invitations'),actor,true).send({subjectId:target.subject.id,role}).expect(status);}
async function accept(target,id,status=200){return browser(request(http).post(`/v1/admin/operator-invitations/${id}/accept`),target,true).send({}).expect(status);}
async function revision(id){return accountRevision(await db.subject.findUnique({where:{id},include:{minecraft:true,administrator:true,discordIdentity:true}}));}
beforeEach(async()=>{
 app=await createApp();p=app.get(PassportService);db=p.db;http=app.getHttpServer();
 await db.$executeRawUnsafe('TRUNCATE TABLE "Subject", "MinecraftIdentity", "AuditEvent", "RosterMembership", "RosterSnapshot", "PolicyEvent" RESTART IDENTITY CASCADE');
 owner=await admin('owner');
});
afterEach(async()=>{await app.close();});

test('default administrator role is viewer; every session advertises only effective role capabilities',async()=>{
 const member=await subject();const row=await db.administrator.create({data:{subjectId:member.id,enabled:true,totpSecret:''}});assert.equal(row.role,'viewer');
 for(const role of ['owner','operator','viewer']){
  const user=await admin(role);const status=(await browser(request(http).get('/v1/admin/session'),user).expect(200)).body;
  assert.equal(status.subjectId,user.subject.id);assert.equal(status.role,role);assert.deepEqual(status.permissions,{read:true,write:role!=='viewer',manageOperators:role==='owner'});
 }
 const plain=await session(await subject());const status=(await browser(request(http).get('/v1/admin/session'),plain).expect(200)).body;assert.equal(status.role,null);assert.equal(status.authorized,false);assert.deepEqual(status.permissions,{read:false,write:false,manageOperators:false});
 await assert.rejects(()=>db.administrator.update({where:{subjectId:member.id},data:{role:'invented'}}));
});
test('only a valid owner can invite and portal, missing CSRF, expired school identities and invented roles are rejected',async()=>{
 const target=await session(await subject());
 await invite(target,'operator',await admin('operator'),403);await invite(target,'viewer',await admin('viewer'),403);
 await invite(target,'operator',await session(owner.subject,'portal.example.test'),403);
 await browser(request(http).post('/v1/admin/operator-invitations')).send({subjectId:target.subject.id,role:'operator'}).expect(403);
 await browser(request(http).post('/v1/admin/operator-invitations'),owner,true).send({subjectId:target.subject.id,role:'root'}).expect(400);
 await db.subject.update({where:{id:target.subject.id},data:{universityVerifiedUntil:new Date(0)}});assert.equal((await invite(target,'viewer',owner,403)).body.code,'target_university_login_required');
 assert.equal(await db.operatorInvitation.count(),0);
});
test('24h invitation is bound to its school account, single-use under concurrency, and enables only the chosen role',async()=>{
 const target=await session(await subject()),other=await session(await subject());const oldSession=await session(target.subject);
 const row=(await invite(target,'viewer')).body.invitation;assert.ok(Date.parse(row.expiresAt)-Date.parse(row.createdAt)<=86401000);assert.ok(Date.parse(row.expiresAt)>Date.now()+86390000);
 assert.equal((await invite(target,'owner',owner,409)).body.code,'invitation_pending');
 assert.equal((await accept(other,row.id,404)).body.code,'invitation_not_found');
 assert.equal((await browser(request(http).get('/v1/admin/operator-invitations/pending'),other).expect(200)).body.invitations.length,0);
 assert.equal((await browser(request(http).get('/v1/admin/operator-invitations/pending'),target).expect(200)).body.invitations[0].id,row.id);
 const attempts=await Promise.all([browser(request(http).post(`/v1/admin/operator-invitations/${row.id}/accept`),target,true).send({}),browser(request(http).post(`/v1/admin/operator-invitations/${row.id}/accept`),target,true).send({})]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);
 assert.equal((await db.administrator.findUnique({where:{subjectId:target.subject.id}})).role,'viewer');
 await browser(request(http).get('/v1/admin/overview'),oldSession).expect(401);await browser(request(http).get('/v1/admin/overview'),target).expect(200);
 assert.equal(await db.auditEvent.count({where:{action:'admin.operator_invitation_accepted',subjectId:target.subject.id}}),1);
 assert.equal((await accept(target,row.id,409)).body.code,'invitation_unavailable');
});
test('expired and cancelled invitations never grant authority; a fresh invite can replace an expired one',async()=>{
 const target=await session(await subject());let row=(await invite(target)).body.invitation;await db.operatorInvitation.update({where:{id:row.id},data:{expiresAt:new Date(0)}});
 assert.equal((await accept(target,row.id,409)).body.code,'invitation_expired');
 row=(await invite(target,'viewer')).body.invitation;await browser(request(http).delete(`/v1/admin/operator-invitations/${row.id}`),owner,true).expect(200);
 await accept(target,row.id,409);assert.equal(await db.administrator.findUnique({where:{subjectId:target.subject.id}}),null);
 assert.equal((await browser(request(http).get('/v1/admin/operator-invitations/pending'),target).expect(200)).body.invitations.length,0);
});
test('owner downgrade revokes issued pending invites and immediately expires their administrative sessions',async()=>{
 const second=await admin('owner'),target=await session(await subject()),row=(await invite(target,'owner',second)).body.invitation;
 await browser(request(http).put(`/v1/admin/operators/${second.subject.id}`),owner,true).send({role:'viewer'}).expect(200);
 await browser(request(http).get('/v1/admin/operators'),second).expect(401);assert.equal((await accept(target,row.id,409)).body.code,'invitation_unavailable');
 const relogged=await session(second.subject);assert.equal((await browser(request(http).get('/v1/admin/session'),relogged).expect(200)).body.role,'viewer');
 await browser(request(http).post('/v1/admin/roster/preview'),relogged,true).send({}).expect(403);
});
test('viewer reads existing screens but cannot mutate any legacy route, including roster approval and linked services',async()=>{
 const viewer=await admin('viewer'),target=await subject(),id=target.id;
 for(const path of ['/v1/admin/overview','/v1/admin/members','/v1/admin/servers','/v1/admin/discord','/v1/admin/stats','/v1/admin/audit'])await browser(request(http).get(path),viewer).expect(200);
 const settings=(await browser(request(http).get('/v1/admin/discord')).expect(200)).body.settings;
 const server=(await db.serverRecord.findMany())[0];
 const mutations=[['put',`/v1/admin/members/${id}/access`,{suspended:true,restricted:false,serverIds:[]}],['delete',`/v1/admin/members/${id}/minecraft`,{}],['delete',`/v1/admin/members/${id}/discord`,{}],['delete',`/v1/admin/members/${id}`,{expectedRevision:await revision(id),confirmation:target.displayName}],['post','/v1/admin/roster/preview',{}],['post','/v1/admin/roster/sync',{}],['post','/v1/admin/roster/sync',{expectedApprovalDigest:'a'.repeat(64)}],['put',`/v1/admin/servers/${server.id}`,{label:server.label,sensitive:server.sensitive,enabled:server.enabled,accessMode:server.accessMode,allowedSubjectIds:[],expectedUpdatedAt:server.updatedAt.toISOString()}],['put','/v1/admin/discord',{memberRoleId:settings.memberRoleId,currentSemester:settings.currentSemester,semesterRoles:settings.semesterRoles,nicknameEnabled:false,expectedRevision:settings.revision}],['post','/v1/admin/discord/reconcile',{expectedRevision:settings.revision}]];
 for(const[method,path,body]of mutations){const response=await browser(request(http)[method](path),viewer,true).send(body).expect(403);assert.equal(response.body.code,'admin_write_required',path);}
 assert.equal((await db.subject.findUnique({where:{id}})).accessSuspended,false);
});
test('operator cannot use member delete, access, or unlink endpoints to manage another administrator',async()=>{
 const operator=await admin(),id=owner.subject.id;
 for(const[method,path,body]of [['delete',`/v1/admin/members/${id}`,{expectedRevision:await revision(id),confirmation:owner.subject.displayName}],['put',`/v1/admin/members/${id}/access`,{suspended:true,restricted:false,serverIds:[]}],['delete',`/v1/admin/members/${id}/minecraft`,{}],['delete',`/v1/admin/members/${id}/discord`,{}]])assert.equal((await browser(request(http)[method](path),operator,true).send(body).expect(403)).body.code,'owner_required');
 const member=await subject();await browser(request(http).put(`/v1/admin/members/${member.id}/access`),operator,true).send({suspended:true,restricted:false,serverIds:[]}).expect(200);
});
test('self-demotion, self-revocation and self-suspension fail, and concurrent owners cannot remove each other completely',async()=>{
 for(const method of ['put','delete'])assert.equal((await browser(request(http)[method](`/v1/admin/operators/${owner.subject.id}`),owner,true).send({role:'viewer'}).expect(409)).body.code,'self_admin_change_forbidden');
 await browser(request(http).put(`/v1/admin/members/${owner.subject.id}/access`),owner,true).send({suspended:true,restricted:false,serverIds:[]}).expect(409);
 const second=await admin('owner');const results=await Promise.all([browser(request(http).delete(`/v1/admin/operators/${owner.subject.id}`),second,true),browser(request(http).delete(`/v1/admin/operators/${second.subject.id}`),owner,true)]);
 assert.equal(results.filter(r=>r.status===200).length,1);assert.ok(results.some(r=>[401,403].includes(r.status)));assert.equal(await db.administrator.count({where:{enabled:true,role:'owner',revokedAt:null}}),1);
});
test('last-owner erasure is protected even when other non-owner administrators remain',async()=>{
 await admin('viewer');await admin('operator');const expectedRevision=await revision(owner.subject.id);await assert.rejects(()=>eraseSubject(p,owner.subject.id,{expectedRevision,confirmation:owner.subject.displayName},null),e=>e.getResponse().code==='last_administrator');
});
test('revocation removes only admin-host sessions, clears MFA, blocks legacy TOTP/bootstrap revival and fences game administrator policy',async()=>{
 const operator=await admin(),portal=await session(operator.subject,'portal.example.test');const mc=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'SyntheticOperator',subjectId:operator.subject.id}});
 let policy=(await service(request(http).get(`/v1/minecraft/policies/${mc.uuid}`)).expect(200)).body;assert.equal(policy.administrator,true);
 const secret='JBSWY3DPEHPK3PXP';await db.administrator.update({where:{subjectId:operator.subject.id},data:{totpSecret:seal(secret,p.config.encryptionKey,`totp:${operator.subject.id}`)}});await db.webSession.updateMany({where:{subjectId:operator.subject.id},data:{mfaVerifiedUntil:new Date(Date.now()+600000)}});
 await browser(request(http).delete(`/v1/admin/operators/${operator.subject.id}`),owner,true).expect(200);
 await browser(request(http).get('/v1/admin/overview'),operator).expect(401);await browser(request(http).get('/v1/me'),portal).expect(200);
 assert.equal((await db.webSession.findUnique({where:{id:portal.sessionId}})).mfaVerifiedUntil,null);
 const revoked=await db.administrator.findUnique({where:{subjectId:operator.subject.id}});assert.equal(revoked.enabled,false);assert.ok(revoked.revokedAt);assert.equal(revoked.totpSecret,'');
 policy=(await service(request(http).get(`/v1/minecraft/policies/${mc.uuid}`)).expect(200)).body;assert.equal(policy.administrator,false);assert.ok(policy.policyVersion>1);assert.ok(await db.policyEvent.findFirst({where:{minecraftUuid:mc.uuid}}));
 const again=await session(operator.subject);await browser(request(http).post('/v1/admin/mfa'),again,true).send({code:totpAt(secret,Math.floor(Date.now()/30000))}).expect(403);await browser(request(http).post('/v1/admin/enrollment'),again,true).send({bootstrapToken:p.config.adminBootstrapToken}).expect(409);
});
test('viewer never has game management capability in policy or service player search',async()=>{
 const viewer=await admin('viewer'),mc=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'ViewerIGN',subjectId:viewer.subject.id}});
 assert.equal((await service(request(http).get(`/v1/minecraft/policies/${mc.uuid}`)).expect(200)).body.administrator,false);
 assert.equal((await service(request(http).get('/v1/minecraft/players').query({query:'ViewerIGN'})).expect(200)).body.players[0].administrator,false);
});
test('transaction authorization rejects previously admitted writes after role revocation, including delayed roster apply',async()=>{
 const operator=await admin(),req={headers:{host:operator.host,cookie:operator.cookie,origin:`https://${operator.host}`,'x-csrf-token':operator.csrf}},context=await adminContext(p,req,true);
 await browser(request(http).delete(`/v1/admin/operators/${operator.subject.id}`),owner,true).expect(200);
 await assert.rejects(()=>policyTransaction(db,tx=>requireAdminTransaction(p,tx,context)),e=>e.getResponse().code==='admin_required');
 await assert.rejects(()=>applyRosterSnapshot(db,{sourceKey:'a'.repeat(64),entries:[],fetchedAt:new Date()},{allowedServerIds:['lobby'],authorize:tx=>requireAdminTransaction(p,tx,context)}),e=>e.getResponse().code==='admin_required');assert.equal(await db.rosterSnapshot.count(),0);
});
test('configured MFA cannot be bypassed by accepting an operator invitation',async()=>{
 const target=await session(await subject()),row=(await invite(target)).body.invitation;p.config.adminMfaRequired=true;
 assert.equal((await accept(target,row.id,403)).body.code,'mfa_enrollment_unavailable');assert.equal(await db.administrator.findUnique({where:{subjectId:target.subject.id}}),null);
});
test('operator responses and audits never disclose TOTP, encryption ciphertext, student key or session token',async()=>{
 const secret='JBSWY3DPEHPK3PXP';await db.administrator.update({where:{subjectId:owner.subject.id},data:{totpSecret:seal(secret,p.config.encryptionKey,`totp:${owner.subject.id}`)}});
 const target=await session(await subject());const row=(await invite(target)).body.invitation;await accept(target,row.id);
 const payload=JSON.stringify((await browser(request(http).get('/v1/admin/operators')).expect(200)).body)+JSON.stringify(await db.auditEvent.findMany());
 for(const forbidden of [secret,owner.token,target.token,owner.subject.universityKey,target.subject.universityKey,'totpSecret','studentIdCiphertext'])assert.ok(!payload.includes(forbidden));
 await browser(request(http).get('/v1/admin/operators'),target).expect(403);
});

test('concurrent invitation attempts cannot create two live grants for the same target',async()=>{
 const target=await session(await subject());const results=await Promise.all(['viewer','operator'].map(role=>browser(request(http).post('/v1/admin/operator-invitations'),owner,true).send({subjectId:target.subject.id,role})));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal(await db.operatorInvitation.count({where:{subjectId:target.subject.id,status:'pending'}}),1);
});

test('additive migration preserves existing administrator authority and makes new rows read-only by default',async()=>{
 const {readFileSync}=require('node:fs'),{join}=require('node:path');const rollback=new Error('rollback synthetic migration rehearsal');
 try{await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('DROP TABLE "OperatorInvitation"');
  await tx.$executeRawUnsafe('ALTER TABLE "Administrator" DROP COLUMN "role", DROP COLUMN "revokedAt"');
  const migration=readFileSync(join(__dirname,'../prisma/migrations/20261002000100_operator_roles/migration.sql'),'utf8').replace(/^--.*$/gm,'');
  for(const sql of migration.split(';').map(x=>x.trim()).filter(Boolean))await tx.$executeRawUnsafe(sql);
  const preserved=await tx.administrator.findUnique({where:{subjectId:owner.subject.id}});assert.equal(preserved.role,'owner');assert.equal(preserved.enabled,true);assert.equal(preserved.revokedAt,null);
  const s=await tx.subject.create({data:{universityKey:randomUUID(),displayName:'Synthetic migration target',identityProvider:'usaint',verifiedUntil:new Date()}});
  const next=await tx.administrator.create({data:{subjectId:s.id,enabled:true,totpSecret:''}});assert.equal(next.role,'viewer');
  throw rollback;
 });}catch(error){assert.equal(error,rollback);}
 assert.equal(await db.administrator.count(),1);
});

test('staff-server admission follows accepted operator authority and publishes every promotion, demotion and revocation',async()=>{
 await db.serverRecord.upsert({where:{id:'staff_room'},create:{id:'staff_room',commandName:'staff_room',label:'운영진 공간',enabled:true,accessMode:'staff'},update:{enabled:true,accessMode:'staff'}});
 const target=await session(await subject({membershipStatus:'inactive',verifiedUntil:new Date(0)})),portal=await session(target.subject,'portal.example.test');
 const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'StaffLifecycle',subjectId:target.subject.id}});
 const policy=async()=>(await service(request(http).get(`/v1/minecraft/policies/${identity.uuid}`)).expect(200)).body;
 const visible=async()=>(await browser(request(http).get('/v1/me/servers'),portal).expect(200)).body.servers.map(row=>row.id);
 assert.deepEqual((await policy()).allowedServerIds,[]);assert.deepEqual(await visible(),[]);
 const invitation=(await invite(target)).body.invitation;
 let previous=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}}),events=await db.policyEvent.count({where:{minecraftUuid:identity.uuid}});
 await accept(target,invitation.id);let changed=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});assert.equal(changed.policyVersion,previous.policyVersion+1);assert.equal(changed.policyFingerprint,'');assert.equal(await db.policyEvent.count({where:{minecraftUuid:identity.uuid}}),events+1);
 assert.deepEqual((await policy()).allowedServerIds,['staff_room']);assert.deepEqual(await visible(),['staff_room']);
 for(const role of ['viewer','operator',null]){
  previous=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});events=await db.policyEvent.count({where:{minecraftUuid:identity.uuid}});
  if(role)await browser(request(http).put(`/v1/admin/operators/${target.subject.id}`),owner,true).send({role}).expect(200);
  else await browser(request(http).delete(`/v1/admin/operators/${target.subject.id}`),owner,true).expect(200);
  changed=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});assert.equal(changed.policyVersion,previous.policyVersion+1);assert.equal(changed.policyFingerprint,'');assert.equal(await db.policyEvent.count({where:{minecraftUuid:identity.uuid}}),events+1);
  assert.deepEqual((await policy()).allowedServerIds,role==='operator'?['staff_room']:[]);assert.deepEqual(await visible(),role==='operator'?['staff_room']:[]);assert.equal(changed.telemetryEpoch,previous.telemetryEpoch);
 }
});

test('first-owner bootstrap and MFA activation invalidate game policy before staff admission becomes available',async()=>{
 await db.serverRecord.upsert({where:{id:'staff_room'},create:{id:'staff_room',commandName:'staff_room',label:'운영진 공간',enabled:true,accessMode:'staff'},update:{enabled:true,accessMode:'staff'}});
 for(const mfaRequired of [false,true]){
  await db.administrator.deleteMany();p.config.adminMfaRequired=mfaRequired;
  const target=await session(await subject({membershipStatus:'inactive',verifiedUntil:new Date(0)}));
  const identity=await db.minecraftIdentity.create({data:{uuid:randomUUID(),name:'StaffBootstrap',subjectId:target.subject.id}}),url=`/v1/minecraft/policies/${identity.uuid}`;
  assert.deepEqual((await service(request(http).get(url)).expect(200)).body.allowedServerIds,[]);
  let previous=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}}),events=await db.policyEvent.count({where:{minecraftUuid:identity.uuid}});
  const enrollment=(await browser(request(http).post('/v1/admin/enrollment'),target,true).send({bootstrapToken:p.config.adminBootstrapToken}).expect(200)).body;
  let changed=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});assert.equal(changed.policyVersion,previous.policyVersion+1);assert.equal(changed.policyFingerprint,'');assert.equal(await db.policyEvent.count({where:{minecraftUuid:identity.uuid}}),events+1);
  assert.deepEqual((await service(request(http).get(url)).expect(200)).body.allowedServerIds,mfaRequired?[]:['staff_room']);
  if(mfaRequired){
   previous=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});events=await db.policyEvent.count({where:{minecraftUuid:identity.uuid}});
   await browser(request(http).post('/v1/admin/mfa'),target,true).send({code:totpAt(enrollment.secret,Math.floor(Date.now()/30000))}).expect(200);
   changed=await db.minecraftIdentity.findUnique({where:{uuid:identity.uuid}});assert.equal(changed.policyVersion,previous.policyVersion+1);assert.equal(changed.policyFingerprint,'');assert.equal(await db.policyEvent.count({where:{minecraftUuid:identity.uuid}}),events+1);
   assert.deepEqual((await service(request(http).get(url)).expect(200)).body.allowedServerIds,['staff_room']);
  }
 }
});
