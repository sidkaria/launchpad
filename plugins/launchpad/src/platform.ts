import type { Archetype } from './types.js';

/**
 * What a given surface needs from THIS machine, as opposed to from CI.
 *
 * The naive rule — "Apple surfaces require macOS" — is wrong and would cost
 * users real capability. launchpad builds on GitHub-hosted `macos-15` runners,
 * so an iOS app is built, signed and uploaded to TestFlight by CI no matter
 * what the developer is sitting in front of. What a non-Mac host actually
 * loses is the ability to run the app locally, and a couple of one-time setup
 * steps that read the login keychain.
 *
 * On the default cloud signing an iOS surface has NO Mac-only setup step at
 * all: the App Store Connect key is created in a web portal, the app record
 * via `fastlane produce`, and the runner mints the distribution certificate
 * itself. A Windows or Linux developer can ship an iOS app to TestFlight
 * through launchpad without owning a Mac.
 */
export interface HostSupport {
  /** Can CI build and ship this surface from this repo? Always true — CI picks the runner. */
  ci: true;
  /** Can the developer build/run this surface on the machine they are using now? */
  local: boolean;
  /** One-time setup steps that need a Mac, empty when there are none. */
  macOnlySetup: string[];
  /** Plain-language note for the user, or '' when everything works here. */
  note: string;
}

const isMac = (p: NodeJS.Platform) => p === 'darwin';

export function hostSupport(archetype: Archetype, platform: NodeJS.Platform = process.platform): HostSupport {
  const ok: HostSupport = { ci: true, local: true, macOnlySetup: [], note: '' };
  if (isMac(platform)) return ok;

  switch (archetype) {
    case 'ios':
      return {
        ci: true,
        local: false,
        macOnlySetup: [],
        note:
          'iOS builds run on CI\'s macOS runner, so this ships from here — but you cannot build ' +
          'or run it locally without a Mac. On the default cloud signing there is no Mac-only ' +
          'setup step: the App Store Connect key comes from a web portal and the runner mints ' +
          'the certificate. (Opting into `match` signing does need a Mac once, to create the ' +
          'shared certificate.)',
      };
    case 'macos-dmg':
      return {
        ci: true,
        local: false,
        macOnlySetup: [
          'export the Developer ID Application certificate from the login keychain',
          'generate the per-app Sparkle update-signing key (`generate_keys` from Sparkle\'s release tarball)',
        ],
        note:
          'macOS builds run on CI\'s macOS runner, but two one-time setup steps read a Mac\'s ' +
          'keychain, and a Mac app is impractical to develop without a Mac. Do the setup on a ' +
          'Mac once, or skip this surface.',
      };
    default:
      return ok;   // android, web-app, static-site work anywhere
  }
}

/** Surfaces the user can fully work on from this machine. */
export function locallyBuildable(archetypes: Archetype[], platform: NodeJS.Platform = process.platform): Archetype[] {
  return archetypes.filter(a => hostSupport(a, platform).local);
}
