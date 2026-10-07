import type {
  MailAuthorizationRule,
  MailPermissionFilter,
} from "@flying-mail/application/policies/authorization";
import type { SqlValue } from "@flying-mail/application/ports/sql-database";
import {
  type AddressPattern,
  addressPatternToLikeExpression,
} from "@flying-mail/domain/value-objects/address-pattern";

/** Column-parametrized generalization of `message-repository-queries.ts`'s
 * pattern/rule condition builders, for repositories whose owning address
 * lives in exactly one column (`mail_addresses.address`) rather than split
 * across a sender column and a recipients join the way `messages` is.
 * Address books and contacts are scoped by their owning mail address, so
 * `contactPermissionListFilter`/`readableAddressPatterns` are rendered
 * through here instead of duplicating the pattern-matching algorithm. */

/** A `WHERE` fragment plus its bind parameters, in order. */
export interface SqlCondition {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

/** One address pattern against one column, rendered as the condition it
 * matches. `"*"` always matches, so its caller decides separately what an
 * unrestricted pattern means for the *whole* filter -- this function never
 * collapses anything on its own. */
export function singleColumnPatternCondition(
  column: string,
  pattern: string,
): SqlCondition {
  const like = addressPatternToLikeExpression(pattern as AddressPattern);
  if (like === null) {
    // Only "*" renders to null.
    return { sql: "1 = 1", params: [] };
  }
  if (like.includes("%")) {
    return { sql: `${column} LIKE ? ESCAPE '\\'`, params: [like] };
  }
  return { sql: `${column} = ?`, params: [like] };
}

/** Renders the viewer's scope-derived address allowlist against `column`.
 *
 * An **empty** allowlist means the viewer holds no matching scope and must
 * see nothing, so it renders as a literal false rather than being omitted.
 * Omitting it would silently widen the query to everything, which is the
 * exact failure this filter exists to prevent. */
function allowedPatternsColumnCondition(
  column: string,
  patterns: readonly string[],
): SqlCondition | null {
  if (patterns.length === 0) {
    return { sql: "0 = 1", params: [] };
  }

  const clauses: string[] = [];
  const params: SqlValue[] = [];
  for (const pattern of patterns) {
    if (pattern === "*") {
      // A single match-all pattern makes the whole allowlist a no-op.
      return null;
    }
    const clause = singleColumnPatternCondition(column, pattern);
    clauses.push(clause.sql);
    params.push(...clause.params);
  }
  return { sql: `(${clauses.join(" OR ")})`, params };
}

/** The scope allowlist as a reusable condition over `column`. Returns
 * `null` when unrestricted, `"NONE"` when the viewer can see nothing (empty
 * allowlist), otherwise the SQL fragment. */
export function buildAllowedPatternsColumnCondition(
  column: string,
  patterns: readonly string[] | null,
): SqlCondition | "NONE" | null {
  if (patterns === null) {
    return null;
  }
  if (patterns.length === 0) {
    return "NONE";
  }
  return allowedPatternsColumnCondition(column, patterns);
}

/** One mailbox rule's own `(domainId, addressPattern)` pairing, rendered as
 * a self-contained condition against `domainColumn`/`addressColumn`. Never
 * combine a rule's domain with another rule's pattern -- that is exactly
 * the cross-product this shape (and this function taking the whole rule at
 * once) is meant to make impossible. */
function mailRuleColumnCondition(
  domainColumn: string,
  addressColumn: string,
  rule: MailAuthorizationRule,
): SqlCondition {
  const addressClause = singleColumnPatternCondition(
    addressColumn,
    rule.addressPattern,
  );
  if (rule.domainId === null) {
    return addressClause;
  }
  return {
    sql: `(${domainColumn} = ? AND ${addressClause.sql})`,
    params: [rule.domainId, ...addressClause.params],
  };
}

function combineRuleColumnConditions(
  domainColumn: string,
  addressColumn: string,
  rules: readonly MailAuthorizationRule[],
): SqlCondition {
  const clauses = rules.map((rule) =>
    mailRuleColumnCondition(domainColumn, addressColumn, rule),
  );
  return {
    sql: `(${clauses.map((clause) => clause.sql).join(" OR ")})`,
    params: clauses.flatMap((clause) => [...clause.params]),
  };
}

/** Renders a USER viewer's mailbox-rule scoping (`ADMIN`/`MEMBER`/`VIEWER`)
 * as a reusable condition over `domainColumn`/`addressColumn`. Returns
 * `null` when unrestricted (a baseline viewer with no `DENY` rules, an
 * API-key viewer, or a global capability), `"NONE"` when a non-baseline
 * viewer holds no `ALLOW` rule at all (must see nothing), otherwise the SQL
 * fragment. Mirrors `message-repository-queries.ts`'s
 * `buildMailPermissionFilterCondition`, generalized to an arbitrary owning
 * address column instead of `messages`' sender-plus-recipients shape. */
export function buildMailPermissionColumnFilterCondition(
  domainColumn: string,
  addressColumn: string,
  filter: MailPermissionFilter | null,
): SqlCondition | "NONE" | null {
  if (filter === null) {
    return null;
  }
  const denyRules = filter.rules.filter((rule) => rule.effect === "DENY");
  const allowRules = filter.rules.filter((rule) => rule.effect === "ALLOW");

  if (!filter.baseline && allowRules.length === 0) {
    return "NONE";
  }

  const visibility =
    filter.baseline || allowRules.length === 0
      ? null // Baseline access covers everything; no ALLOW clause needed.
      : combineRuleColumnConditions(domainColumn, addressColumn, allowRules);
  const deny =
    denyRules.length === 0
      ? null
      : combineRuleColumnConditions(domainColumn, addressColumn, denyRules);

  if (visibility === null && deny === null) {
    // Baseline with no denies at all: fully unrestricted.
    return null;
  }
  const parts: SqlCondition[] = [];
  if (visibility !== null) {
    parts.push(visibility);
  }
  if (deny !== null) {
    parts.push({ sql: `NOT (${deny.sql})`, params: deny.params });
  }
  const [first] = parts;
  if (parts.length === 1 && first !== undefined) {
    return first;
  }
  return {
    sql: `(${parts.map((part) => part.sql).join(" AND ")})`,
    params: parts.flatMap((part) => [...part.params]),
  };
}
