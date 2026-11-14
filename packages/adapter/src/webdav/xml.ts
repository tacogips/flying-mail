/** A deliberately small, namespace-tolerant XML reader for WebDAV
 * `multistatus` bodies.
 *
 * Neither Bun nor workerd ships a DOM parser, and pulling an XML dependency
 * into a Worker bundle to read four element names is not a trade worth
 * making. Everything here matches on the *local* name (`response`,
 * `getetag`, ...) because servers disagree about prefixes: iCloud emits
 * `<D:response>`, others `<d:response>` or an unprefixed default namespace,
 * and all three mean the same thing. */

export interface XmlNode {
  /** Local name, lower-cased and namespace-prefix stripped. */
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlNode[];
  /** Direct character data, entity-decoded and trimmed of surrounding
   * whitespace-only formatting. */
  readonly text: string;
}

interface MutableXmlNode {
  name: string;
  attributes: Map<string, string>;
  children: MutableXmlNode[];
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const REPLACEMENT_CHARACTER = "\uFFFD";
const MAX_CODE_POINT = 0x10ffff;

/** Maps a numeric character reference to its character. A reference to a
 * NUL, a surrogate, or a value past U+10FFFF is not a legal XML character,
 * and `String.fromCodePoint` would throw on the last of those; each becomes
 * U+FFFD so decoding stays total. */
function codePointToString(code: number): string {
  if (
    !Number.isInteger(code) ||
    code <= 0 ||
    code > MAX_CODE_POINT ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return REPLACEMENT_CHARACTER;
  }
  return String.fromCodePoint(code);
}

export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g,
    (_match, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X")) {
        return codePointToString(Number.parseInt(body.slice(2), 16));
      }
      if (body.startsWith("#")) {
        return codePointToString(Number.parseInt(body.slice(1), 10));
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? `&${body};`;
    },
  );
}

export function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function localName(raw: string): string {
  const colon = raw.indexOf(":");
  return (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase();
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(source);
  while (match !== null) {
    const value = match[3] ?? match[4] ?? "";
    attributes.set(localName(match[1] ?? ""), decodeXmlEntities(value));
    match = pattern.exec(source);
  }
  return attributes;
}

/** Iterative, so the depth of the tree never reaches the call stack. */
function freeze(root: MutableXmlNode): XmlNode {
  interface FrozenNode {
    readonly name: string;
    readonly attributes: ReadonlyMap<string, string>;
    readonly children: XmlNode[];
    readonly text: string;
  }
  const toFrozen = (node: MutableXmlNode): FrozenNode => ({
    name: node.name,
    attributes: node.attributes,
    children: [],
    text: node.text.trim(),
  });
  const frozenRoot = toFrozen(root);
  const pending: { source: MutableXmlNode; target: FrozenNode }[] = [
    { source: root, target: frozenRoot },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    for (const child of next.source.children) {
      const frozenChild = toFrozen(child);
      next.target.children.push(frozenChild);
      pending.push({ source: child, target: frozenChild });
    }
  }
  return frozenRoot;
}

/** Deepest element nesting that will be parsed. Real multistatus bodies are
 * under ten levels; a hostile server could otherwise send megabytes of
 * `<a>` to build an arbitrarily deep tree. */
export const MAX_XML_DEPTH = 64;

/** Parses a document into its root element, or `null` when there is no
 * well-formed root or the nesting exceeds {@link MAX_XML_DEPTH}. Malformed
 * input yields `null` rather than throwing: a server that returns an HTML
 * error page should surface as "no responses", which the caller already
 * handles. */
export function parseXml(source: string): XmlNode | null {
  const stack: MutableXmlNode[] = [];
  let root: MutableXmlNode | null = null;
  let index = 0;

  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) {
      break;
    }
    if (open > index) {
      const text = source.slice(index, open);
      const parent = stack[stack.length - 1];
      if (parent !== undefined) {
        parent.text += decodeXmlEntities(text);
      }
    }

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open);
      const body = source.slice(open + 9, end === -1 ? source.length : end);
      const parent = stack[stack.length - 1];
      if (parent !== undefined) {
        parent.text += body;
      }
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith("<?", open) || source.startsWith("<!", open)) {
      const end = source.indexOf(">", open);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const close = source.indexOf(">", open);
    if (close === -1) {
      break;
    }
    const raw = source.slice(open + 1, close).trim();
    index = close + 1;

    if (raw.startsWith("/")) {
      const finished = stack.pop();
      if (finished !== undefined && stack.length === 0) {
        root = finished;
      }
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const space = body.search(/\s/);
    const name = localName(space === -1 ? body : body.slice(0, space));
    const node: MutableXmlNode = {
      name,
      attributes:
        space === -1 ? new Map() : parseAttributes(body.slice(space + 1)),
      children: [],
      text: "",
    };
    // `stack` holds the ancestors, so this node sits at `stack.length + 1`.
    if (stack.length >= MAX_XML_DEPTH) {
      return null;
    }
    const parent = stack[stack.length - 1];
    if (parent !== undefined) {
      parent.children.push(node);
    }
    if (selfClosing) {
      if (parent === undefined) {
        root = node;
      }
      continue;
    }
    stack.push(node);
  }

  if (root === null && stack.length > 0) {
    root = stack[0] ?? null;
  }
  return root === null ? null : freeze(root);
}

