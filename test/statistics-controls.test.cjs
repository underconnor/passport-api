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

async function serverCollection(id,enabled,user=admin,status=200){const s=await db.serverRecord.findUnique({where:{id}});return browser(request(http).put(`/v1/admin/servers/${id}`),user,true).send({label:s.label,sensitive:s.sensitive,enabled:s.enabled,accessMode:s.accessMode,allowedSubjectIds:s.allowedSubjectIds,expectedUpdatedAt:s.updatedAt.toISOString(),statisticsEnabled:enabled}).expect(status);}
async function preview(scope,user=admin,status=200){return browser(request(http).post('/v1/admin/stats/reset/preview'),user,true).send(scope).expect(status);}
async function reset(scope,pre,user=admin,status=200,changes={}){return browser(request(http).post('/v1/admin/stats/reset'),user,true).send({...scope,expectedRevision:pre.expectedRevision,confirmation:pre.confirmation,...changes}).expect(status);}
async function own(a){return(await browser(request(http).get('/v1/me/stats'),a.portal).expect(200)).body;}
async function roleSession(role){const owner=await subject();await db.administrator.create({data:{subjectId:owner.id,enabled:true,role,totpSecret:''}});return session(owner,'admin.example.test');}

test('personal collection controls are removed and missing consent still prevents collection',async()=>{
 const a=await linked({statisticsEnabled:false});
 await browser(request(http).get('/v1/me/statistics-settings'),a.portal).expect(404);
 await browser(request(http).put('/v1/me/statistics-settings'),a.portal,true).send({enabled:false,expectedRevision:'0'.repeat(64)}).expect(404);
 assert.equal((await policy(a.minecraft.uuid)).body.telemetry.enabled,true);
 assert.equal((await submit(batch(a.minecraft))).body.received,1);
 await db.consentReceipt.deleteMany({where:{subjectId:a.owner.id}});
 assert.equal((await policy(a.minecraft.uuid)).body.telemetry.enabled,false);
 assert.equal((await submit(batch(a.minecraft))).body.ignored,1);
 await browser(request(http).post('/v1/me/stats/reset'),a.portal,true).send({}).expect(404);
});
test('server collection toggle excludes preserved history/totals and policy serverIds without changing admission',async()=>{
 const a=await linked({allowedServerIds:['lobby','survival']});await submit(batch(a.minecraft));await submit(batch(a.minecraft,{serverId:'survival'}));
 await serverCollection('lobby',false);let stats=await own(a);assert.equal(stats.totals.playSeconds,60);assert.deepEqual(stats.collection.excludedServerIds,['lobby']);assert.equal(stats.servers.some(s=>s.serverId==='lobby'),false);assert.equal(await db.activityTotal.count(),2);
 await service(request(http).post('/v1/minecraft/presence')).send({serverId:'lobby',observedAt:new Date().toISOString(),players:[a.minecraft.uuid]}).expect(200);assert.equal((await own(a)).presence.online,true);
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
 const current=await db.minecraftIdentity.findUnique({where:{uuid:a.minecraft.uuid}});await submit(batch(current));const stale=(await preview(scope)).body;await serverCollection('lobby',false);await reset(scope,stale,admin,409);await serverCollection('lobby',true);
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
 const a=await linked();await submit(batch(a.minecraft));await serverCollection('lobby',false);
 const scope={scope:'all'},pre=(await preview(scope)).body;assert.equal(pre.totals.playSeconds,60);await reset(scope,pre);assert.equal(await db.activityTotal.count(),0);assert.ok(await db.subject.findUnique({where:{id:a.owner.id}}));assert.equal((await db.serverRecord.findUnique({where:{id:'lobby'}})).statisticsEnabled,false);
});

