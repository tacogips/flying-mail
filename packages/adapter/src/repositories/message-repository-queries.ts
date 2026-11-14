import type {
  MailAuthorizationRule,
  MailPermissionFilter,
} from "@mailcal/application/policies/authorization";
import type { MessageListFilter } from "@mailcal/application/ports/message-repository";
import type { SqlValue } from "@mailcal/application/ports/sql-database";
import { FetchStatus } from "@mailcal/domain/entities/fetch-state";
import { RecipientKind } from "@mailcal/domain/entities/message";
import { addressPatternToLikeExpression } from "@mailcal/domain/value-objects/address-pattern";
import {
  buildInPlaceholders,
  decodeCursor,
  escapeLikePattern,
} from "./sql-helpers";

/** A `WHERE` fragment plus its bind parameters, in order. */
export interface SqlCondition {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

/** Matches a message by any of its addresses -- sender or recipient. */
function anyAddressCondition(address: string): SqlCondition {
  return {
    sql: `(messages.from_address = ? OR EXISTS (
            SELECT 1 FROM message_recipients r
            WHERE r.message_id = messages.id AND r.address = ?
          ))`,
    params: [address, address],
  };
}

/** A single address pattern, rendered as the condition it matches against
 * `messages.from_address` and every recipient. `"*"` always matches, so its
 * caller decides separately what an unrestricted pattern means for the
 * *whole* filter -- this function never collapses anything on its own. */
function singlePatternCondition(pattern: string): SqlCondition {
  const like = addressPatternToLikeExpression(
    pattern as Parameters<typeof addressPatternToLikeExpression>[0],
  );
  if (like === null) {
    // Only "*" renders to null.
    return { sql: "1 = 1", params: [] };
  }
  if (like.includes("%")) {
    return {
      sql: `(messages.from_address LIKE ? ESCAPE '\\' OR EXISTS (
              SELECT 1 FROM message_recipients r
              WHERE r.message_id = messages.id AND r.address LIKE ? ESCAPE '\\'
            ))`,
      params: [like, like],
    };
  }
  return {
    sql: `(messages.from_address = ? OR EXISTS (
            SELECT 1 FROM message_recipients r
            WHERE r.message_id = messages.id AND r.address = ?
          ))`,
    params: [like, like],
  };
}

/** Renders the viewer's scope-derived address allowlist.
 *
 * An **empty** allowlist means the viewer holds no matching scope and must
 * see nothing, so it renders as a literal false rather than being omitted.
 * Omitting it would silently widen the query to everything, which is the
 * exact failure this filter exists to prevent. */
function allowedPatternsCondition(
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
    const clause = singlePatternCondition(pattern);
    clauses.push(clause.sql);
    params.push(...clause.params);
  }
  return { sql: `(${clauses.join(" OR ")})`, params };
}

/** One mailbox rule's own `(domainId, addressPattern)` pairing, rendered as
 * a self-contained condition. Never combine a rule's domain with another
 * rule's pattern -- that is exactly the cross-product this shape (and this
 * function taking the whole rule at once) is meant to make impossible. */
function mailRuleCondition(rule: MailAuthorizationRule): SqlCondition {
  const addressClause = singlePatternCondition(rule.addressPattern);
  if (rule.domainId === null) {
    return addressClause;
  }
  return {
    sql: `(messages.domain_id = ? AND ${addressClause.sql})`,
    params: [rule.domainId, ...addressClause.params],
  };
}

/** ORs together every rule's own condition, each still carrying its own
 * domain/pattern pairing. */
function combineRuleConditions(
  rules: readonly MailAuthorizationRule[],
): SqlCondition {
  const clauses = rules.map(mailRuleCondition);
  return {
    sql: `(${clauses.map((clause) => clause.sql).join(" OR ")})`,
    params: clauses.flatMap((clause) => [...clause.params]),
  };
}

/** Renders a USER viewer's mailbox-rule scoping (`ADMIN`/`MEMBER`/`VIEWER`)
 * as a reusable condition over the `messages` table. Returns `null` when
 * unrestricted (a `baseline` viewer with no `DENY` rules, an API-key
 * viewer, or a global capability), `"NONE"` when a non-baseline viewer
 * holds no `ALLOW` rule at all (must see nothing), otherwise the SQL
 * fragment. Exposed so other repositories (message events) can apply the
 * same scoping through the owning message. */
