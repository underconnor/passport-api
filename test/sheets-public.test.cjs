const {test}=require('node:test');
const assert=require('node:assert/strict');
const {sheetsConfig,parseCsv,parseClubRosterCsv,publicRosterUrl,studentKey}=require('../dist/integrations/sheets');
const {rosterSourceKey}=require('../dist/membership-sync');
const env={SHEETS_ACCESS_MODE:'public-query',SHEETS_SPREADSHEET_ID:'synthetic-sheet-identifier',SHEETS_TAB:'Sheet1',ROSTER_MATCHING_SECRET:'separate-matching-secret-'.repeat(2),SHEETS_ACADEMIC_STATUS_HEADER:'26-2 재학여부',ROSTER_ACTIVE_ACADEMIC_STATUSES_JSON:'["재학","휴학"]',ROSTER_DEFAULT_SERVER_IDS_JSON:'["lobby"]'};
test('public read explicitly selects only student ID and enrollment columns, with fixed scopes',()=>{
  const config=sheetsConfig(env);const url=publicRosterUrl(config);
  assert.equal(url.hostname,'docs.google.com');assert.equal(url.searchParams.get('tq'),'select B,E');assert.equal(url.searchParams.get('headers'),'1');
  const rows=parseClubRosterCsv('"학번","26-2 재학여부"\n"99990001","재학"\n"99990002","휴학"',config);
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.status==='active'&&row.roleLabel==='회원'));assert.deepEqual(rows[0].serverIds,['lobby']);assert.equal(rows[0].studentKey,studentKey('99990001',config.matchingSecret));
  assert.doesNotMatch(JSON.stringify(rows),/9999000[12]/);
});
test('public mapping requires explicit recognized enrollment statuses and explicit server scopes',()=>{
  for(const change of [{ROSTER_ACTIVE_ACADEMIC_STATUSES_JSON:undefined},{ROSTER_DEFAULT_SERVER_IDS_JSON:undefined},{SHEETS_ACADEMIC_STATUS_HEADER:undefined},{ROSTER_DEFAULT_SERVER_IDS_JSON:'["admin"]'},{SHEETS_STUDENT_ID_COLUMN:'B; select A'},{SHEETS_STUDENT_ID_COLUMN:'E'}]) assert.throws(()=>sheetsConfig({...env,...change}));
  const config=sheetsConfig(env);
  for(const csv of ['"학번","26-2 재학여부"\n"99990001","졸업"','"학번","26-2 재학여부"\n"99990001",""','"이름","26-2 재학여부"\n"Someone","재학"','"학번","26-2 재학여부"\n"99990001","재학"\n"99990001","휴학"','"학번","26-2 재학여부"\n"99,990,001","재학"']) assert.throws(()=>parseClubRosterCsv(csv,config));
});
test('CSV handles quoting and rejects malformed, extra-column or oversized input',()=>{
  assert.deepEqual(parseCsv('"a","b"\r\n"a,""c""","d\ne"\r\n'),[['a','b'],['a,"c"','d\ne']]);
  for(const csv of ['"unclosed','a"b,c','"a"x,b','a,b,c','a'.repeat(2*1024*1024+1)]) assert.throws(()=>parseCsv(csv));
  const config=sheetsConfig(env);assert.deepEqual(parseClubRosterCsv('\ufeff"학번","26-2 재학여부"\n',config,{allowEmpty:true}),[]);
});
test('source identity binds source mapping, membership rules, scopes and HMAC rotation',()=>{
  const config=sheetsConfig(env);const key=rosterSourceKey(config);
  for(const change of [{ROSTER_ACTIVE_ACADEMIC_STATUSES_JSON:'["재학"]'},{ROSTER_DEFAULT_SERVER_IDS_JSON:'["lobby","survival"]'},{SHEETS_TAB:'Other'},{ROSTER_MATCHING_SECRET:'a-different-matching-key-'.repeat(2)}]) assert.notEqual(rosterSourceKey(sheetsConfig({...env,...change})),key);
});
