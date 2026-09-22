import type { MacosConfig } from './archetypes/macos.js';
import type { IosConfig } from './archetypes/ios.js';
import type { AndroidConfig } from './archetypes/android.js';
import type { SiteConfig } from './archetypes/site.js';
import type { WebConfig } from './archetypes/web.js';

export type SurfaceConfig = MacosConfig | IosConfig | AndroidConfig | SiteConfig | WebConfig;

export type Archetype =
  | 'macos-dmg'
  | 'ios'
  | 'android'
  | 'web-app'
  | 'static-site';

export type SurfaceStatus = 'pending' | 'wired' | 'needs-credential' | 'needs-input';

export type Confidence = 'high' | 'low';

/**
 * What BUILDS a mobile surface, as opposed to which store it ships to.
 *
 * Two surfaces can share an archetype and need completely different pipelines:
 * `flutter build apk` and `./gradlew bundleRelease` are both "the android
 * surface". Recording which one it is at DETECTION time — rather than waiting
 * for the onboard skill to ask — is what lets `apply` refuse the combinations it
 * cannot build instead of emitting a workflow that looks right and dies in CI.
 */
export type SurfaceFramework = 'flutter' | 'native' | 'react-native' | 'expo';

export interface Surface {
  id: string;            // unique within a repo, e.g. "ios", "sender"
  archetype: Archetype;
  status: SurfaceStatus;
  evidence: string[];    // why detection believes this
  confidence: Confidence;
  /**
   * How this surface is built, when detection can tell. Absent on a state file
   * written before this existed, which is why every reader defaults it rather
   * than requiring it.
   */
  framework?: SurfaceFramework;
  bundleId?: string;
  target?: string;       // xcode scheme / flutter platform dir
  config?: SurfaceConfig;  // archetype-specific config (e.g. macOS pipeline)
}

export type PipelineKind =
  | 'github-actions'
  | 'fastlane'
  | 'sparkle-dmg'
  | 'vercel'
  | 'heartbeat';

export type Disposition = 'adopt' | 'migrate' | 'leave-alone';

export interface DetectedPipeline {
  kind: PipelineKind;
  path: string;                 // repo-relative
  disposition?: Disposition;    // decided in a later milestone
}

/**
 * Something that looked like a surface and deliberately did not become one.
 *
 * Detection's silences used to be indistinguishable from its blind spots. A
 * Flutter monorepo with twelve packages reported surfaces for two of them and
 * said nothing about the other ten; a Tauri app's frontend became a Vercel
 * deployment because nothing connected it to the desktop binary it belongs to.
 * In both cases the *decision* was defensible and the absence of any record of
 * it was not — a buyer is told confidently about half their repository and never
 * learns the other half was considered.
 *
 * So a skip is a first-class output, with the reason attached.
 */
export interface SkippedCandidate {
  /** Repo-relative path; `.` for the repository root. */
  path: string;
  /** What it appeared to be. */
  what: string;
  /** Why no surface was emitted for it. */
  why: string;
}

export interface DetectionResult {
  surfaces: Surface[];
  pipelines: DetectedPipeline[];
  /** Candidates considered and rejected, so nothing is lost silently. */
  skipped?: SkippedCandidate[];
  /**
   * What the repo IS, when it is recognisable — "Rust CLI", "Django app".
   *
   * Separate from `surfaces`, which answers the narrower question of what
   * launchpad ships a pipeline for. Conflating the two is what made Rails and
   * Rust produce identical output: both have no surface, and the product had no
   * other vocabulary for them.
   */
  ecosystem?: string;
}

export interface LaunchpadState {
  project: string;
  surfaces: Surface[];
  pipelines: DetectedPipeline[];
  credentialsRequired: string[];
  /** What this repo is, for display. Re-derived on every scorecard run, never trusted as cache. */
  ecosystem?: string;
  notes?: string;
}
