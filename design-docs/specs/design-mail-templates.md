# Mail Templates

Reusable, variable-driven mail bodies: an operator stores a template once, and
a user or an agent then sends mail from it by supplying the declared variable
values. The web client picks a template, collects the variables, renders a
review of the exact mail that will go out, and only then sends.

Template administration is a first-class permission surface: create, update
and delete are each grantable independently, both to interactive users and to
API keys.

## Overview

A `MailTemplate` bundles three things:

1. **Eta source** for the subject and the text and/or HTML body, plus optional
   default sender and recipients.
2. **A declared variable set** -- the fields of the data object the template is
   rendered with.
3. **Instance-wide identity** (name, description). Templates are not
   per-domain or per-mailbox; the mailbox authorization that matters happens at
   send time, on the `from` address, exactly as `sendMessage` already does.

## Template Language: Eta

Templates are written in [Eta](https://eta.js.org) syntax. The data object is
bound to `it`, so a declared variable named `customerName` is written
`<%= it.customerName %>`.

| Tag | Meaning |
|-----|---------|
| `<%= expr %>` | Interpolate. HTML-escaped when rendering an HTML body, inserted verbatim into a text body or the subject. |
| `<%~ expr %>` | Raw interpolate. Never escaped. |
| `<% ... %>` | **Rejected.** See below. |

### Why a restricted evaluator

`eta`'s own `compile`/`render` build a JavaScript function with `new Function`.
That is unusable here for two independent reasons:

1. **The API runs on Cloudflare Workers**, which forbid dynamic code generation
   at request time. A `new Function` call inside a resolver throws
   `EvalError`, so full Eta would work locally and fail in production.
2. **Templates are user-supplied data.** Compiling them would let anyone
   holding `TEMPLATE_CREATE` run arbitrary JavaScript inside the API process --
   a privilege escalation from "may write a mail template" to "owns the
   server".

mailcal therefore uses `eta`'s own parser (`Eta#parse`) for tokenization, so
the syntax, delimiters and whitespace-control behavior are genuinely Eta's, and
evaluates the resulting AST with its own interpreter over a deliberately small
expression grammar:

```
expression := operand ( ("||" | "??") operand )*
operand    := path | literal
path       := "it" ( "." identifier | "[" string-literal "]" | "[" integer "]" )*
literal    := string-literal | number | "true" | "false" | "null" | "undefined"
```

Anything else -- a function call, an arithmetic operator, a bare identifier
that is not `it`, a `<% %>` execution tag -- is a `BAD_USER_INPUT` at template
create/update time, naming the offending expression. Rejecting at write time
rather than at render time means a stored template always renders.

The same parser powers `referencedVariables`, which is how the server knows
which variables a template actually uses.

## Variables

A variable is a declared field of the render object:

```typescript
enum TemplateVariableType {
  Text = "TEXT",
  MultilineText = "MULTILINE_TEXT",
  Number = "NUMBER",
  Boolean = "BOOLEAN",
  Date = "DATE",
  Email = "EMAIL",
}

interface TemplateVariable {
  readonly key: string;               // /^[A-Za-z_][A-Za-z0-9_]*$/, unique per template
  readonly label: string;
  readonly type: TemplateVariableType;
  readonly required: boolean;
  readonly defaultValue: string | null;
  readonly description: string | null;
}
```

`type` drives the web client's input widget and server-side coercion. Values
cross the API as strings (`TemplateValueInput { key, value }`) and are coerced
once, centrally:

| Type | Accepted | Rendered as |
|------|----------|-------------|
| `TEXT`, `MULTILINE_TEXT` | any string | the string |
| `NUMBER` | finite decimal | the number |
| `BOOLEAN` | `true`/`false`/`1`/`0`/`yes`/`no` (case-insensitive) | boolean |
| `DATE` | `YYYY-MM-DD` or an ISO 8601 timestamp | the normalized string |
| `EMAIL` | the address grammar in `design-domain-model.md` | the address |

### Two independent validations

**At write time** (`createMailTemplate` / `updateMailTemplate`): every `it.x`
referenced anywhere in the template must be declared, and every declared
variable's `defaultValue` must coerce under its own type. An undeclared
reference is a `BAD_USER_INPUT` naming the variable. A declared-but-unused
variable is allowed and reported as a warning field, not an error -- an
operator may be staging a variable ahead of a body edit.

**At render/send time**: `validateTemplateValues` checks that every `required`
variable with no `defaultValue` has a supplied value, and that every supplied
value coerces. It is exposed on its own as
`Query.mailTemplateValidation(templateId, values)` so the web client can gate
its "Review" button without rendering, and it also runs unconditionally inside
`previewMailTemplate` and `sendTemplatedMessage`. A client cannot skip it.

The result is data, not an exception, so the UI can highlight fields:

```typescript
interface TemplateValidation {
  readonly valid: boolean;
  readonly missing: readonly string[];      // required, unsupplied, no default
  readonly invalid: readonly TemplateValueProblem[];   // { key, reason }
  readonly unknown: readonly string[];      // supplied but not declared
}
```

`unknown` keys never reach the render object: an undeclared key cannot inject
content into a template that does not reference it, and cannot shadow a
declared one.

## Rendering and Sending

`renderMailTemplate(template, values)` produces the exact mail the send will
use:

```typescript
interface RenderedTemplate {
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}
```

Recipients and `from` are themselves Eta sources, so `<%= it.customerEmail %>`
is a legitimate `to` entry. Each recipient slot is rendered independently and
then split on `,`/`;`, so one variable may expand to several addresses.

`sendTemplatedMessage(viewer, input)` renders, then hands the result to the
existing `sendMessage` path -- so managed-domain checks, the `MAIL_SEND`
address capability, recipient limits, header-injection guards, attachments and
tagging are all unchanged and cannot be bypassed through the template door.
The send input may override `from`, `to`, `cc`, `bcc`, `attachmentIds` and
`tagIds`; anything it omits falls back to the template's rendered value.

`previewMailTemplate` runs exactly the same render with no send, and is what
the web client's review step displays. Preview requires `TEMPLATE_READ` only:
it touches no mailbox.

## Permissions

Four new capabilities, independent of each other in the same way every other
capability in `design-api-keys-and-permissions.md` is:

| Capability | Grants |
|------------|--------|
| `TEMPLATE_READ` | List, read and preview templates |
| `TEMPLATE_CREATE` | Create a template |
| `TEMPLATE_UPDATE` | Update any template |
| `TEMPLATE_DELETE` | Delete any template |

They are address-independent: templates belong to the instance, not to a
mailbox. A template scope's `domainId`/`addressPattern` are therefore ignored
and stored in canonical unrestricted form, exactly as `DOMAIN_ADMIN` is.

They are **not** members of `GLOBAL_CAPABILITIES`, though. That set means
"admin-only for a user viewer", and template administration is explicitly
delegable to non-admins.

Sending from a template requires **both** `TEMPLATE_READ` (to read it) and the
usual `MAIL_SEND` on the resolved `from` address. Holding one never implies
the other.

### API keys

A key holds a template capability exactly when it has a scope with that
capability. Nothing else is consulted.

### Users

A user's template capabilities are resolved as:

1. A matching `DENY` in `user_template_permissions` always wins.
2. A matching `ALLOW` grants it.
3. Otherwise the role default applies.

| Role | `TEMPLATE_READ` | `TEMPLATE_CREATE` | `TEMPLATE_UPDATE` | `TEMPLATE_DELETE` |
|------|-----------------|-------------------|-------------------|-------------------|
| `ADMIN` | yes | yes | yes | yes |
| `MEMBER` | yes | no | no | no |
| `VIEWER` | yes | no | no | no |

Defaults are closed for the mutating three, matching the instance's general
posture: a capability that lets one user change the mail every other user
sends is granted deliberately, not inherited. An admin's own defaults can
still be revoked with an explicit `DENY`, mirroring how an admin can deny
itself a mailbox.

```typescript
interface UserTemplatePermission {
  readonly id: UserTemplatePermissionId;
  readonly userId: UserId;
  readonly capability: TemplateCapability;   // the four above
  readonly effect: UserPermissionEffect;     // ALLOW | DENY
  readonly createdByUserId: UserId;
  readonly createdAt: string;
}
```

Only an `ADMIN` may add or remove these rules. `(userId, capability)` is
unique, so a rule is replaced rather than duplicated.

## Storage

```sql
CREATE TABLE mail_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  subject TEXT NOT NULL,
  text_body TEXT,
  html_body TEXT,
  from_address TEXT,
  to_addresses_json TEXT NOT NULL DEFAULT '[]',
  cc_addresses_json TEXT NOT NULL DEFAULT '[]',
  bcc_addresses_json TEXT NOT NULL DEFAULT '[]',
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (text_body IS NOT NULL OR html_body IS NOT NULL)
);

CREATE UNIQUE INDEX idx_mail_templates_name ON mail_templates(lower(name));

CREATE TABLE mail_template_variables (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES mail_templates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN
    ('TEXT','MULTILINE_TEXT','NUMBER','BOOLEAN','DATE','EMAIL')),
  required INTEGER NOT NULL DEFAULT 1,
  default_value TEXT,
  description TEXT,
  position INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_mail_template_variables_key
  ON mail_template_variables(template_id, key);

CREATE TABLE user_template_permissions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN
    ('TEMPLATE_READ','TEMPLATE_CREATE','TEMPLATE_UPDATE','TEMPLATE_DELETE')),
  effect TEXT NOT NULL CHECK (effect IN ('ALLOW','DENY')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_user_template_permissions_rule
  ON user_template_permissions(user_id, capability);
```

Variables live in their own table rather than a JSON column so the unique
`(template_id, key)` constraint is enforced by the database, and so a variable
set is orderable for the form the web client builds from it. `save` replaces a
template's whole variable set in one batch: the set is edited as a unit.

`api_key_scopes`'s `capability` CHECK is widened to admit the four new values,
using the table-rebuild pattern migrations 0005 and 0006 already established.

## GraphQL Surface

```graphql
enum TemplateVariableType { TEXT MULTILINE_TEXT NUMBER BOOLEAN DATE EMAIL }

type TemplateVariable {
  key: String!
  label: String!
  type: TemplateVariableType!
  required: Boolean!
  defaultValue: String
  description: String
}

type MailTemplate {
  id: ID!
  name: String!
  description: String
  subject: String!
  textBody: String
  htmlBody: String
  from: String
  to: [String!]!
  cc: [String!]!
  bcc: [String!]!
  variables: [TemplateVariable!]!
  "Variables the Eta source actually references. Always a subset of variables."
  referencedVariableKeys: [String!]!
  createdByUserId: ID
  createdAt: DateTime!
  updatedAt: DateTime!
}

type TemplateValueProblem { key: String!  reason: String! }

type TemplateValidation {
  valid: Boolean!
  missing: [String!]!
  invalid: [TemplateValueProblem!]!
  unknown: [String!]!
}

type RenderedTemplate {
  subject: String!
  text: String
  html: String
  from: String
  to: [String!]!
  cc: [String!]!
  bcc: [String!]!
  validation: TemplateValidation!
}

input TemplateValueInput { key: String!  value: String! }

type Query {
  mailTemplates: [MailTemplate!]!
  mailTemplate(id: ID!): MailTemplate
  "Validation only -- never renders. Cheap enough to call on every keystroke."
  mailTemplateValidation(id: ID!, values: [TemplateValueInput!]!): TemplateValidation!
  "The review step. Fails with BAD_USER_INPUT when validation does not pass."
  previewMailTemplate(id: ID!, values: [TemplateValueInput!]!): RenderedTemplate!
}

type Mutation {
  createMailTemplate(input: MailTemplateInput!): MailTemplate!
  updateMailTemplate(id: ID!, input: MailTemplateInput!): MailTemplate!
  deleteMailTemplate(id: ID!): Boolean!
  sendTemplatedMessage(input: SendTemplatedMessageInput!): Message!

  addUserTemplatePermission(userId: ID!, input: UserTemplatePermissionInput!): UserTemplatePermission!
  removeUserTemplatePermission(id: ID!): Boolean!
}
```

`Viewer.capabilities` gains the template capabilities it holds, so the web
client can hide administration UI it would be refused anyway.

## Web Client Flow

A new **Templates** entry in compose, and a **Settings -> Templates** admin
page.

Sending, as four steps inside the compose window:

1. **Pick** -- a list of templates with name, description and variable count.
2. **Fill** -- a generated form, one control per declared variable, typed by
   `TemplateVariableType` (a `MULTILINE_TEXT` gets a textarea, a `BOOLEAN` a
   checkbox, a `DATE` a date input). Defaults are pre-filled. The step reports
   live which required variables are still empty, from
   `mailTemplateValidation`, and the Review button stays disabled until it
   passes.
3. **Review** -- `previewMailTemplate`'s output shown as the actual mail:
   resolved sender, recipients, subject, and body. An editable sender/recipient
   row sits above it for the override case. Back returns to Fill with values
   intact.
4. **Send** -- `sendTemplatedMessage` with the same values plus any overrides.

Nothing about steps 1--3 sends mail, and step 4 re-renders server-side from the
stored template rather than trusting the previewed strings: the review is a
faithful preview, not the payload.

The settings page is a full editor -- name, description, Eta subject/bodies,
default recipients, and a variable-set editor -- plus per-user permission rows
on the existing Users page. Both surfaces are hidden unless
`Viewer.capabilities` carries the matching capability.

## Out of Scope

- Control flow (`if`/`each`) inside templates. The grammar above is
  interpolation-only by design; adding a loop means adding a real interpreter,
  and no requirement here needs one.
- Per-domain or per-mailbox template ownership. Templates are instance-wide.
- Attachments stored on a template. Attachments are supplied per send.
