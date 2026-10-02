const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const request=require('supertest');
const raw=process.env.TEST_DATABASE_URL;
if(!raw||!new URL(raw).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
const url=new URL(raw);url.searchParams.set('schema','service_credentials_test');
Object.assign(process.env,{DATABASE_URL:url.href,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university',WEB_ORIGIN:'https://portal.example.test',ADMIN_ORIGIN:'https://admin.example.test',PASSPORT_LEGACY_SERVICE_AUTH_ENABLED:'true',API_SERVICE_TOKEN:'operators-service-'.repeat(4),PASSPORT_DISCORD_SERVICE_TOKEN:'operators-discord-'.repeat(4),DISCORD_GUILD_ID:'100000000000000001',DISCORD_MEMBER_ROLE_ID:'100000000000000002',SESSION_SECRET:'operators-session-'.repeat(4),ROSTER_MATCHING_SECRET:'operators-roster-'.repeat(4),DATA_ENCRYPTION_KEY:'ab'.repeat(32),ADMIN_BOOTSTRAP_TOKEN:'operators-bootstrap-'.repeat(4),ADMIN_MFA_REQUIRED:'false',SHEETS_SYNC_ENABLED:'false'});
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
 await db.$executeRawUnsafe('TRUNCATE TABLE "ServiceCredential", "Subject", "MinecraftIdentity", "AuditEvent", "RosterMembership", "RosterSnapshot", "PolicyEvent" RESTART IDENTITY CASCADE');
 owner=await admin('owner');
});
afterEach(async()=>{await app.close();});


const input=(changes={})=>({serviceId:'paper-lobby',audience:'minecraft',scopes:['game:policy','game:events','game:heartbeat','game:presence','game:stats:write'],serverIds:['lobby'],expiresAt:new Date(Date.now()+86400000).toISOString(),...changes});
async function issue(changes={},actor=owner,status=200){return browser(request(http).post('/v1/admin/service-credentials'),actor,true).send(input(changes)).expect(status);}
const keyed=(r,token)=>r.set('Authorization',`Bearer ${token}`);
test('owner-only issue/list/revoke with CSRF, one-time plaintext and no recoverable token stored',async()=>{
 for(const role of ['operator','viewer']){const u=await admin(role);await issue({},u,403);await browser(request(http).get('/v1/admin/service-credentials'),u).expect(403);}
 await browser(request(http).post('/v1/admin/service-credentials')).send(input()).expect(403);
 const result=(await issue()).body;assert.match(result.token,/^psk_/);assert.ok(!JSON.stringify(result.credential).includes('tokenHash'));
 const stored=await db.serviceCredential.findUnique({where:{id:result.credential.id}});assert.equal(stored.tokenHash,hash(result.token));assert.ok(!JSON.stringify(stored).includes(result.token));
 const listed=(await browser(request(http).get('/v1/admin/service-credentials')).expect(200)).body;assert.equal(listed.credentials.length,1);assert.ok(!JSON.stringify(listed).includes(result.token));assert.ok(!JSON.stringify(listed).includes(stored.tokenHash));
 const audit=await db.auditEvent.findMany({where:{action:'admin.service_credential_created'}});assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes(result.token));
});
test('paper key allows policy/events and only own server writes; proxy-only routes denied',async()=>{
 const {token}= (await issue()).body;
 await keyed(request(http).get('/v1/minecraft/events?after=0'),token).expect(200);
 await keyed(request(http).get(`/v1/minecraft/policies/${randomUUID()}`),token).expect(200);
 await keyed(request(http).post('/v1/minecraft/servers/heartbeat'),token).send({source:'paper',servers:[{id:'lobby',label:'Lobby'}]}).expect(200);
 await keyed(request(http).post('/v1/minecraft/servers/heartbeat'),token).send({source:'velocity',servers:[{id:'lobby',label:'Lobby'}]}).expect(403);
 await keyed(request(http).post('/v1/minecraft/presence'),token).send({serverId:'survival',observedAt:new Date().toISOString(),players:[]}).expect(403);
 await keyed(request(http).post('/v1/minecraft/stats/batches'),token).send({serverId:'survival',records:[]}).expect(403);
 for(const path of ['/v1/minecraft/players?query=synthetic','/v1/minecraft/servers','/v2/discord/config','/v1/admin/members'])await keyed(request(http).get(path),token).expect(403);
 await keyed(request(http).post('/v1/link-sessions'),token).send({}).expect(403);
});
test('rotation overlaps two hashed keys and individual revoke does not revoke successor',async()=>{
 const a=(await issue()).body,b=(await issue()).body;
 const check=(key,status)=>keyed(request(http).get('/v1/minecraft/events?after=0'),key).expect(status);
 await check(a.token,200);await check(b.token,200);
 await browser(request(http).delete('/v1/admin/service-credentials/'+a.credential.id),owner,true).expect(200);
 await check(a.token,401);await check(b.token,200);
 await db.serviceCredential.update({where:{id:b.credential.id},data:{expiresAt:new Date(0)}});await check(b.token,401);
 await check('psk_'+randomUUID()+'.'+'x'.repeat(43),401);await check(a.token+'tampered',401);
});
test('audience constraints and expiration validation prevent bad service grants',async()=>{
 await issue({audience:'discord'},owner,400);await issue({scopes:['game:link']},owner,400);await issue({expiresAt:new Date(0).toISOString()},owner,403);await issue({serverIds:['missing']},owner,404);
 const {token}= (await issue({serviceId:'discord-bot',audience:'discord',scopes:['discord:config'],serverIds:[]})).body;
 await keyed(request(http).get('/v2/discord/config'),token).expect(200);await keyed(request(http).get('/v1/minecraft/events?after=0'),token).expect(403);
});
test('explicit legacy shutdown closes old game and Discord secrets without disabling scoped keys',async()=>{
 const {token}= (await issue()).body;p.config.legacyServiceAuthEnabled=false;
 await service(request(http).get('/v1/minecraft/events?after=0')).expect(401);
 await keyed(request(http).get('/v2/discord/config'),p.config.discord.serviceToken).expect(401);
 await keyed(request(http).get('/v1/minecraft/events?after=0'),token).expect(200);
});
