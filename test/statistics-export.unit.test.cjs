const { test }=require('node:test');
const assert=require('node:assert/strict');
const {withStatisticsExportSlot}=require('../dist/statistics-export');
test('export admission bounds concurrent memory to two workbooks and releases success or failed slots',async()=>{
 let release;const wait=new Promise(resolve=>{release=resolve;});let active=0;
 const operation=async()=>{active++;await wait;active--;return 'done';};
 const first=withStatisticsExportSlot(operation),second=withStatisticsExportSlot(operation);
 assert.equal(active,2);
 await assert.rejects(withStatisticsExportSlot(async()=>{throw new Error('must not run');}),e=>e.getStatus()===409&&e.getResponse().code==='statistics_export_busy');
 release();assert.deepEqual(await Promise.all([first,second]),['done','done']);assert.equal(active,0);
 const error=new Error('synthetic workbook failure');await assert.rejects(withStatisticsExportSlot(async()=>{throw error;}),e=>e===error);
 assert.equal(await withStatisticsExportSlot(async()=> 'retry'),'retry');
});

const {statisticsQuerySchema,adminStatisticsQuerySchema,statisticsExportSchema}=require('../dist/security');
const {statisticsSubjectWhere}=require('../dist/statistics-membership');
test('membership scope is opt-in only for aggregate and export inputs with backward-compatible all default',()=>{
 assert.equal(adminStatisticsQuerySchema.parse({}).membership,'all');assert.equal(statisticsExportSchema.parse({}).membership,'all');
 for(const membership of ['all','active']){assert.equal(adminStatisticsQuerySchema.parse({membership}).membership,membership);assert.equal(statisticsExportSchema.parse({membership}).membership,membership);assert.equal(statisticsQuerySchema.safeParse({membership}).success,false);}
 for(const membership of ['inactive','suspended','members','',null,1,['all','active']]){assert.equal(adminStatisticsQuerySchema.safeParse({membership}).success,false);assert.equal(statisticsExportSchema.safeParse({membership}).success,false);}
});
test('current member predicate uses the supplied shared query instant and matches the administrator member list',()=>{
 const now=new Date('2026-10-02T00:00:00.000Z');
 assert.deepEqual(statisticsSubjectWhere('all',now),{});
 assert.deepEqual(statisticsSubjectWhere('active',now),{identityProvider:'usaint',membershipStatus:'active',verifiedUntil:{gt:now},accessSuspended:false});
});