const {unzipSync,strFromU8}=require('fflate');
const {sealStudentId}=require('../dist/school-identity');
const {koreaDate}=require('../dist/activity');
const exportFile=(input={},user=admin,status=200)=>browser(request(http).post('/v1/admin/stats/export'),user,true).send(input).buffer(true).parse((res,callback)=>{const parts=[];res.on('data',chunk=>parts.push(chunk));res.on('end',()=>callback(null,Buffer.concat(parts)));}).expect(status);
test('XLSX export preserves full identifiers, escapes text, exports eight metrics and excludes disabled servers',async()=>{
 const key=randomUUID(),studentId='20260001';
 const a=await linked({universityKey:key,studentIdCiphertext:sealStudentId(studentId,key,p.config.encryptionKey),displayName:'=HYPERLINK("https://invalid.test") & <검증>',discordId:'1555000000000000001',allowedServerIds:['lobby','survival']});
 await submit(batch(a.minecraft,{records:[{minecraftUuid:a.minecraft.uuid,epoch:a.minecraft.telemetryEpoch,...count,playerKills:3,distanceCm:256}]}));
 await submit(batch(a.minecraft,{serverId:'survival'}));await serverCollection('survival',false);
 const result=await exportFile({subjectId:a.owner.id});assert.match(result.headers['content-type'],/spreadsheetml/);assert.match(result.headers['cache-control'],/no-store/);
 const files=unzipSync(result.body),sheet=strFromU8(files['xl/worksheets/sheet1.xml']);
 for(const text of [studentId,a.owner.id,a.minecraft.uuid,'1555000000000000001','죽인 플레이어 수','이동 거리 (m)'])assert.ok(sheet.includes(text));
 assert.ok(sheet.includes('t="inlineStr"'));assert.ok(sheet.includes('=HYPERLINK(&quot;'));assert.ok(!sheet.includes('<f>'));assert.ok(!sheet.includes('survival'));assert.ok(sheet.includes('<v>2.56</v>'));
 assert.equal(await db.auditEvent.count({where:{action:'admin.statistics_export'}}),1);
 const audit=await db.auditEvent.findFirst({where:{action:'admin.statistics_export'}});assert.ok(!JSON.stringify(audit).includes(studentId));
});
test('XLSX export requires admin write, current session, admin host and CSRF',async()=>{
 await request(http).post('/v1/admin/stats/export').set('Host','admin.example.test').set('Origin','https://admin.example.test').send({}).expect(401);
 await browser(request(http).post('/v1/admin/stats/export')).send({}).expect(403);
 await exportFile({},await roleSession('viewer'),403);await exportFile({},(await linked()).portal,403);
 await service(request(http).post('/v1/admin/stats/export')).send({}).expect(403);
 await exportFile({},await roleSession('operator'));
 await exportFile({serverId:'missing'},admin,404);
 await exportFile({from:'2026-02-30',to:'2026-03-01'},admin,400);
 assert.equal(await db.auditEvent.count({where:{action:'admin.statistics_export'}}),1);
});
test('daily history is idempotent, uses Korean receipt day and only filters prospective rows',async()=>{
 const a=await linked(),input=batch(a.minecraft);await submit(input);await submit(input);
 assert.equal(await db.activityDaily.count(),1);let daily=await db.activityDaily.findFirst();assert.equal(daily.playSeconds,60n);assert.equal(daily.date.toISOString().slice(0,10),koreaDate(new Date()));
 const today=koreaDate(new Date());let stats=(await browser(request(http).get(`/v1/me/stats?from=${today}&to=${today}`),a.portal).expect(200)).body;
 assert.equal(stats.totals.playSeconds,60);assert.equal(stats.daily[0].playSeconds,60);assert.equal(stats.daily[0].serverId,'lobby');assert.ok(stats.firstCollectedAt);assert.ok(stats.lastCollectedAt);assert.equal(stats.period.basis,'receivedAt');
 await db.activityTotal.updateMany({data:{playSeconds:{increment:900}}});
 assert.equal((await own(a)).totals.playSeconds,960);stats=(await browser(request(http).get(`/v1/me/stats?from=${today}&to=${today}`),a.portal).expect(200)).body;assert.equal(stats.totals.playSeconds,60);
 await browser(request(http).get('/v1/me/stats?from=2026-02-30&to=2026-03-01'),a.portal).expect(400);
 await browser(request(http).get('/v1/me/stats?from=2026-01-01'),a.portal).expect(400);
 await browser(request(http).get('/v1/me/stats?from=2020-01-01&to=2026-01-01'),a.portal).expect(400);
 assert.equal(koreaDate(new Date('2026-10-01T15:00:00Z')),'2026-10-02');assert.equal(koreaDate(new Date('2026-10-01T14:59:59Z')),'2026-10-01');
});
test('reset clears matching daily buckets and preserves other server daily data',async()=>{
 const a=await linked({allowedServerIds:['lobby','survival']});await submit(batch(a.minecraft));await submit(batch(a.minecraft,{serverId:'survival'}));
 const scope={scope:'server',serverId:'lobby'};await reset(scope,(await preview(scope)).body);
 assert.equal(await db.activityDaily.count(),1);assert.equal((await db.activityDaily.findFirst()).serverId,'survival');
 const all={scope:'all'};await reset(all,(await preview(all)).body);assert.equal(await db.activityDaily.count(),0);
});
test('period Excel export uses filtered daily values and unavailable student IDs stay blank',async()=>{
 const a=await linked();await submit(batch(a.minecraft));await db.activityTotal.updateMany({data:{playSeconds:999n}});
 const today=koreaDate(new Date()),result=await exportFile({subjectId:a.owner.id,from:today,to:today});
 const sheet=strFromU8(unzipSync(result.body)['xl/worksheets/sheet1.xml']);assert.ok(sheet.includes('<v>60</v>'));assert.ok(!sheet.includes('<v>999</v>'));assert.ok(sheet.includes('r="B2" s="0" t="inlineStr"><is><t xml:space="preserve"></t>'));
});
test('upgrade migration preserves cumulative data and atomically retires only personal collection preferences',async()=>{
 const schema='stats_migration_'+randomUUID().replaceAll('-','');
 const off=randomUUID(),on=randomUUID(),offUuid=randomUUID(),onUuid=randomUUID(),oldOffEpoch=randomUUID(),oldOnEpoch=randomUUID();
 const sql=require('node:fs').readFileSync('prisma/migrations/20261002020000_statistics_export_manual/migration.sql','utf8').replace(/^--.*$/gm,'');
 await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
  await tx.$executeRawUnsafe('CREATE TABLE "Subject" ("id" UUID PRIMARY KEY, "statisticsEnabled" BOOLEAN, "statisticsRevision" INTEGER)');
  await tx.$executeRawUnsafe('CREATE TABLE "MinecraftIdentity" ("uuid" UUID PRIMARY KEY, "subjectId" UUID, "telemetryEpoch" UUID, "policyVersion" INTEGER, "policyFingerprint" TEXT, "updatedAt" TIMESTAMP(3))');
  await tx.$executeRawUnsafe('CREATE TABLE "PolicyEvent" ("id" BIGSERIAL PRIMARY KEY, "minecraftUuid" UUID, "policyVersion" INTEGER, "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP)');
  await tx.$executeRawUnsafe('CREATE TABLE "ActivityGeneration" ("epoch" UUID PRIMARY KEY)');
  await tx.$executeRawUnsafe('CREATE TABLE "ActivityTotal" ("epoch" UUID, "serverId" TEXT, "playSeconds" BIGINT, PRIMARY KEY ("epoch","serverId"))');
  await tx.$executeRawUnsafe('INSERT INTO "Subject" VALUES ($1::uuid,false,1),($2::uuid,true,1)',off,on);
  await tx.$executeRawUnsafe('INSERT INTO "MinecraftIdentity" VALUES ($1::uuid,$2::uuid,$3::uuid,1,\'old\',CURRENT_TIMESTAMP),($4::uuid,$5::uuid,$6::uuid,1,\'old\',CURRENT_TIMESTAMP)',offUuid,off,oldOffEpoch,onUuid,on,oldOnEpoch);
  await tx.$executeRawUnsafe('INSERT INTO "ActivityGeneration" VALUES ($1::uuid)',oldOffEpoch);
  await tx.$executeRawUnsafe('INSERT INTO "ActivityTotal" VALUES ($1::uuid,\'lobby\',321)',oldOffEpoch);
  for(const statement of sql.split(';').map(s=>s.trim()).filter(s=>s&&!['BEGIN','COMMIT'].includes(s))) await tx.$executeRawUnsafe(statement);
  const subjects=await tx.$queryRawUnsafe('SELECT * FROM "Subject"');assert.ok(subjects.every(s=>s.statisticsEnabled));assert.equal(subjects.find(s=>s.id===off).statisticsRevision,2);assert.equal(subjects.find(s=>s.id===on).statisticsRevision,1);
  const identities=await tx.$queryRawUnsafe('SELECT * FROM "MinecraftIdentity"');assert.notEqual(identities.find(s=>s.uuid===offUuid).telemetryEpoch,oldOffEpoch);assert.equal(identities.find(s=>s.uuid===onUuid).telemetryEpoch,oldOnEpoch);
  const events=await tx.$queryRawUnsafe('SELECT * FROM "PolicyEvent"');assert.equal(events.length,1);assert.equal(events[0].minecraftUuid,offUuid);assert.equal(events[0].policyVersion,2);
  const totals=await tx.$queryRawUnsafe('SELECT * FROM "ActivityTotal"');assert.equal(totals[0].playSeconds,321n);assert.equal(totals[0].firstCollectedAt,null);assert.equal(totals[0].lastCollectedAt,null);
  assert.equal((await tx.$queryRawUnsafe('SELECT * FROM "ActivityDaily"')).length,0);assert.equal((await tx.$queryRawUnsafe('SELECT * FROM "StatisticsHistory"')).length,1);
  await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
 },{timeout:30000});
});

