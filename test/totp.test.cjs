const {test}=require('node:test');
const assert=require('node:assert/strict');
const {base32,totpAt,verifyTotp}=require('../dist/totp');
const {seal,unseal}=require('../dist/sealed');
test('RFC 6238 SHA-1 vectors use six-digit truncation, including 64-bit timestamps',()=>{
 const secret=base32(Buffer.from('12345678901234567890'));
 for(const [time,code] of [[59,'287082'],[1111111109,'081804'],[1111111111,'050471'],[1234567890,'005924'],[2000000000,'279037'],[20000000000,'353130']])assert.equal(totpAt(secret,Math.floor(time/30)),code);
 assert.equal(verifyTotp(secret,'287082',-1n,59000),1);
 assert.equal(verifyTotp(secret,'287082',1n,59000),null);
 assert.equal(verifyTotp(secret,'287082',-1n,150000),null);
});
test('sealed auth context is authenticated and bound to its purpose',()=>{
 const key='12'.repeat(32), value='opaque-test-only';const encrypted=seal(value,key,'return');
 assert.equal(unseal(encrypted,key,'return'),value);
 assert.throws(()=>unseal(encrypted,key,'totp'));
 assert.throws(()=>unseal(encrypted,'34'.repeat(32),'return'));
 const parts=encrypted.split('.');parts[2]=Buffer.from('tampered').toString('base64url');assert.throws(()=>unseal(parts.join('.'),key,'return'));
 assert.notEqual(seal(value,key,'return'),encrypted);
});
