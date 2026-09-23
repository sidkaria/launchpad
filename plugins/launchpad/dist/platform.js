const isMac = (p) => p === 'darwin';
export function hostSupport(archetype, platform = process.platform) {
    const ok = { ci: true, local: true, macOnlySetup: [], note: '' };
    if (isMac(platform))
        return ok;
    switch (archetype) {
        case 'ios':
            return {
                ci: true,
                local: false,
                macOnlySetup: [],
                note: 'iOS builds run on CI\'s macOS runner, so this ships from here — but you cannot build ' +
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
                note: 'macOS builds run on CI\'s macOS runner, but two one-time setup steps read a Mac\'s ' +
                    'keychain, and a Mac app is impractical to develop without a Mac. Do the setup on a ' +
                    'Mac once, or skip this surface.',
            };
        default:
            return ok; // android, web-app, static-site work anywhere
    }
}
/** Surfaces the user can fully work on from this machine. */
export function locallyBuildable(archetypes, platform = process.platform) {
    return archetypes.filter(a => hostSupport(a, platform).local);
}
