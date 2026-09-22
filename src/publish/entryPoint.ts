// The stable entry point a reader can bookmark.
//
// A release directory is content-addressed, so its URL changes whenever the
// release does — including when only the viewer bundle changed, since the
// bundle is part of the digest. That is what makes a release immutable, and
// it is also why a link to one rots. `latest.json` never moves but serves
// JSON, so it cannot be the link you hand someone.
//
// This page sits beside `latest.json` at the publish root and forwards to
// whichever release that pointer names, so `https://host/<prefix>/index.html`
// renders the current dashboard and keeps doing so across republishes.
//
// It reads the pointer in the browser rather than carrying a release baked
// into it, and that is the whole design: the bytes depend only on the
// target's prefix, so every publish writes the same page and there is no
// state to keep in step with the pointer. A page that named a release would
// have to be rewritten on every publish and could fall behind — two
// publishers racing, or a publish that promoted and then failed before
// rewriting the page — and a dashboard silently showing an older release is
// the worst way for this to break. Nothing here can drift, because nothing
// here remembers anything.
//
// Reading the pointer needs script. So does the release it forwards to: the
// viewer renders nothing without it. That costs no reader anything, and the
// no-script path says so rather than linking somewhere equally unusable.

/**
 * Marks the page as ours. `promoteEntryPoint` refuses to overwrite an
 * index.html without it, so publishing into a bucket that already serves a
 * site of its own does not clobber that site's front page.
 */
export const ENTRY_POINT_MARKER = "<!-- chainplot:entry-point -->";

/** How long the page stays blank before admitting something went wrong. */
const FALLBACK_DELAY_SECONDS = 4;

/**
 * Embed a string in a script as a JSON literal.
 *
 * `</script>` inside a string ends the element early whatever JSON thinks, so
 * the slash is escaped too.
 */
function scriptLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("/", "\\/");
}

/**
 * The path from the publish root to a release, which is what the page
 * forwards to. Relative on purpose: the same bytes work under a bucket root,
 * a custom domain, or a host that serves the bucket under some path of its
 * own.
 *
 * The result goes into a URL without percent-encoding, which is safe because
 * neither half can carry a character that would change the URL's shape: a
 * target prefix is `^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9._-]+)*$` in the
 * project schema, and a release id is hex. No `#`, `?`, `%` or space can
 * reach here. Widen that pattern and this needs encoding.
 */
export function relativeReleasePath(
  releasePrefix: string,
  keyPrefix: string | null,
): string {
  if (!keyPrefix) return releasePrefix;
  const base = `${keyPrefix}/`;
  if (!releasePrefix.startsWith(base)) {
    throw new Error(
      `release prefix ${releasePrefix} is not under the target prefix ${keyPrefix}`,
    );
  }
  return releasePrefix.slice(base.length);
}

/**
 * The forwarding page for a target.
 *
 * Depends only on the prefix, so republishing a project writes identical
 * bytes however many times it runs.
 */
export function entryPointHtml(keyPrefix: string | null): string {
  const prefix = scriptLiteral(keyPrefix ?? "");
  const delay = FALLBACK_DELAY_SECONDS;
  // `replace` rather than `assign`: the forwarding page must not become a
  // history entry, or Back from the dashboard lands here and bounces forward
  // again. `no-store` because a cached pointer is the staleness this page
  // exists to avoid.
  return `<!doctype html>
${ENTRY_POINT_MARKER}
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chainplot</title>
<meta name="robots" content="noindex">
<style>
body { margin: 0; font: 14px/1.5 system-ui, sans-serif; color: #33383d; }
/* Hidden until something has gone wrong, so a redirect that works shows
   nothing at all rather than a message the reader cannot act on. */
#fallback { visibility: hidden; animation: reveal 0s ${delay}s forwards; padding: 2rem; }
@keyframes reveal { to { visibility: visible; } }
</style>
<script>
(function () {
  var PREFIX = ${prefix};
  function relative(releasePrefix) {
    var base = PREFIX ? PREFIX + "/" : "";
    if (base && releasePrefix.lastIndexOf(base, 0) !== 0) return null;
    return releasePrefix.slice(base.length);
  }
  function fail(message) {
    var note = document.getElementById("reason");
    if (note) note.textContent = message;
  }
  if (typeof fetch !== "function") return;
  fetch("latest.json", { cache: "no-store" })
    .then(function (response) {
      if (!response.ok) throw new Error("latest.json returned " + response.status);
      return response.json();
    })
    .then(function (pointer) {
      var path = pointer && pointer.release_prefix && relative(pointer.release_prefix);
      if (!path) throw new Error("latest.json names no release under this prefix");
      location.replace(path + "/index.html");
    })
    .catch(function (err) {
      fail(String((err && err.message) || err));
    });
})();
</script>
</head>
<body>
<div id="fallback">
<p><strong>This page forwards to the current release.</strong></p>
<p>It did not, which means <a href="latest.json">latest.json</a> could not be read.
<span id="reason"></span></p>
<noscript><p>It needs JavaScript, as does the dashboard it forwards to.</p></noscript>
</div>
</body>
</html>
`;
}
