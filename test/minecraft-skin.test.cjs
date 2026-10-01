const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MinecraftSkins } = require('../dist/integrations/minecraft-skin');
const uuid = '00000000-0000-4000-8000-000000000001';
const id = uuid.replaceAll('-', '');
const texture = `http://textures.minecraft.net/texture/${'a'.repeat(64)}`;
function profile(url = texture, profileId = id) {
  return new Response(JSON.stringify({ id, properties: [{ name: 'textures', value: Buffer.from(JSON.stringify({ profileId, textures: { SKIN: { url, metadata: { model: 'slim' } } } })).toString('base64') }] }));
}
function png(width = 64, height = 64) {
  const data = Buffer.alloc(33); Buffer.from([137,80,78,71,13,10,26,10]).copy(data);
  data.writeUInt32BE(13,8); data.write('IHDR',12); data.writeUInt32BE(width,16); data.writeUInt32BE(height,20);
  return new Response(data, { headers: { 'content-type': 'image/png' } });
}
test('uses only official HTTPS endpoints and coalesces/caches the same profile', async () => {
  const calls=[];
  const client=new MinecraftSkins(async(url,options)=>{calls.push({url,options});return calls.length===1?profile():png();});
  const [a,b]=await Promise.all([client.get(uuid),client.get(uuid)]);
  assert.deepEqual(a,b); assert.match(a.dataUrl,/^data:image\/png;base64,/); assert.equal(a.model,'slim');
  await client.get(uuid); assert.equal(calls.length,2);
  assert.equal(calls[0].url,`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
  assert.equal(calls[1].url,texture.replace('http:','https:'));
  assert.ok(calls.every(c=>c.options.redirect==='error' && c.options.signal));
});
test('foreign hosts, redirects, ports, credentials, query parameters and mismatched identities are rejected', async()=>{
  for(const url of ['https://attacker.example/skin','https://textures.minecraft.net.attacker.example/texture/'+ 'a'.repeat(64),texture+'?token=secret',texture.replace('http://','http://secret@'),texture.replace('.net/', '.net:8443/'),'file:///etc/passwd']){
    let calls=0; const client=new MinecraftSkins(async()=>{calls++;return profile(url);});
    assert.deepEqual(await client.get(uuid),{dataUrl:null,model:null});assert.equal(calls,1);
  }
  const client=new MinecraftSkins(async()=>profile(texture,'0'.repeat(32)));
  assert.equal((await client.get(uuid)).dataUrl,null);
});
test('oversized responses, non-PNG and excessive pixel dimensions never reach the browser',async()=>{
  for(const bad of [()=>png(10000,10000),()=>new Response('<svg onload="x"/>',{headers:{'content-type':'image/svg+xml'}}),()=>new Response(Buffer.alloc(262145),{headers:{'content-type':'image/png'}})]){
    let calls=0;const client=new MinecraftSkins(async()=>++calls===1?profile():bad());
    assert.equal((await client.get(uuid)).dataUrl,null);
  }
});
test('upstream errors and invalid UUIDs return a neutral fallback without preserving error text',async()=>{
  let calls=0;let time=0;
  const client=new MinecraftSkins(async()=>{calls++;throw new Error('sensitive upstream body');},()=>time);
  assert.deepEqual(await client.get('../anything'),{dataUrl:null,model:null});assert.equal(calls,0);
  assert.deepEqual(await client.get(uuid),{dataUrl:null,model:null});await client.get(uuid);assert.equal(calls,1);
  time=30001;await client.get(uuid);assert.equal(calls,2);
});
