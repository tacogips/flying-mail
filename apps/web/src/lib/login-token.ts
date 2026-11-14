export interface ExtractedLoginToken {
  /** The one-time token, or `null` when the URL carries none. */
  readonly token: string | null;
  /** Path plus any remaining query, with the token and hash removed. Safe
   * to hand to `history.replaceState`. */
  readonly cleanedUrl: string;
}

/** Pulls the one-time sign-in token out of a link's location.
 *
 * The token lives in the URL fragment (`#token=...`): fragments are never
 * sent to servers, written to access logs, or forwarded in `Referer`, which
 * a query string would be. The `?token=` query form is still read so links
 * emailed before that change keep working. The fragment wins when both are
 * present. */
export function extractLoginToken(location: {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}): ExtractedLoginToken {
  const fragment = new URLSearchParams(
    location.hash.startsWith("#") ? location.hash.slice(1) : location.hash,
  );
  const query = new URLSearchParams(location.search);

  const fromFragment = fragment.get("token");
  const fromQuery = query.get("token");
  const token =
    fromFragment !== null && fromFragment.length > 0
      ? fromFragment
      : fromQuery !== null && fromQuery.length > 0
        ? fromQuery
        : null;

  query.delete("token");
  const remaining = query.toString();
  return {
    token,
    cleanedUrl:
      remaining.length > 0
        ? `${location.pathname}?${remaining}`
        : location.pathname,
  };
}
