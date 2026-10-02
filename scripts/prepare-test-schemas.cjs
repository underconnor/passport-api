const {spawnSync}=require('node:child_process');
const raw=process.env.TEST_DATABASE_URL;
if(!raw || !new URL(raw).pathname.endsWith('_test'))throw new Error('Dedicated _test database required');
for(const schema of ['public','membership_test','auth_test','policy_order_test','registry_test','discord_test','discord_v2_test','expansion_test','operators_test','statistics_controls_test','service_credentials_test','manual_test']){
  const url=new URL(raw);url.searchParams.set('schema',schema);
  const result=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{env:{...process.env,DATABASE_URL:url.href},stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
