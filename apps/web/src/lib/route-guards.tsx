import { useNavigate } from "@solidjs/router";
import { createEffect, type JSX, Show } from "solid-js";
import { useStore } from "../store/store-context";

/** Redirects to `/login` once the store has settled and there is no viewer.
 *
 * `ready` distinguishes "not loaded yet" from "loaded and signed out", so a
 * reload does not bounce an authenticated user to the login screen while
 * the viewer query is still in flight. */
export function AuthGuard(props: {
  readonly ready: boolean;
  readonly children: JSX.Element;
}): JSX.Element {
  const store = useStore();
  const navigate = useNavigate();

  createEffect(() => {
    if (props.ready && store.viewer() === null) {
      navigate("/login", { replace: true });
    }
  });

  return (
    <Show
      when={store.viewer() !== null}
      fallback={<p class="empty">Loading...</p>}
    >
      {props.children}
    </Show>
  );
}

/** Additionally requires an ADMIN user. An API key viewer never satisfies
 * this, matching the server rule that instance administration is a user
 * power. */
export function AdminGuard(props: {
  readonly ready: boolean;
  readonly children: JSX.Element;
}): JSX.Element {
  const store = useStore();
  const isAdmin = () => store.viewer()?.user?.role === "ADMIN";

  return (
    <AuthGuard ready={props.ready}>
      <Show
        when={isAdmin()}
        fallback={
          <p class="empty">This page is only available to administrators.</p>
        }
      >
        {props.children}
      </Show>
    </AuthGuard>
  );
}
