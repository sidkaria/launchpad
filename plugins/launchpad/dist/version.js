export function isSemver(v) {
    return /^\d+\.\d+\.\d+$/.test(v);
}
export function bumpXcodeVersion(pbxproj, version) {
    return pbxproj
        .replace(/MARKETING_VERSION = [^;]*;/g, `MARKETING_VERSION = ${version};`)
        .replace(/CURRENT_PROJECT_VERSION = [^;]*;/g, `CURRENT_PROJECT_VERSION = ${version};`);
}
export function bumpXcodegenVersion(yaml, version) {
    return yaml
        .replace(/MARKETING_VERSION:.*/g, `MARKETING_VERSION: "${version}"`)
        .replace(/CURRENT_PROJECT_VERSION:.*/g, `CURRENT_PROJECT_VERSION: "${version}"`);
}
// A Flutter app's whole version is one line: `version: <marketing>+<build>`.
const PUBSPEC_VERSION = /^version:[ \t]*([^\s+#]+)(?:\+(\d+))?([ \t]*(?:#.*)?)$/m;
/**
 * Bump a Flutter `pubspec.yaml`.
 *
 * The marketing half is SET to `version`; the build half is **incremented,
 * never set**. The Xcode bumpers write the same semver string into both
 * fields, which cannot work here: Android requires `versionCode` to be a
 * monotonically increasing integer, and TestFlight rejects a `CFBundleVersion`
 * it has already seen for a given marketing version — so re-releasing 1.2.3
 * has to move the build number even though the marketing version stands still.
 *
 * Only a TOP-LEVEL `version:` is touched. Anchoring at column 0 is what keeps
 * an indented dependency constraint (`  version: ^1.0.0` under `dependencies:`)
 * from being rewritten into nonsense.
 *
 * Throws rather than no-op: a silent miss here looks like a successful release
 * and only surfaces as a duplicate-build rejection after CI has paid for the
 * whole build.
 */
export function bumpPubspecVersion(yaml, version) {
    if (!PUBSPEC_VERSION.test(yaml)) {
        throw new Error('pubspec.yaml has no top-level `version:` line — add one (e.g. `version: 1.0.0+1`) before releasing.');
    }
    return yaml.replace(PUBSPEC_VERSION, (_full, _marketing, build, tail) => `version: ${version}+${Number(build ?? 0) + 1}${tail}`);
}
