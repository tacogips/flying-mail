import { createContext, type JSX, useContext } from "solid-js";
import { type AppStore, createAppStore } from "./app-store";

const StoreContext = createContext<AppStore>();

export function StoreProvider(props: {
  readonly store?: AppStore;
  readonly children: JSX.Element;
}): JSX.Element {
  const store = props.store ?? createAppStore();
  return (
    <StoreContext.Provider value={store}>
      {props.children}
    </StoreContext.Provider>
  );
}

/** Throws rather than returning `undefined`: a component rendered outside
 * the provider is a wiring bug, and silently degrading would surface as a
 * confusing blank screen instead. */
export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (store === undefined) {
    throw new Error("useStore must be used within a StoreProvider");
  }
  return store;
}
