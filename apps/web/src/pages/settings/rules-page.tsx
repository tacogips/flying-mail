import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  APPLY_CLASSIFICATION_RULE_MUTATION,
  CLASSIFICATION_RULES_QUERY,
  CREATE_CLASSIFICATION_RULE_MUTATION,
  DELETE_CLASSIFICATION_RULE_MUTATION,
  SET_CLASSIFICATION_RULE_ENABLED_MUTATION,
} from "../../api/documents";
import { graphqlRequest } from "../../api/graphql-client";
import type {
  ClassificationRuleView,
  RuleAction,
  RuleField,
  RuleMatcher,
} from "../../api/schema-types";
import { describeErrors } from "../../lib/mutation-error";
import { pushToast } from "../../lib/toast";
import { useStore } from "../../store/store-context";
import "./settings.css";

const FIELD_LABELS: Readonly<Record<RuleField, string>> = {
  SENDER_ADDRESS: "Sender address",
  SENDER_DOMAIN: "Sender domain",
  SUBJECT: "Subject",
  LIST_ID: "List-Id",
};
const MATCHER_LABELS: Readonly<Record<RuleMatcher, string>> = {
  EXACT: "equals",
  CONTAINS: "contains",
  REGEX: "matches regex",
};
const ACTION_LABELS: Readonly<Record<RuleAction, string>> = {
  SPAM: "Mark as spam",
  MAILING_LIST: "Flag as mailing list",
  TAG: "Apply tag",
};

/** Ingest classification rules: per sender address or domain (or subject
 * or List-Id), decide spam / mailing list / auto-tag at receive time. */
