const {test}=require('node:test');
const assert=require('node:assert/strict');
const {configFromEnv}=require('../dist/config');
const {discordSchema,hash,equal,csrf}=require('../dist/security');
const base={NODE_ENV:'test',PASSPORT_AUTH_MODE:'development',DATABASE_URL:'postgresql://ignored',WEB_ORIGIN:'http://localhost:5173',API_SERVICE_TOKEN:'a'.repeat(40),SESSION_SECRET:'b'.repeat(40)};
test('development authentication is impossible in production',()=>{
  assert.throws(()=>configFromEnv({...base,NODE_ENV:'production'}),/forbidden/);
  assert.throws(()=>configFromEnv({...base,NODE_ENV:'production',PASSPORT_AUTH_MODE:'university-disabled'}),/HTTPS/);
  assert.equal(configFromEnv({...base,PASSPORT_AUTH_MODE:undefined}).authMode,'university-disabled');
});
test('secrets must be independent and sufficiently long',()=>{
  assert.throws(()=>configFromEnv({...base,SESSION_SECRET:'short'}));
  assert.throws(()=>configFromEnv({...base,SESSION_SECRET:base.API_SERVICE_TOKEN}));
});
test('administrator MFA defaults on and only an explicit false disables the requirement',()=>{
 assert.equal(configFromEnv(base).adminMfaRequired,true);
 assert.equal(configFromEnv({...base,ADMIN_MFA_REQUIRED:'true'}).adminMfaRequired,true);
 assert.equal(configFromEnv({...base,ADMIN_MFA_REQUIRED:'false'}).adminMfaRequired,false);
 for(const value of ['','0','FALSE','disabled'])assert.throws(()=>configFromEnv({...base,ADMIN_MFA_REQUIRED:value}),/ADMIN_MFA_REQUIRED/);
});
test('Discord is a positive unsigned 64-bit decimal string',()=>{
  for(const id of ['1','18446744073709551615']) assert.ok(discordSchema.safeParse({id}).success);
  for(const id of ['0','01','18446744073709551616','-1','1.0',12345,'','00012']) assert.equal(discordSchema.safeParse({id}).success,false);
});
test('Discord service credentials are optional together and separate from Minecraft or sessions',()=>{
 const settings={PASSPORT_DISCORD_SERVICE_TOKEN:'c'.repeat(40),DISCORD_GUILD_ID:'123',DISCORD_MEMBER_ROLE_ID:'456'};
 assert.equal(configFromEnv(base).discord,undefined);assert.equal(configFromEnv({...base,...settings}).discord.guildId,'123');
 for(const change of [{DISCORD_GUILD_ID:undefined},{DISCORD_MEMBER_ROLE_ID:'0'},{DISCORD_MEMBER_ROLE_ID:'123'},{PASSPORT_DISCORD_SERVICE_TOKEN:base.API_SERVICE_TOKEN},{PASSPORT_DISCORD_SERVICE_TOKEN:base.SESSION_SECRET}])assert.throws(()=>configFromEnv({...base,...settings,...change}));
});
test('hashed token equality and CSRF binding reject another session',()=>{
  assert.ok(equal(hash('token'),hash('token')));assert.ok(!equal(hash('token'),hash('other')));
  assert.notEqual(csrf('secret','session1'),csrf('secret','session2'));
});
const {parseRoster,validateSnapshotChange,studentKey,sheetsConfig}=require('../dist/integrations/sheets');
const rosterConfig={matchingSecret:'roster-test-'.repeat(4),allowedServerIds:['lobby','survival']};
const rosterHeader=['student_id','status','role_label','server_ids'];
test('Sheets parser validates synthetic rows and retains only HMAC student keys',()=>{
 const entries=parseRoster([rosterHeader,['99990001','active','개발회원','lobby,survival'],['99990002','inactive','','']],rosterConfig);
 assert.equal(entries.length,2);assert.equal(entries[0].studentKey,studentKey('99990001',rosterConfig.matchingSecret));
 assert.ok(!JSON.stringify(entries).includes('99990001'));assert.deepEqual(entries[1].serverIds,[]);
});
test('Sheets rejects duplicate, missing, malformed, oversized or unknown-scope snapshots',()=>{
 for(const rows of [[],[rosterHeader],[[...rosterHeader,'extra'],['99990001','active','','lobby']],[rosterHeader,['99990001','active','','lobby'],['99990001','active','','lobby']],[rosterHeader,['99990001','active','','admin']],[rosterHeader,['99990001','inactive','','lobby']],[rosterHeader,['99990001','active','<red>','lobby']],[rosterHeader,[99990001,'active','','lobby']]]) assert.throws(()=>parseRoster(rows,rosterConfig));
 assert.throws(()=>sheetsConfig({}));
});
test('mass revocation requires review and matching secret scopes the identifier',()=>{
 const old=parseRoster([rosterHeader,['99990001','active','','lobby'],['99990002','active','','lobby']],rosterConfig);
 const next=parseRoster([rosterHeader,['99990001','inactive','',''],['99990002','active','','lobby']],rosterConfig);
 assert.throws(()=>validateSnapshotChange(old,next),/manual review/);
 assert.notEqual(studentKey('99990001',rosterConfig.matchingSecret),studentKey('99990001','another-secret-'.repeat(3)));
});
const {discordEntitlement,discordMemberEntitlement,discordNickname}=require('../dist/discord-policy');
test('Discord school verification and current membership have separate expiry and suspension gates',()=>{
 const now=new Date('2026-10-01T00:00:00Z'),school=new Date(now.getTime()+3600000),roster=new Date(now.getTime()+60000);
 const subject={identityProvider:'usaint',membershipStatus:'active',accessSuspended:false,universityVerifiedUntil:school,verifiedUntil:roster};
 assert.deepEqual(discordEntitlement({...subject,membershipStatus:'inactive',verifiedUntil:new Date(0)},now),{desired:true,validUntil:school});
 assert.deepEqual(discordMemberEntitlement(subject,now),{desired:true,validUntil:roster});
 for(const change of [{membershipStatus:'suspended'},{accessSuspended:true},{universityVerifiedUntil:new Date(0)},{identityProvider:'development'}])assert.equal(discordEntitlement({...subject,...change},now).desired,false);
 assert.equal(discordMemberEntitlement({...subject,membershipStatus:'inactive'},now).desired,false);
});
test('Discord nicknames normalize only known school greetings and preserve bounded legacy Minecraft names',()=>{
 for(const name of ['김학생','김학생님 환영합니다.'])assert.equal(discordNickname(name,'A'),'김학생 / A');
 assert.equal(discordNickname('한님','A'),'한님 / A');
 assert.equal(discordNickname('Synthetic','Ab'),'Synthetic / Ab');assert.equal(discordNickname('Synthetic','invalid/name'),'Synthetic');
 assert.equal(discordNickname('김학생님 환영합니다. 공지사항','Test'),null);
 const long=discordNickname('가'.repeat(40),'SixteenCharName1');assert.equal(Array.from(long).length,32);assert.ok(long.endsWith(' / SixteenCharName1'));
});

