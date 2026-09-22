import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { writeGuarded, type WriteResult } from '../generated.js';

export interface PaymentsConfig {
  appName: string;
  destDir: string;            // repo-relative dir for the Swift files (e.g. 'apps/Sender/Licensing')
  keychainAccount: string;    // e.g. 'MyApp-License'
  graceDays: number;          // offline grace, e.g. 7
  checkoutUrl: string;        // LS hosted checkout URL (variant)
  tagline: string;
  priceLine: string;          // e.g. '$12 · One-time purchase'
  accentHex: string;          // no '#'
  bgHex: string;
  inkHex: string;
  headlineFontDesign: string; // SwiftUI design token: '.serif' | '.rounded' | '.default' | '.monospaced'
  trialDays?: number;         // >0 enables a client-only free trial; 0/undefined = no trial (default)
  priceAmount?: string;       // CTA price, e.g. '$6.99'; defaults to priceLine
}

export interface GeneratedFile { path: string; contents: string; }

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'payments');
const tmpl = (n: string) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');

export function planPaymentsFiles(c: PaymentsConfig): GeneratedFile[] {
  const hasTrial = (c.trialDays ?? 0) > 0;
  const priceAmount = c.priceAmount ?? c.priceLine;
  const buyLabel = hasTrial ? `Unlock lifetime — ${priceAmount}` : 'Buy License';

  const mgrVars = { KEYCHAIN_ACCOUNT: c.keychainAccount, GRACE_DAYS: String(c.graceDays) };
  const viewVars = {
    APP_NAME: c.appName, TAGLINE: c.tagline, PRICE_LINE: c.priceLine, CHECKOUT_URL: c.checkoutUrl,
    ACCENT_HEX: c.accentHex, BG_HEX: c.bgHex, INK_HEX: c.inkHex, HEADLINE_FONT_DESIGN: c.headlineFontDesign,
    BUY_LABEL: buyLabel,
  };

  const files: GeneratedFile[] = [
    { path: `${c.destDir}/LicenseManager.swift`, contents: render(tmpl('LicenseManager.swift'), mgrVars) },
    { path: `${c.destDir}/LicenseView.swift`, contents: render(tmpl('LicenseView.swift'), viewVars) },
    {
      path: `${c.destDir}/LicenseGate.swift`,
      contents: hasTrial ? tmpl('LicenseGate.trial.swift') : tmpl('LicenseGate.swift'),
    },
  ];

  if (hasTrial) {
    const trialVars = { KEYCHAIN_ACCOUNT: c.keychainAccount, TRIAL_DAYS: String(c.trialDays) };
    const gateViewVars = {
      APP_NAME: c.appName, PRICE_AMOUNT: priceAmount, CHECKOUT_URL: c.checkoutUrl,
      ACCENT_HEX: c.accentHex, BG_HEX: c.bgHex, INK_HEX: c.inkHex,
      HEADLINE_FONT_DESIGN: c.headlineFontDesign, TAGLINE: c.tagline,
    };
    files.push(
      { path: `${c.destDir}/TrialManager.swift`, contents: render(tmpl('TrialManager.swift'), trialVars) },
      { path: `${c.destDir}/TrialGateView.swift`, contents: render(tmpl('TrialGateView.swift'), gateViewVars) },
    );
  }

  return files;
}

/**
 * Guarded, like every other archetype's writer.
 *
 * This one wrote unconditionally, which is how a field fix to a generated
 * workflow got reverted on the next `apply` — silently, and back to shipping
 * commit messages as release notes. `writeGuarded` keeps somebody else's file,
 * keeps an edit to ours, and rewrites only our own untouched output.
 */
export function writePaymentsFiles(repo: string, c: PaymentsConfig): WriteResult {
  return writeGuarded(repo, planPaymentsFiles(c));
}
