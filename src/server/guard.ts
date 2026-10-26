// Every route, reads included, rejects requests not addressed to this machine by name:
// this is what stops DNS rebinding, where a web page re-points its own domain to 127.0.0.1.
import type { IncomingMessage } from 'node:http';

export function allowedHosts(port: number): ReadonlySet<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

export function rejectReason(req: IncomingMessage, hosts: ReadonlySet<string>): string | null {
  const host = req.headers.host;
  if (!host || !hosts.has(host.toLowerCase())) return 'hôte refusé';
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let originHost: string | null = null;
    try {
      const url = new URL(origin);
      originHost = url.protocol === 'http:' ? url.host : null;
    } catch {
      originHost = null;
    }
    if (!originHost || !hosts.has(originHost)) return 'origine refusée';
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'requête inter-sites refusée';
  return null;
}