export default function RulesPage(): JSX.Element {
  const store = useStore();
  const [rules, setRules] = createSignal<readonly ClassificationRuleView[]>([]);
  const [field, setField] = createSignal<RuleField>("SENDER_DOMAIN");
  const [matcher, setMatcher] = createSignal<RuleMatcher>("EXACT");
  const [pattern, setPattern] = createSignal("");
  const [action, setAction] = createSignal<RuleAction>("SPAM");
  const [tagId, setTagId] = createSignal("");
  const [domainId, setDomainId] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function reload(): Promise<void> {
    const result = await graphqlRequest<
      { readonly classificationRules: readonly ClassificationRuleView[] },
      Record<string, unknown>
    >(CLASSIFICATION_RULES_QUERY);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setRules(result.data.classificationRules);
  }

  onMount(() => {
    void store.loadReferenceData();
    void reload();
  });

  async function createRule(event: Event): Promise<void> {
    event.preventDefault();
    if (action() === "TAG" && tagId() === "") {
      pushToast("error", "Pick the tag the rule should apply");
      return;
    }
    setBusy(true);
    const result = await graphqlRequest<
      { readonly createClassificationRule: ClassificationRuleView },
      Record<string, unknown>
    >(CREATE_CLASSIFICATION_RULE_MUTATION, {
      input: {
        field: field(),
        matcher: matcher(),
        pattern: pattern(),
        action: action(),
        ...(action() === "TAG" ? { tagId: tagId() } : {}),
        ...(domainId() === "" ? {} : { domainId: domainId() }),
      },
    });
    setBusy(false);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setPattern("");
    await reload();
  }

  async function toggle(rule: ClassificationRuleView): Promise<void> {
    const result = await graphqlRequest<
      Record<string, unknown>,
      Record<string, unknown>
    >(SET_CLASSIFICATION_RULE_ENABLED_MUTATION, {
      id: rule.id,
      enabled: !rule.enabled,
    });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await reload();
  }

  async function applyNow(rule: ClassificationRuleView): Promise<void> {
    const result = await graphqlRequest<
      {
        readonly applyClassificationRule: {
          readonly examined: number;
          readonly matched: number;
        };
      },
      Record<string, unknown>
    >(APPLY_CLASSIFICATION_RULE_MUTATION, { id: rule.id });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    const outcome = result.data.applyClassificationRule;
    pushToast(
      "success",
      `Rule ran over ${outcome.examined} message(s); ${outcome.matched} matched`,
    );
  }

  async function remove(rule: ClassificationRuleView): Promise<void> {
    const result = await graphqlRequest<
      Record<string, unknown>,
      Record<string, unknown>
    >(DELETE_CLASSIFICATION_RULE_MUTATION, { id: rule.id });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await reload();
  }

  return (
    <div class="settings-page">
      <h1>Classification rules</h1>
      <p class="muted">
        Evaluated for every received message. Judge by sender address or domain
        (or subject / List-Id) and mark spam, flag as mailing list, or apply a
        tag automatically.
      </p>

      <form class="panel" onSubmit={(event) => void createRule(event)}>
        <h2>Add a rule</h2>
        <div class="field">
          <label for="rule-field">When</label>
          <select
            id="rule-field"
            value={field()}
            onChange={(event) =>
              setField(event.currentTarget.value as RuleField)
            }
          >
            <For each={Object.keys(FIELD_LABELS) as RuleField[]}>
              {(value) => <option value={value}>{FIELD_LABELS[value]}</option>}
            </For>
          </select>
        </div>
        <div class="field">
          <label for="rule-matcher">Condition</label>
          <select
            id="rule-matcher"
            value={matcher()}
            onChange={(event) =>
              setMatcher(event.currentTarget.value as RuleMatcher)
            }
          >
            <For each={Object.keys(MATCHER_LABELS) as RuleMatcher[]}>
              {(value) => (
                <option value={value}>{MATCHER_LABELS[value]}</option>
              )}
            </For>
          </select>
        </div>
        <div class="field">
          <label for="rule-pattern">Pattern</label>
          <input
            id="rule-pattern"
            type="text"
            required
            placeholder="newsletter.example or ^promo-.*@"
            value={pattern()}
            onInput={(event) => setPattern(event.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="rule-action">Then</label>
          <select
            id="rule-action"
            value={action()}
            onChange={(event) =>
              setAction(event.currentTarget.value as RuleAction)
            }
          >
            <For each={Object.keys(ACTION_LABELS) as RuleAction[]}>
              {(value) => <option value={value}>{ACTION_LABELS[value]}</option>}
            </For>
          </select>
        </div>
        <Show when={action() === "TAG"}>
          <div class="field">
            <label for="rule-tag">Tag</label>
            <select
              id="rule-tag"
              value={tagId()}
              onChange={(event) => setTagId(event.currentTarget.value)}
            >
              <option value="">Choose a tag...</option>
              <For each={store.tags()}>
                {(tag) => <option value={tag.id}>{tag.name}</option>}
              </For>
            </select>
          </div>
        </Show>
        <div class="field">
          <label for="rule-domain">Domain</label>
          <select
            id="rule-domain"
            value={domainId()}
            onChange={(event) => setDomainId(event.currentTarget.value)}
          >
            <option value="">All domains</option>
            <For each={store.domains()}>
              {(domain) => <option value={domain.id}>{domain.name}</option>}
            </For>
          </select>
        </div>
        <button type="submit" class="primary" disabled={busy()}>
          Add rule
        </button>
      </form>

      <div class="panel">
        <h2>Rules</h2>
        <Show
          when={rules().length > 0}
          fallback={<p class="muted">No rules yet.</p>}
        >
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Pattern</th>
                <th>Then</th>
                <th>Domain</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={rules()}>
                {(rule) => (
                  <tr>
                    <td>
                      {FIELD_LABELS[rule.field]} {MATCHER_LABELS[rule.matcher]}
                    </td>
                    <td>
                      <code>{rule.pattern}</code>
                    </td>
                    <td>
                      {rule.action === "TAG" && rule.tag !== null
                        ? `Tag: ${rule.tag.name}`
                        : ACTION_LABELS[rule.action]}
                    </td>
                    <td>{rule.domain?.name ?? "All"}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={() => void toggle(rule)}
                        aria-label={`Enable rule ${rule.pattern}`}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        title="Run this rule over mail that already arrived"
                        onClick={() => void applyNow(rule)}
                      >
                        Run now
                      </button>
                      <button
                        type="button"
                        class="danger"
                        onClick={() => void remove(rule)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </div>
  );
}
