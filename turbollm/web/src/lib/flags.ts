/**
 * Build-time feature flags for the web UI.
 *
 * These are plain constants (not env-driven) so they tree-shake out of the
 * production bundle when disabled — a flag set to `false` removes the gated UI
 * and its imports from the shipped assets entirely.
 */

/**
 * Telemetry / analytics UI (Settings → Privacy & telemetry, spec 09 §5).
 *
 * OFF for the MVP launch (ADR-041): the daemon ships no telemetry uploader
 * backend (the local queue + payload-preview code is dormant — nothing is
 * transmitted), so we hide the consent surface rather than offer a control that
 * does nothing. The `PrivacySection` and its queries remain in the codebase and
 * re-enable in one line when the uploader backend lands post-launch (amends
 * ADR-008). With this `false`, `telemetryLevel` stays at its `'off'` default.
 */
export const TELEMETRY_UI_ENABLED = false
