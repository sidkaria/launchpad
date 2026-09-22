export interface WebConfig {
  project: string;       // Vercel project name
  rootDir: string;       // repo-relative root for monorepo subpackages ('apps/web' or '.')
  framework: string;     // 'nextjs' | 'vite' | ...
  prodDomain: string;    // '' until a custom domain is wired
}

export const WEB_GLOBAL_SECRETS = ['VERCEL_TOKEN'];

// Vercel uses native git integration (preview-per-branch + prod on main),
// so launchpad generates no workflow here — the setup skill links the project,
// sets the root directory, syncs env, and binds the domain via the Vercel API/CLI.
export function webWiringSteps(c: WebConfig): string[] {
  return [
    `vercel link --project ${c.project} --yes`,
    c.rootDir === '.' ? `# root directory: repo root` : `# set Vercel project Root Directory to ${c.rootDir}`,
    `vercel pull --yes   # sync env`,
    c.prodDomain ? `launchpad domains --wire ${c.prodDomain}   # attach domain + create Cloudflare DNS` : `# no custom domain yet -> using ${c.project}.vercel.app`,
  ];
}