test('administrator roles fail closed and viewer never inherits mutating game capability',()=>{
 const {adminPermissions,gameAdministrator}=require('../dist/admin-permissions');
 for(const value of [null,{enabled:false,role:'owner',revokedAt:null},{enabled:true,role:'owner',revokedAt:new Date()},{enabled:true,role:'invented',revokedAt:null}]){assert.deepEqual(adminPermissions(value),{read:false,write:false,manageOperators:false});assert.equal(gameAdministrator(value),false);}
 assert.deepEqual(adminPermissions({enabled:true,role:'viewer',revokedAt:null}),{read:true,write:false,manageOperators:false});assert.equal(gameAdministrator({enabled:true,role:'viewer',revokedAt:null}),false);
 assert.deepEqual(adminPermissions({enabled:true,role:'operator',revokedAt:null}),{read:true,write:true,manageOperators:false});assert.equal(gameAdministrator({enabled:true,role:'owner',revokedAt:null}),true);
});

const {serverCommandNameSchema,serverSettingsSchema}=require('../dist/security');
test('server command names normalize NFC and ASCII case without trimming or changing display labels',()=>{
 for(const [input,expected] of [['Lobby','lobby'],['PLAY_2-야생','play_2-야생'],['로비','로비'],['가'.repeat(64),'가'.repeat(64)],['1','1']])assert.equal(serverCommandNameSchema.parse(input),expected);
 for(const input of ['',null,1,'가'.repeat(65),'a'.repeat(65),' lobby','lobby ','two words','/lobby','lobby/creative','a\nb','a\tb','a:b','a.b','ㄱ','ᄀ','Ａ','😀'])assert.equal(serverCommandNameSchema.safeParse(input).success,false,JSON.stringify(input));
 const original={label:'로비 표시 이름',sensitive:false,enabled:true,accessMode:'members',allowedSubjectIds:[],expectedUpdatedAt:'2026-10-02T00:00:00.000Z'};
 assert.equal(serverSettingsSchema.parse(original).commandName,undefined);
 const parsed=serverSettingsSchema.parse({...original,commandName:'CAMPUS-로비'});assert.equal(parsed.commandName,'campus-로비');assert.equal(parsed.label,original.label);
 assert.equal(serverSettingsSchema.safeParse({...original,id:'cannot-change'}).success,false);
});

