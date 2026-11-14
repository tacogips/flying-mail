/** Resolves a WebDAV href that may be absolute, root-relative, or relative. */
export function resolveHref(href: string, baseUrl: string): string {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}
