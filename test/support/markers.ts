// The planted privacy markers of ¶9.3: `PLANTED-<rule>-<n>` values placed in hidden fields of the fixture families and of the
// privacy calls' extra entries (test/privacy/noLeak.test.ts). No reply, continuation or log line may contain any of them.
// `MARKERS` lists the 48 that the privacy calls must reach (the "every marker planted and reached" checks); `findMarkers`
// sweeps for every `PLANTED…` value, so it also catches the ad-hoc plants of other tests (`PLANTED-INSERT`,
// `PLANTEDhiddenPst1`, …) and `PLANTED-P10-1` from stored cursor state. No visible fixture field contains `PLANTED`.

const range = (rule: string, n: number): string[] => Array.from({ length: n }, (_, i) => `PLANTED-${rule}-${i + 1}`);

/** The 48 markers, by rule, then by number. */
export const MARKERS: readonly string[] = [
  ...range("P1", 2), ...range("P2", 6), ...range("P3", 2), ...range("P4", 1), ...range("P5", 2), ...range("P6", 2),
  ...range("P7", 4), ...range("P8", 2), ...range("P11", 2), ...range("P12", 12), ...range("P13", 2), ...range("P14", 5),
  ...range("P15", 3), ...range("P16", 2), ...range("P19", 1),
];

/** Markers in fields no template selects (or in a request no flow sends): they never reach the fake forum's answers. */
export const NEVER_FETCHED: readonly string[] = ["PLANTED-P5-1", "PLANTED-P13-2", "PLANTED-P14-1"];

/** The distinct planted values in `text`, in order of first appearance. */
export function findMarkers(text: string): string[] {
  return [...new Set(text.match(/PLANTED[A-Za-z0-9-]*/g) ?? [])];
}
