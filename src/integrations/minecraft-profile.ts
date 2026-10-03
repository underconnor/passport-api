import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

/** Resolve only the fixed Mojang endpoint; administrator input can never choose a URL. */
export async function resolveMinecraftProfile(name: string, request: typeof fetch = fetch) {
  try {
    const response = await request(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } });
    if (response.status === 404 || response.status === 204) throw new NotFoundException({ code: 'minecraft_profile_not_found' });
    if (!response.ok || !response.body) throw new Error('upstream');
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 4096) throw new Error('size'); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value.id !== 'string' || !/^[a-f0-9]{32}$/i.test(value.id) || typeof value.name !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(value.name) || value.name.toLowerCase() !== name.toLowerCase()) throw new Error('profile');
    const id = value.id.toLowerCase();
    return { uuid: `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`, name: value.name as string };
  } catch (error) { if (error instanceof NotFoundException) throw error; throw new ServiceUnavailableException({ code: 'minecraft_profile_unavailable' }); }
}
