export interface ServerDefinition { id: string; label: string; sensitive?: boolean }
export interface Config {
  authMode: 'development' | 'university-disabled' | 'university'; production: boolean; databaseUrl: string;
  serviceToken: string; sessionSecret: string; webOrigin: string; origins: string[];
  bindHost: string; port: number; servers: ServerDefinition[];
  adminOrigin: string; matchingSecret: string; encryptionKey: string; adminBootstrapToken?: string;
  trustProxyHops: number;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string) => { const v = env[name]; if (!v) throw new Error(`${name} is required`); return v; };
  const production = env.NODE_ENV === 'production';
  const authMode = env.PASSPORT_AUTH_MODE ?? 'university-disabled';
  if (!['development', 'university-disabled', 'university'].includes(authMode)) throw new Error('Unsupported PASSPORT_AUTH_MODE');
  if (production && authMode === 'development') throw new Error('Development identities are forbidden in production');
  const webOrigin = new URL(required('WEB_ORIGIN')).origin;
  const origins = [...new Set([webOrigin, ...(env.ADMIN_ORIGIN ? [new URL(env.ADMIN_ORIGIN).origin] : [])])];
  if (origins.some(o => !/^https?:\/\//.test(o) || (production && !o.startsWith('https://')))) throw new Error('Invalid browser origins; production requires HTTPS');
  const serviceToken = required('API_SERVICE_TOKEN');
  const sessionSecret = required('SESSION_SECRET');
  if (serviceToken.length < 32 || sessionSecret.length < 32 || serviceToken === sessionSecret) throw new Error('Separate service/session secrets of at least 32 characters required');
  const matchingSecret = env.ROSTER_MATCHING_SECRET ?? '';
  const encryptionKey = env.DATA_ENCRYPTION_KEY ?? '';
  const adminBootstrapToken = env.ADMIN_BOOTSTRAP_TOKEN;
  if (authMode === 'university' && (matchingSecret.length < 32 || !/^[0-9a-f]{64}$/i.test(encryptionKey))) throw new Error('University mode requires ROSTER_MATCHING_SECRET and a 32-byte hex DATA_ENCRYPTION_KEY');
  if (adminBootstrapToken && adminBootstrapToken.length < 43) throw new Error('ADMIN_BOOTSTRAP_TOKEN must contain at least 32 random bytes');
  const adminOrigin = env.ADMIN_ORIGIN ? new URL(env.ADMIN_ORIGIN).origin : '';
  if (authMode === 'university' && (!adminOrigin || new URL(adminOrigin).host === new URL(webOrigin).host)) throw new Error('University mode requires a distinct admin host');
  const servers = JSON.parse(env.SERVER_REGISTRY_JSON ?? '[{"id":"lobby","label":"로비"},{"id":"survival","label":"야생"}]') as ServerDefinition[];
  if (!Array.isArray(servers) || servers.length > 64 || servers.some(s => !/^[a-z][a-z0-9_-]{0,63}$/.test(s.id) || typeof s.label !== 'string' || s.label.length > 80) || new Set(servers.map(s => s.id)).size !== servers.length) throw new Error('Invalid server registry');
  const port = Number(env.PORT ?? 3000);
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 3) throw new Error('Invalid trusted proxy hop count');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  return { authMode: authMode as Config['authMode'], production, databaseUrl: required('DATABASE_URL'), serviceToken, sessionSecret, webOrigin, origins, bindHost: env.BIND_HOST ?? '127.0.0.1', port, servers, adminOrigin, matchingSecret, encryptionKey, adminBootstrapToken, trustProxyHops };
}
