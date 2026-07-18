/**
 * Update version-floor check (security review UPD-01, anti-rollback).
 *
 * Honest scope, stated up front: this is defense-in-depth, not a complete
 * anti-rollback. Tauri's updater already refuses any version not newer than the
 * current one, and it verifies the bundle's minisign signature — but it trusts
 * the version string in `latest.json`, which is unsigned and served from the
 * release host. An attacker who controls that host could advertise a high
 * version while pointing the download at a genuine, still-signed OLD build; the
 * signature check passes and the plugin cannot tell. The real trust anchor
 * against that is the integrity of the GitHub account and release assets (2FA,
 * protected releases) — documented in docs/releasing.md.
 *
 * What the floor DOES do: refuse to offer an update whose advertised version is
 * below a compiled-in minimum, so an honestly-advertised downgrade to a known
 * bad/vulnerable line is never installed. Bump MIN_UPDATE_VERSION whenever a
 * release must never be rolled back past.
 */
export const MIN_UPDATE_VERSION = "0.1.0";

/** Compare two dotted numeric versions (ignoring any -prerelease suffix).
 *  Returns <0 if a<b, 0 if equal, >0 if a>b. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .split("-")[0] // drop -beta.2 etc; the numeric core is what orders releases
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Is `version` acceptable to install — i.e. at or above the floor? */
export function meetsUpdateFloor(version: string): boolean {
  return compareVersions(version, MIN_UPDATE_VERSION) >= 0;
}
