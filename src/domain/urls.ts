// Layer 3. The link rules of ¶3.1.3: every URL is built from a visible item's own ids and slugs and printed only for
// items the reader may see. AF items link to the Alignment Forum host, everything else to LessWrong. Every id and slug
// path segment is percent-encoded. Imports nothing.

const LESSWRONG = "https://www.lesswrong.com";
const ALIGNMENT_FORUM = "https://www.alignmentforum.org";

const host = (af: boolean): string => (af ? ALIGNMENT_FORUM : LESSWRONG);

function postPath(p: { _id: string; slug: string }): string {
  return `/posts/${encodeURIComponent(p._id)}/${encodeURIComponent(p.slug)}`;
}

/** ¶3.1.3, Q50.7: `/posts/<id>/<slug>` on the AF host for an AF post, else on LessWrong. */
export function postUrl(p: { _id: string; slug: string; af: boolean }): string {
  return host(p.af) + postPath(p);
}

/** ¶3.1.3: `https://www.lesswrong.com/users/<slug>`. */
export function userUrl(slug: string): string {
  return `${LESSWRONG}/users/${encodeURIComponent(slug)}`;
}

/** ¶3.1.3: `https://www.lesswrong.com/w/<slug>` (tags have no `pageUrl`, §3.3). */
export function tagUrl(slug: string): string {
  return `${LESSWRONG}/w/${encodeURIComponent(slug)}`;
}

/** ¶3.1.3: `/s/<id>`, on the AF host when the sequence is on AF. */
export function sequenceUrl(id: string, af: boolean): string {
  return `${host(af)}/s/${encodeURIComponent(id)}`;
}