test('university Discord requirements use only an explicit identity relation and preserve the other scope gates',()=>{
 const {permittedServers}=require('../dist/registry'),now=new Date('2026-10-03T00:00:00Z'),future=new Date(now.getTime()+60000);
 const base={id:'subject',identityProvider:'usaint',universityVerifiedUntil:future,membershipStatus:'inactive',verifiedUntil:new Date(0),accessSuspended:false,scopeRestricted:false,scopeLimit:[],allowedServerIds:['roster'],discordIdentity:null,discordId:'self-reported-only'};
 const servers=['any','linked','unlinked'].map(discordRequirement=>({id:discordRequirement,enabled:true,accessMode:'university',discordRequirement}));
 const ids=(subject=base,options={})=>permittedServers(subject,servers,{now,...options}).map(row=>row.id);
 assert.deepEqual(ids(),['any','unlinked']);assert.deepEqual(ids({...base,discordIdentity:{subjectId:'subject'}}),['any','linked']);
 for(const discordIdentity of [undefined,{subjectId:null},{subjectId:'other'}])assert.deepEqual(ids({...base,discordIdentity}),['any']);
 for(const change of [{accessSuspended:true},{membershipStatus:'suspended'},{universityVerifiedUntil:now},{identityProvider:'development'}])assert.deepEqual(ids({...base,...change}),[]);
 assert.deepEqual(ids({...base,scopeRestricted:true,scopeLimit:['linked']}),[]);
 assert.deepEqual(ids({...base,scopeRestricted:true,scopeLimit:['any']}),['any']);
 const member={...base,membershipStatus:'active',verifiedUntil:future},memberServers=['members','selected'].map(accessMode=>({id:accessMode,accessMode,enabled:true,discordRequirement:'linked',allowedSubjectIds:['subject']}));
 assert.deepEqual(permittedServers(member,memberServers,{now}).map(row=>row.id),['members','selected']);
 assert.deepEqual(permittedServers(base,memberServers,{now}).map(row=>row.id),['selected']);
 assert.deepEqual(permittedServers({...base,identityProvider:'development'},[memberServers[1]],{now,allowDevelopment:true}),[]);
 assert.deepEqual(permittedServers(base,[{...servers[0],discordRequirement:'unknown'}],{now}),[]);
});
test('Discord server settings accept only the optional enum and member ID resolution is bounded and normalized',()=>{
 const {memberQuerySchema}=require('../dist/security'),{randomUUID}=require('node:crypto');
 const settings={label:'학교',sensitive:false,enabled:true,accessMode:'university',allowedSubjectIds:[],expectedUpdatedAt:'2026-10-03T00:00:00.000Z'};
 for(const value of ['any','linked','unlinked'])assert.equal(serverSettingsSchema.parse({...settings,discordRequirement:value}).discordRequirement,value);
 assert.equal(serverSettingsSchema.parse(settings).discordRequirement,undefined);
 for(const value of ['',null,true,'LINKED','unknown'])assert.equal(serverSettingsSchema.safeParse({...settings,discordRequirement:value}).success,false);
 const ids=Array.from({length:50},()=>randomUUID());assert.deepEqual(memberQuerySchema.parse({ids:ids.join(',')}).ids,ids);
 assert.deepEqual(memberQuerySchema.parse({ids:ids[0].toUpperCase()}).ids,[ids[0]]);assert.equal(memberQuerySchema.parse({}).ids,undefined);
 for(const value of ['',[],ids[0]+',',','+ids[0],ids[0]+', '+ids[1],ids[0]+','+ids[0].toUpperCase(),ids.join(',')+','+randomUUID(),'invalid'])assert.equal(memberQuerySchema.safeParse({ids:value}).success,false,JSON.stringify(value));
});

