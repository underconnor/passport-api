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