export function buildMailPermissionFilterCondition(
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
      : combineRuleConditions(allowRules);
  const deny = denyRules.length === 0 ? null : combineRuleConditions(denyRules);

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

function tagCondition(
  tagIds: readonly string[],
  exclude: boolean,
): SqlCondition {
  const placeholders = buildInPlaceholders(tagIds.length);
  const existence = exclude ? "NOT EXISTS" : "EXISTS";
  return {
    sql: `${existence} (
            SELECT 1 FROM message_tags mt
            WHERE mt.message_id = messages.id AND mt.tag_id IN (${placeholders})
          )`,
    params: [...tagIds],
  };
}

/** Fetch state for one API key.
 *
 * `NOT_FETCHED` must also match messages with **no** state row at all,
 * because a row is only written on acknowledgment -- an absent row means
 * "not yet fetched", not "unknown". */
function fetchStatusCondition(
  apiKeyId: string,
  status: FetchStatus,
): SqlCondition {
  if (status === FetchStatus.Fetched) {
    return {
      sql: `EXISTS (
              SELECT 1 FROM message_fetch_states fs
              WHERE fs.message_id = messages.id
                AND fs.api_key_id = ?
                AND fs.status = 'FETCHED'
            )`,
      params: [apiKeyId],
    };
  }
  return {
    sql: `NOT EXISTS (
            SELECT 1 FROM message_fetch_states fs
            WHERE fs.message_id = messages.id
              AND fs.api_key_id = ?
              AND fs.status = 'FETCHED'
          )`,
    params: [apiKeyId],
  };
}

function collectFilterConditions(
  filter: MessageListFilter,
): readonly SqlCondition[] {
  const conditions: SqlCondition[] = [];

  if (filter.domainIds !== undefined) {
    conditions.push({
      sql: `messages.domain_id IN (${buildInPlaceholders(filter.domainIds.length)})`,
      params: [...filter.domainIds],
    });
  }
  if (filter.direction !== undefined) {
    conditions.push({
      sql: "messages.direction = ?",
      params: [filter.direction],
    });
  }
  if (filter.threadId !== undefined) {
    conditions.push({
      sql: "messages.thread_id = ?",
      params: [filter.threadId],
    });
  }
  if (filter.fromAddress !== undefined) {
    conditions.push({
      sql: "messages.from_address = ?",
      params: [filter.fromAddress],
    });
  }
  if (filter.address !== undefined) {
    conditions.push(anyAddressCondition(filter.address));
  }
  if (filter.toAddress !== undefined) {
    conditions.push({
      sql: `EXISTS (
              SELECT 1 FROM message_recipients r
              WHERE r.message_id = messages.id
                AND r.address = ?
                AND r.kind IN (?, ?)
            )`,
      params: [filter.toAddress, RecipientKind.To, RecipientKind.Envelope],
    });
  }
  if (filter.unreadOnly === true) {
    conditions.push({ sql: "messages.read_at IS NULL", params: [] });
  }
  if (filter.since !== undefined) {
    conditions.push({
      sql: "messages.occurred_at >= ?",
      params: [filter.since],
    });
  }
  if (filter.until !== undefined) {
    conditions.push({
      sql: "messages.occurred_at <= ?",
      params: [filter.until],
    });
  }
  if (filter.search !== undefined && filter.search.trim().length > 0) {
    // Full-text over subject and body. The stored body is capped at 256 KiB
    // (see the ingest pipeline), so a LIKE scan is honest work at
    // self-hosted volume; an FTS5 index was rejected because its triggers
    // contain `;` inside CREATE TRIGGER bodies, which the migration
    // runner's splitter would corrupt. The snippet is included so a
    // truncated or HTML-only body still matches on its visible preview.
    const term = `%${escapeLikePattern(filter.search.trim())}%`;
    conditions.push({
      sql: `(messages.subject LIKE ? ESCAPE '\\'
             OR messages.snippet LIKE ? ESCAPE '\\'
             OR messages.text_body LIKE ? ESCAPE '\\')`,
      params: [term, term, term],
    });
  }
  if (filter.recipientAddress !== undefined) {
    // Any recipient kind: the "with cc" variant of the recipient filter
    // (`toAddress` above is the "without cc" one).
    conditions.push({
      sql: `EXISTS (
              SELECT 1 FROM message_recipients r
              WHERE r.message_id = messages.id AND r.address = ?
            )`,
      params: [filter.recipientAddress],
    });
  }
  if (filter.hasAttachment !== undefined) {
    const existence = filter.hasAttachment ? "EXISTS" : "NOT EXISTS";
    conditions.push({
      sql: `${existence} (
              SELECT 1 FROM attachments a WHERE a.message_id = messages.id
            )`,
      params: [],
    });
  }
  if (
    filter.attachmentKinds !== undefined &&
    filter.attachmentKinds.length > 0
  ) {
    conditions.push({
      sql: `EXISTS (
              SELECT 1 FROM attachments a
              WHERE a.message_id = messages.id
                AND a.kind IN (${buildInPlaceholders(filter.attachmentKinds.length)})
            )`,
      params: [...filter.attachmentKinds],
    });
  }
  if (filter.tagIds !== undefined && filter.tagIds.length > 0) {
    conditions.push(tagCondition(filter.tagIds, false));
  }
  if (filter.excludeTagIds !== undefined && filter.excludeTagIds.length > 0) {
    conditions.push(tagCondition(filter.excludeTagIds, true));
  }

  if (filter.spam !== undefined) {
    conditions.push({
      sql: `${filter.spam ? "" : "NOT "}EXISTS (
        SELECT 1 FROM message_spam ms WHERE ms.message_id = messages.id)`,
      params: [],
    });
  }

  if (filter.statuses !== undefined && filter.statuses.length > 0) {
    conditions.push({
      sql: `messages.status IN (${filter.statuses.map(() => "?").join(", ")})`,
      params: [...filter.statuses],
    });
  }

  if (filter.mailingList !== undefined) {
    conditions.push({
      sql: `messages.is_mailing_list = ?`,
      params: [filter.mailingList ? 1 : 0],
    });
  }

  if (filter.listId !== undefined) {
    conditions.push({ sql: `messages.list_id = ?`, params: [filter.listId] });
  }
  if (filter.allowedPatterns !== null) {
    const allowed = allowedPatternsCondition(filter.allowedPatterns);
    if (allowed !== null) {
      conditions.push(allowed);
    }
  }
  const mailPermission = buildMailPermissionFilterCondition(
    filter.mailPermissionFilter,
  );
  if (mailPermission === "NONE") {
    conditions.push({ sql: "0 = 1", params: [] });
  } else if (mailPermission !== null) {
    conditions.push(mailPermission);
  }
  if (filter.fetchStatus !== undefined) {
    conditions.push(
      fetchStatusCondition(
        filter.fetchStatus.apiKeyId,
        filter.fetchStatus.status,
      ),
    );
  }
  return conditions;
}

export interface BuiltListQuery {
  readonly rowsSql: string;
  readonly rowsParams: readonly SqlValue[];
  readonly countSql: string;
  readonly countParams: readonly SqlValue[];
}

/** Builds the listing and count queries for a filter.
 *
 * Ordering is `(occurred_at DESC, id DESC)` -- a total order, so the keyset
 * cursor is unambiguous even when several messages share a timestamp. One
 * extra row is requested so the caller can tell whether a next page exists
 * without a second query. */
/** The scope allowlist as a reusable condition over the `messages` table.
 * Returns `null` when unrestricted, `"NONE"` when the viewer can see
 * nothing (empty allowlist), otherwise the SQL fragment. Exposed so other
 * repositories (message events) can apply message-visibility scoping
 * through the owning message. */
export function buildAllowedPatternsCondition(
  patterns: readonly string[] | null,
): SqlCondition | "NONE" | null {
  if (patterns === null) {
    return null;
  }
  if (patterns.length === 0) {
    return "NONE";
  }
  return allowedPatternsCondition(patterns);
}

export function buildMessageListQuery(
  filter: MessageListFilter,
  limit: number,
  cursor: string | null,
): BuiltListQuery {
  const conditions = collectFilterConditions(filter);
  const whereParts = conditions.map((condition) => condition.sql);
  const whereParams: SqlValue[] = conditions.flatMap((condition) => [
    ...condition.params,
  ]);

  const countSql =
    whereParts.length === 0
      ? "SELECT COUNT(*) AS count FROM messages"
      : `SELECT COUNT(*) AS count FROM messages WHERE ${whereParts.join(" AND ")}`;
  const countParams = [...whereParams];

  const rowsParts = [...whereParts];
  const rowsParams = [...whereParams];
  const decoded = cursor === null ? null : decodeCursor(cursor);
  if (decoded !== null) {
    rowsParts.push(
      "(messages.occurred_at < ? OR (messages.occurred_at = ? AND messages.id < ?))",
    );
    rowsParams.push(decoded.occurredAt, decoded.occurredAt, decoded.id);
  }

  const where =
    rowsParts.length === 0 ? "" : ` WHERE ${rowsParts.join(" AND ")}`;
  const rowsSql = `SELECT * FROM messages${where} ORDER BY messages.occurred_at DESC, messages.id DESC LIMIT ?`;
  rowsParams.push(limit + 1);

  return { rowsSql, rowsParams, countSql, countParams };
}
