import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import {
  CREATE_TAG_MUTATION,
  DELETE_TAG_MUTATION,
  RENAME_TAG_MUTATION,
} from "../../api/documents";
import { graphqlRequest } from "../../api/graphql-client";
import type { TagView } from "../../api/schema-types";
import { describeErrors } from "../../lib/mutation-error";
import { pushToast } from "../../lib/toast";
import { useStore } from "../../store/store-context";
import "./settings.css";

export default function TagsPage(): JSX.Element {
  const store = useStore();
  const [name, setName] = createSignal("");
  const [color, setColor] = createSignal("#1f5fd6");
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    void store.loadReferenceData();
  });

  async function createTag(event: Event): Promise<void> {
    event.preventDefault();
    setBusy(true);
    const result = await graphqlRequest<
      { readonly createTag: TagView },
      Record<string, unknown>
    >(CREATE_TAG_MUTATION, { name: name(), color: color() });
    setBusy(false);
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    setName("");
    await store.loadReferenceData();
  }

  async function rename(tag: TagView, nextName: string): Promise<void> {
    if (nextName.trim().length === 0 || nextName === tag.name) {
      return;
    }
    const result = await graphqlRequest<
      { readonly renameTag: TagView },
      Record<string, unknown>
    >(RENAME_TAG_MUTATION, {
      id: tag.id,
      name: nextName,
      color: tag.color,
    });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await store.loadReferenceData();
  }

  async function remove(tag: TagView): Promise<void> {
    const result = await graphqlRequest<
      { readonly deleteTag: boolean },
      Record<string, unknown>
    >(DELETE_TAG_MUTATION, { id: tag.id });
    if (!result.ok) {
      pushToast("error", describeErrors(result.errors));
      return;
    }
    await store.loadReferenceData();
  }

  return (
    <div class="settings-page">
      <h1>Tags</h1>

      <form class="panel" onSubmit={(event) => void createTag(event)}>
        <h2>Create a tag</h2>
        <div class="field">
          <label for="tag-name">Name</label>
          <input
            id="tag-name"
            type="text"
            required
            value={name()}
            onInput={(event) => setName(event.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label for="tag-color">Colour</label>
          <input
            id="tag-color"
            type="color"
            value={color()}
            onInput={(event) => setColor(event.currentTarget.value)}
          />
        </div>
        <button type="submit" class="primary" disabled={busy()}>
          Create tag
        </button>
      </form>

      <div class="panel">
        <h2>All tags</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th>Messages</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <For each={store.tags()}>
              {(tag) => (
                <tr>
                  <td>
                    <Show
                      when={tag.kind === "USER"}
                      fallback={<span>{tag.name}</span>}
                    >
                      <input
                        type="text"
                        value={tag.name}
                        onChange={(event) =>
                          void rename(tag, event.currentTarget.value)
                        }
                      />
                    </Show>
                  </td>
                  <td class="muted">
                    {tag.kind === "SYSTEM"
                      ? `system (${tag.systemSlug ?? ""})`
                      : "user"}
                  </td>
                  <td>{tag.messageCount}</td>
                  <td>
                    <Show
                      when={tag.kind === "USER"}
                      fallback={
                        <span
                          class="muted"
                          title="System tags are addressed by slug and cannot be changed"
                        >
                          built in
                        </span>
                      }
                    >
                      <button
                        type="button"
                        class="danger"
                        onClick={() => void remove(tag)}
                      >
                        Delete
                      </button>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>

      <a href="/">Back to mail</a>
    </div>
  );
}