test('members mode ignores legacy roster server lists and public settings reject the retired roster mode',()=>{
 const {permittedServers}=require('../dist/registry'),now=new Date('2026-10-03T00:00:00Z');
 const subject={id:'member',identityProvider:'usaint',universityVerifiedUntil:new Date(now.getTime()+60000),membershipStatus:'active',verifiedUntil:new Date(now.getTime()+60000),accessSuspended:false,scopeRestricted:false,scopeLimit:[],discordIdentity:null};
 const servers=[{id:'club',enabled:true,accessMode:'members'},{id:'retired',enabled:true,accessMode:'roster'},{id:'disabled',enabled:false,accessMode:'members'}];
 for(const allowedServerIds of [[],['elsewhere'],['club'],undefined])assert.deepEqual(permittedServers({...subject,allowedServerIds},servers,{now}).map(row=>row.id),['club']);
 for(const changes of [{scopeRestricted:true,scopeLimit:[]},{membershipStatus:'inactive'},{verifiedUntil:now},{universityVerifiedUntil:now},{accessSuspended:true}])assert.deepEqual(permittedServers({...subject,...changes},servers,{now}),[]);
 const original={label:'회원 서버',sensitive:false,enabled:true,accessMode:'members',allowedSubjectIds:[],expectedUpdatedAt:'2026-10-03T00:00:00.000Z'};
 for(const accessMode of ['members','selected','university','staff'])assert.equal(serverSettingsSchema.safeParse({...original,accessMode}).success,true);
 assert.equal(serverSettingsSchema.safeParse({...original,accessMode:'roster'}).success,false);
});

test('staff-only servers require current school identity and enabled owner or operator authority',()=>{
 const {permittedServers}=require('../dist/registry'),now=new Date('2026-10-04T00:00:00Z'),future=new Date(now.getTime()+60000);
 const subject={id:'staff',identityProvider:'usaint',universityVerifiedUntil:future,membershipStatus:'inactive',verifiedUntil:new Date(0),accessSuspended:false,scopeRestricted:false,scopeLimit:[],discordIdentity:null};
 const server={id:'staff_server',enabled:true,accessMode:'staff',discordRequirement:'linked',allowedSubjectIds:[]};
 const ids=(changes={},options={})=>permittedServers({...subject,administrator:{enabled:true,role:'operator',revokedAt:null},...changes},[server],{now,...options}).map(row=>row.id);
 for(const role of ['owner','operator'])assert.deepEqual(ids({administrator:{enabled:true,role,revokedAt:null}}),['staff_server']);
 for(const administrator of [undefined,null,{enabled:true,role:'viewer',revokedAt:null},{enabled:false,role:'owner',revokedAt:null},{enabled:true,role:'operator',revokedAt:now},{enabled:true,role:'invented',revokedAt:null}])assert.deepEqual(ids({administrator}),[]);
 for(const changes of [{accessSuspended:true},{membershipStatus:'suspended'},{universityVerifiedUntil:now},{universityVerifiedUntil:null},{identityProvider:'development'},{identityProvider:'managed-development',developmentAccount:{enabled:true,discordLinked:true}}])assert.deepEqual(ids(changes,{allowDevelopment:true}),[]);
 assert.deepEqual(ids({scopeRestricted:true,scopeLimit:[]}),[]);assert.deepEqual(ids({scopeRestricted:true,scopeLimit:['staff_server']}),['staff_server']);
 assert.deepEqual(permittedServers({...subject,administrator:{enabled:true,role:'owner',revokedAt:null}},[{...server,enabled:false}],{now}),[]);
});

test('Discord-linked signal requires the actual matching relationship, never a legacy reference or role status',()=>{
 const {hasLinkedDiscordIdentity}=require('../dist/discord-policy');
 for(const subject of [null,undefined,{id:'subject',discordIdentity:null,discordId:'200000000000000001'},{id:'subject',discordIdentity:{subjectId:null}},{id:'subject',discordIdentity:{subjectId:'other'}}])assert.equal(hasLinkedDiscordIdentity(subject),false);
 const linked={id:'subject',discordIdentity:{subjectId:'subject'}};
 assert.equal(hasLinkedDiscordIdentity(linked),true);
 assert.equal(hasLinkedDiscordIdentity({...linked,membershipStatus:'inactive',universityVerifiedUntil:new Date(0),accessSuspended:true}),true);
});
