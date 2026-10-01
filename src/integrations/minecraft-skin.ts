/** Skin pixels are fetched only from Mojang and returned through our origin. */
export type MinecraftSkin = { dataUrl: string | null; model: 'classic' | 'slim' | null };
const empty = (): MinecraftSkin => ({ dataUrl: null, model: null });
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function bounded(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok || !response.body) throw new Error('skin_unavailable');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('skin_too_large');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new Error('skin_too_large');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export class MinecraftSkins {
  private readonly cache = new Map<string, { until: number; value: MinecraftSkin }>();
  private readonly pending = new Map<string, Promise<MinecraftSkin>>();
  constructor(private readonly request: typeof fetch = fetch, private readonly clock = Date.now) {}
  async get(uuid: string): Promise<MinecraftSkin> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) return empty();
    const id = uuid.replace(/-/g, '').toLowerCase();
    const now = this.clock();
    const cached = this.cache.get(id);
    if (cached && cached.until > now) return cached.value;
    if (this.pending.has(id)) return this.pending.get(id)!;
    // Bound both caches, including an upstream outage with concurrent requests.
    if (this.pending.size >= 64) return empty();
    const work = this.load(id).catch(() => empty()).then(value => {
      for (const [key, entry] of this.cache) if (entry.until <= this.clock()) this.cache.delete(key);
      if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(id, { until: this.clock() + (value.dataUrl ? 600_000 : 30_000), value });
      return value;
    }).finally(() => { this.pending.delete(id); });
    this.pending.set(id, work);
    return work;
  }
  private async load(id: string): Promise<MinecraftSkin> {
    const profileResponse = await this.request(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`, {
      redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { Accept: 'application/json' },
    });
    const profile = JSON.parse((await bounded(profileResponse, 65_536)).toString('utf8'));
    if (profile?.id?.toLowerCase() !== id || !Array.isArray(profile.properties)) return empty();
    const property = profile.properties.find((item: unknown) => item && typeof item === 'object' && 'name' in item && item.name === 'textures');
    if (typeof property?.value !== 'string' || property.value.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(property.value)) return empty();
    const textures = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8'));
    if (textures.profileId?.toLowerCase() !== id) return empty();
    const skin = textures.textures?.SKIN;
    if (typeof skin?.url !== 'string') return empty();
    const url = new URL(skin.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'textures.minecraft.net' || url.port || url.username || url.password || url.search || url.hash || !/^\/texture\/[0-9a-f]{64}$/.test(url.pathname)) return empty();
    // Mojang profile records may advertise HTTP; never send the texture request over HTTP.
    url.protocol = 'https:';
    const textureResponse = await this.request(url.href, {
      redirect: 'error', signal: AbortSignal.timeout(5_000), headers: { Accept: 'image/png' },
    });
    if (textureResponse.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/png') return empty();
    const png = await bounded(textureResponse, 262_144);
    if (png.length < 33 || !png.subarray(0, 8).equals(pngSignature) || png.readUInt32BE(8) !== 13 || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== 64 || ![32, 64].includes(png.readUInt32BE(20))) return empty();
    return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, model: skin.metadata?.model === 'slim' ? 'slim' : 'classic' };
  }
}
const skins = new MinecraftSkins();
export const minecraftSkin = (uuid: string): Promise<MinecraftSkin> => skins.get(uuid);
