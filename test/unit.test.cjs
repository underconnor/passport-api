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