export function findChildren(node: XmlNode, name: string): readonly XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

export function findChild(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((child) => child.name === name) ?? null;
}

/** Depth-first search over the whole subtree. Used for properties whose
 * nesting depth varies between servers (`sync-token` may sit on the
 * multistatus or inside a propstat). */
export function findDescendants(
  node: XmlNode,
  name: string,
): readonly XmlNode[] {
  const found: XmlNode[] = [];
  // Iterative pre-order walk; children are pushed reversed so they are
  // visited in document order.
  const pending: XmlNode[] = [...node.children].reverse();
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next.name === name) {
      found.push(next);
    }
    for (let i = next.children.length - 1; i >= 0; i -= 1) {
      const child = next.children[i];
      if (child !== undefined) {
        pending.push(child);
      }
    }
  }
  return found;
}

export function findDescendant(node: XmlNode, name: string): XmlNode | null {
  return findDescendants(node, name)[0] ?? null;
}

export interface PropstatEntry {
  /** The raw `<status>` line, e.g. `HTTP/1.1 200 OK`. */
  readonly status: string;
  readonly statusCode: number | null;
  readonly prop: XmlNode | null;
}

export interface MultistatusResponse {
  readonly href: string;
  /** Some servers put the status directly on the response (notably for the
   * `404` entries a `sync-collection` report returns for deletions) rather
   * than in a propstat. */
  readonly status: string | null;
  readonly statusCode: number | null;
  readonly propstats: readonly PropstatEntry[];
}

export interface Multistatus {
  readonly responses: readonly MultistatusResponse[];
  readonly syncToken: string | null;
}

function statusCodeOf(status: string | null): number | null {
  if (status === null) {
    return null;
  }
  const match = /\s(\d{3})\s?/.exec(status);
  return match === null ? null : Number(match[1]);
}

export function parseMultistatus(xml: string): Multistatus {
  const root = parseXml(xml);
  if (root === null) {
    return { responses: [], syncToken: null };
  }
  const responses: MultistatusResponse[] = [];
  for (const response of findDescendants(root, "response")) {
    const href = findChild(response, "href")?.text ?? "";
    const directStatus = findChild(response, "status")?.text ?? null;
    const propstats: PropstatEntry[] = findChildren(response, "propstat").map(
      (propstat) => {
        const status = findChild(propstat, "status")?.text ?? "";
        return {
          status,
          statusCode: statusCodeOf(status),
          prop: findChild(propstat, "prop"),
        };
      },
    );
    responses.push({
      href: decodeXmlEntities(href),
      status: directStatus,
      statusCode: statusCodeOf(directStatus),
      propstats,
    });
  }

  // `sync-token` sits on the multistatus itself, but only outside a
  // `<response>` -- a response may legitimately contain none.
  const tokenNode = root.children.find((child) => child.name === "sync-token");
  return {
    responses,
    syncToken:
      tokenNode === undefined || tokenNode.text.length === 0
        ? null
        : tokenNode.text,
  };
}

/** First `200 OK` propstat property with `name`, across every propstat of a
 * response. A `404` propstat carrying the same name is ignored, which is how
 * servers report "this property is not defined here". */
export function findOkProp(
  response: MultistatusResponse,
  name: string,
): XmlNode | null {
  for (const propstat of response.propstats) {
    if (propstat.statusCode !== null && propstat.statusCode !== 200) {
      continue;
    }
    const prop = propstat.prop;
    if (prop === null) {
      continue;
    }
    const found = findChild(prop, name);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

export function findOkPropText(
  response: MultistatusResponse,
  name: string,
): string | null {
  const node = findOkProp(response, name);
  if (node === null) {
    return null;
  }
  return node.text.length === 0 ? null : node.text;
}
