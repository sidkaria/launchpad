export interface Zone {
  id: string;      // Cloudflare zone id — needed to write records into it
  name: string;    // e.g. "myapp.com"
  status: string;  // "active" | "pending" | "initializing" | ...
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Fuzzy-match a project slug to the best-fitting zone; null if none.
export function matchDomain(project: string, zones: Zone[]): string | null {
  const slug = normalize(project);
  if (!slug) return null;
  const prefixes = ['', 'get', 'try', 'use'];
  for (const z of zones) {
    const sld = normalize(z.name.split('.')[0]);
    for (const p of prefixes) {
      if (sld === p + slug || sld === slug + 'app') return z.name;
    }
  }
  return null;
}

/**
 * The DNS targets Vercel points a custom domain at. These are Vercel's
 * long-standing, documented values (the same ones the dashboard tells you to
 * enter by hand): an apex gets an A record to the anycast IP; any subdomain
 * gets a CNAME to the vercel-dns edge. They are constants, not per-account —
 * if Vercel ever changes them this is the one place to update.
 */
export const VERCEL_APEX_A = '76.76.21.21';
export const VERCEL_SUBDOMAIN_CNAME = 'cname.vercel-dns.com';

export interface PlannedRecord {
  type: 'A' | 'CNAME';
  name: string;        // the record's FQDN (apex uses the zone name itself)
  content: string;
  proxied: false;      // Vercel-pointed records must be DNS-only, never proxied
}

/**
 * Which of the account's zones owns a domain — the apex zone, or the most
 * specific zone a subdomain sits under. `null` means the domain was bought
 * somewhere other than this Cloudflare account, so there is nothing here to
 * write into (the caller should stop rather than guess).
 */
export function zoneForDomain(domain: string, zones: Zone[]): Zone | null {
  const d = domain.toLowerCase().replace(/\.$/, '');
  let best: Zone | null = null;
  for (const z of zones) {
    const zn = z.name.toLowerCase();
    if (d === zn || d.endsWith('.' + zn)) {
      if (!best || z.name.length > best.name.length) best = z;
    }
  }
  return best;
}

/**
 * The record(s) needed to point `domain` at its Vercel project, given the zone
 * that owns it. An apex is an A record; a subdomain is a CNAME. Cloudflare
 * flattens a CNAME at the apex, but Vercel's apex guidance is the A record, so
 * that is what we plan — one predictable record per call, no www guesswork.
 */
export function plannedRecords(domain: string, zone: Zone): PlannedRecord[] {
  const d = domain.toLowerCase().replace(/\.$/, '');
  if (d === zone.name.toLowerCase()) {
    return [{ type: 'A', name: d, content: VERCEL_APEX_A, proxied: false }];
  }
  return [{ type: 'CNAME', name: d, content: VERCEL_SUBDOMAIN_CNAME, proxied: false }];
}
