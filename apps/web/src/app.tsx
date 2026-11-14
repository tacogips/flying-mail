import { Route, Router } from "@solidjs/router";
import {
  createEffect,
  createSignal,
  type JSX,
  lazy,
  onCleanup,
  onMount,
} from "solid-js";
import { ToastShelf } from "./components/toast-shelf";
import { AdminGuard, AuthGuard } from "./lib/route-guards";
import { createAppStore } from "./store/app-store";
import { createLiveUpdates } from "./store/app-store-live";
import { StoreProvider } from "./store/store-context";

const MailboxPage = lazy(() => import("./pages/mailbox-page"));
const LoginPage = lazy(() => import("./pages/login-page"));
const EmailAuthVerifyPage = lazy(
  () => import("./pages/email-auth-verify-page"),
);
const DomainsPage = lazy(() => import("./pages/settings/domains-page"));
const ApiKeysPage = lazy(() => import("./pages/settings/api-keys-page"));
const TagsPage = lazy(() => import("./pages/settings/tags-page"));
const RulesPage = lazy(() => import("./pages/settings/rules-page"));
const UsersPage = lazy(() => import("./pages/settings/users-page"));
const TemplatesPage = lazy(() => import("./pages/settings/templates-page"));
const ContactsPage = lazy(() => import("./pages/contacts-page"));

export function App(): JSX.Element {
  const store = createAppStore();
  const liveUpdates = createLiveUpdates(store);
  onCleanup(() => liveUpdates.stop());
  // Distinguishes "still resolving the session" from "signed out", so a
  // reload does not flash the login screen at an authenticated user.
  const [ready, setReady] = createSignal(false);

  createEffect(() => {
    if (!ready()) return;
    if (store.viewer() === null) {
      liveUpdates.stop();
      return;
    }
    liveUpdates.start();
  });

  onMount(() => {
    void (async () => {
      await store.rehydrateSession();
      if (store.viewer() !== null) {
        await store.loadReferenceData();
      }
      setReady(true);
    })();
  });

  return (
    <StoreProvider store={store}>
      <Router>
        <Route path="/login" component={LoginPage} />
        <Route path="/auth/verify" component={EmailAuthVerifyPage} />
        <Route
          path="/"
          component={() => (
            <AuthGuard ready={ready()}>
              <MailboxPage />
            </AuthGuard>
          )}
        />
        <Route
          path="/contacts"
          component={() => (
            <AuthGuard ready={ready()}>
              <ContactsPage />
            </AuthGuard>
          )}
        />
        <Route
          path="/settings/domains"
          component={() => (
            <AdminGuard ready={ready()}>
              <DomainsPage />
            </AdminGuard>
          )}
        />
        <Route
          path="/settings/api-keys"
          component={() => (
            <AdminGuard ready={ready()}>
              <ApiKeysPage />
            </AdminGuard>
          )}
        />
        <Route
          path="/settings/rules"
          component={() => (
            <AdminGuard ready={ready()}>
              <RulesPage />
            </AdminGuard>
          )}
        />
        <Route
          path="/settings/tags"
          component={() => (
            <AuthGuard ready={ready()}>
              <TagsPage />
            </AuthGuard>
          )}
        />
        {/* AuthGuard, not AdminGuard: every role may read the catalogue,
            and the page hides the editor for a viewer without the matching
            capability. */}
        <Route
          path="/settings/templates"
          component={() => (
            <AuthGuard ready={ready()}>
              <TemplatesPage />
            </AuthGuard>
          )}
        />
        <Route
          path="/settings/users"
          component={() => (
            <AdminGuard ready={ready()}>
              <UsersPage />
            </AdminGuard>
          )}
        />
        <Route path="*" component={() => <p class="empty">Not found.</p>} />
      </Router>
      <ToastShelf />
    </StoreProvider>
  );
}