const {counterNames,emptyCounters}=require('../dist/activity');
const fixtureCounters=scale=>Object.fromEntries(counterNames.map((key,index)=>[key,BigInt(scale*(index+1))]));
async function historical(a,scale,{serverId='lobby',day=koreaDate(new Date()),first=new Date(Date.now()-60000),last=new Date(),epoch=a.minecraft.telemetryEpoch}={}){
 await db.activityGeneration.upsert({where:{epoch},create:{epoch,subjectId:a.owner.id,minecraftUuid:a.minecraft.uuid},update:{}});
 const counters=fixtureCounters(scale),increment=Object.fromEntries(counterNames.map(key=>[key,{increment:counters[key]}]));
 await db.activityTotal.upsert({where:{epoch_serverId:{epoch,serverId}},create:{epoch,serverId,...counters,firstCollectedAt:first,lastCollectedAt:last},update:{...increment,lastCollectedAt:last}});
 await db.activityDaily.create({data:{epoch,serverId,date:new Date(day),...counters,firstCollectedAt:first,lastCollectedAt:last}});
}
const adminStats=(query={},user=admin,status=200)=>browser(request(http).get('/v1/admin/stats').query(query),user).expect(status);
function assertCounters(actual,scale){for(const [index,key] of counterNames.entries())assert.equal(actual[key],scale*(index+1),key);}
function excelRows(buffer,sheet=1){
 const source=strFromU8(unzipSync(buffer)[`xl/worksheets/sheet${sheet}.xml`]);
 const unescape=value=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
 return [...source.matchAll(/<row\b[^>]*>(.*?)<\/row>/gs)].map(row=>[...row[1].matchAll(/<c\b[^>]*>(.*?)<\/c>/gs)].map(cell=>{const text=cell[1].match(/<t\b[^>]*>(.*?)<\/t>/s);return text?unescape(text[1]):Number(cell[1].match(/<v>(.*?)<\/v>/s)[1]);}));
}
test('administrator membership filter applies one current cohort to every counter, history timestamp, player and presence count',async()=>{
 await db.subject.update({where:{id:admin.subject.id},data:{membershipStatus:'inactive'}});
 const cases=[{}, {universityVerifiedUntil:new Date(0)}, {membershipStatus:'inactive'}, {verifiedUntil:new Date(0)}, {accessSuspended:true}, {membershipStatus:'suspended'}, {identityProvider:'development'}];
 const actors=[];let scale=1;
 const first=new Date('2026-09-30T00:00:00Z'),last=new Date('2026-10-01T00:00:00Z');
 for(const [index,changes] of cases.entries()){
  const a=await linked(changes);actors.push(a);
  await historical(a,scale,{first:index<2?first:new Date('2020-01-01T00:00:00Z'),last:index<2?last:new Date('2030-01-01T00:00:00Z')});
  await db.playerPresence.create({data:{minecraftUuid:a.minecraft.uuid,serverId:index===1?'survival':'lobby',observedAt:new Date(),expiresAt:new Date(Date.now()+60000)}});scale*=2;
 }
 // A second epoch of the same member contributes counters without adding a player.
 await historical(actors[0],3,{epoch:randomUUID(),first,last});
 await historical(actors[0],1000,{serverId:'survival',first:new Date('2010-01-01T00:00:00Z'),last:new Date('2040-01-01T00:00:00Z')});
 await serverCollection('survival',false);
 const plain=(await adminStats()).body,all=(await adminStats({membership:'all'})).body,active=(await adminStats({membership:'active'})).body;
 assert.deepEqual(plain,all);assertCounters(all.totals,130);assertCounters(active.totals,6);
 assert.equal(all.playerCount,7);assert.equal(active.playerCount,2);
 assert.equal(all.onlinePlayerCount,7);assert.equal(active.onlinePlayerCount,2);
 assert.equal(active.servers.length,1);assert.equal(active.servers[0].serverId,'lobby');assertCounters(active.servers[0],6);assert.equal(active.servers[0].onlinePlayerCount,1);
 assert.equal(active.daily.length,1);assertCounters(active.daily[0],6);
 assert.equal(active.firstCollectedAt,first.toISOString());assert.equal(active.lastCollectedAt,last.toISOString());
 assert.equal(active.servers[0].firstCollectedAt,first.toISOString());assert.equal(active.servers[0].lastCollectedAt,last.toISOString());
 const members=(await browser(request(http).get('/v1/admin/members').query({membership:'active'})).expect(200)).body.members;
 assert.deepEqual(members.map(row=>row.id).sort(),actors.slice(0,2).map(row=>row.owner.id).sort());
 assert.equal(await db.activityTotal.count(),9); // Filtering never deletes history or toggles collection.
 assert.equal((await db.serverRecord.findUnique({where:{id:'survival'}})).statisticsEnabled,false);
});
test('period statistics use current membership rather than past membership and retain current online semantics',async()=>{
 const a=await linked(),oldDay=koreaDate(new Date(Date.now()-86400000)),today=koreaDate(new Date());
 await historical(a,10,{day:oldDay});await historical(a,3,{day:today});
 await db.playerPresence.create({data:{minecraftUuid:a.minecraft.uuid,serverId:'lobby',observedAt:new Date(),expiresAt:new Date(Date.now()+60000)}});
 const filtered=(await adminStats({membership:'active',from:oldDay,to:oldDay})).body;
 assertCounters(filtered.totals,10);assertCounters(filtered.daily[0],10);assert.equal(filtered.playerCount,1);assert.equal(filtered.onlinePlayerCount,1);
 assertCounters((await adminStats({membership:'active'})).body.totals,13);
 const outside=(await adminStats({membership:'active',from:'2020-01-01',to:'2020-01-01'})).body;
 assertCounters(outside.totals,0);assert.equal(outside.playerCount,0);assert.equal(outside.onlinePlayerCount,1);assert.deepEqual(outside.daily,[]);
 await db.subject.update({where:{id:a.owner.id},data:{membershipStatus:'inactive'}});
 const changed=(await adminStats({membership:'active',from:oldDay,to:oldDay})).body;
 assertCounters(changed.totals,0);assert.equal(changed.playerCount,0);assert.equal(changed.onlinePlayerCount,0);assert.equal(changed.firstCollectedAt,null);assert.equal(changed.lastCollectedAt,null);
 assertCounters((await adminStats({from:oldDay,to:oldDay})).body.totals,10);
});
test('active XLSX export intersects current member, period and server filters, and records the cohort basis',async()=>{
 await db.subject.update({where:{id:admin.subject.id},data:{membershipStatus:'inactive'}});
 const a=await linked({displayName:'CurrentMember'}),outside=await linked({displayName:'FormerMember',membershipStatus:'inactive'}),today=koreaDate(new Date());
 const first=new Date('2026-09-29T00:00:00Z'),last=new Date('2026-09-30T00:00:00Z');
 await historical(a,10,{first,last});await historical(outside,200);await historical(a,999,{serverId:'survival'});await serverCollection('survival',false);
 // Period export must take daily rows rather than the different cumulative totals.
 await db.activityTotal.updateMany({where:{serverId:'lobby'},data:{playSeconds:9000n}});
 const before=Date.now(),result=await exportFile({membership:'active',from:today,to:today,serverId:'lobby'}),after=Date.now();
 const rows=excelRows(result.body),metadata=new Map(excelRows(result.body,2).slice(1));
 assert.equal(rows.length,2);assert.equal(rows[1][0],a.owner.id);assert.equal(rows[1][6],'lobby');
 assert.deepEqual(rows[1].slice(8,16),[10,20,30,0.04,50,60,70,0.8]);assert.deepEqual(rows[1].slice(16),[first.toISOString(),last.toISOString()]);
 assert.equal(metadata.get('조회 대상'),'소모임 회원만');assert.match(metadata.get('회원 판정 기준'),/조회 시점의 현재 회원 상태/);assert.match(metadata.get('회원 판정 기준'),/과거 수집 당시/);
 const asOf=Date.parse(metadata.get('회원 판정 시각 (UTC)'));assert.ok(asOf>=before&&asOf<=after);
 const audit=await db.auditEvent.findFirst({where:{action:'admin.statistics_export'}});assert.equal(audit.details.membership,'active');assert.equal(audit.details.subjectCount,1);assert.equal(audit.details.rowCount,1);assert.ok(!JSON.stringify(audit).includes('CurrentMember'));
 assert.equal(excelRows((await exportFile({subjectId:outside.owner.id,membership:'active'})).body).length,1);
 await exportFile({subjectId:randomUUID(),membership:'active'},admin,404);
 await exportFile({serverId:'survival',membership:'active'},admin,404);
 const defaultFile=await exportFile({subjectId:outside.owner.id});assert.equal(excelRows(defaultFile.body)[1][0],outside.owner.id);assert.equal(new Map(excelRows(defaultFile.body,2).slice(1)).get('조회 대상'),'전체 사용자');
 const allAudit=await db.auditEvent.findFirst({where:{action:'admin.statistics_export'},orderBy:{createdAt:'desc'}});assert.equal(allAudit.details.membership,'all');
});
test('zero active members return zero aggregates and a header-only workbook without weakening the all view',async()=>{
 await db.subject.update({where:{id:admin.subject.id},data:{membershipStatus:'inactive'}});
 const outsider=await linked({membershipStatus:'inactive'});await historical(outsider,5);
 const active=(await adminStats({membership:'active'})).body;
 assertCounters(active.totals,0);assert.equal(active.playerCount,0);assert.equal(active.onlinePlayerCount,0);assert.deepEqual(active.daily,[]);
 assert.equal(active.firstCollectedAt,null);assert.equal(active.lastCollectedAt,null);assert.ok(active.servers.length>0);for(const row of active.servers)assertCounters(row,0);
 const empty=await exportFile({membership:'active'});assert.equal(excelRows(empty.body).length,1);
 const audit=await db.auditEvent.findFirst({where:{action:'admin.statistics_export'}});assert.equal(audit.details.subjectCount,0);assert.equal(audit.details.membership,'active');
 assertCounters((await adminStats()).body.totals,5);
});
test('membership accepts only all or active on aggregate reads and exports; personal and reset contracts are unchanged',async()=>{
 const a=await linked();await historical(a,2);
 for(const membership of ['inactive','suspended','members','',1,null]){
  await adminStats({membership},admin,400);await exportFile({membership},admin,400);
 }
 await adminStats({membership:['all','active']},admin,400);
 await adminStats({membership:'active',from:'2026-01-01'},admin,400);
 await browser(request(http).get('/v1/me/stats').query({membership:'active'}),a.portal).expect(400);
 await browser(request(http).get(`/v1/admin/members/${a.owner.id}/stats`).query({membership:'all'})).expect(400);
 await browser(request(http).post('/v1/admin/stats/reset/preview'),admin,true).send({scope:'all',membership:'active'}).expect(400);
 await browser(request(http).post('/v1/admin/stats/reset'),admin,true).send({scope:'all',membership:'active',expectedRevision:'0'.repeat(64),confirmation:'test'}).expect(400);
 const mine=(await own(a)).totals,member=(await browser(request(http).get(`/v1/admin/members/${a.owner.id}/stats`)).expect(200)).body.totals;
 assertCounters(mine,2);assert.deepEqual(member,mine);
 const mc=(await service(request(http).get(`/v1/minecraft/players/${a.minecraft.uuid}/stats`).query({membership:'active'})).expect(200)).body;
 assert.deepEqual(mc.totals,mine); // The existing private MC endpoint ignores query parameters.
});
test('membership filter keeps admin roles, host, school freshness, session and export CSRF checks intact',async()=>{
 const a=await linked();await historical(a,1);
 await request(http).get('/v1/admin/stats?membership=active').set('Host','admin.example.test').expect(401);
 await adminStats({membership:'active'},a.portal,403);
 await service(request(http).get('/v1/admin/stats?membership=active')).expect(403);
 const viewer=await roleSession('viewer');await adminStats({membership:'active'},viewer);await exportFile({membership:'active'},viewer,403);
 await browser(request(http).post('/v1/admin/stats/export')).send({membership:'active'}).expect(403);
 await exportFile({membership:'active'},a.portal,403);
 await browser(request(http).post('/v1/admin/stats/export'),admin,true).set('Origin','https://other.example.test').send({membership:'active'}).expect(403);
 const operator=await roleSession('operator');await exportFile({membership:'active'},operator);
 await db.subject.update({where:{id:operator.subject.id},data:{universityVerifiedUntil:new Date(0)}});await adminStats({membership:'active'},operator,403);await exportFile({membership:'active'},operator,403);
 await db.webSession.updateMany({where:{subjectId:admin.subject.id},data:{expiresAt:new Date(0)}});await adminStats({membership:'active'},admin,401);await exportFile({membership:'active'},admin,401);
});
