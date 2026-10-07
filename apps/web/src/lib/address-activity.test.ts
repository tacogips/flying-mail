import { describe, expect, test } from "vitest";
import {
  ADDRESS_LIST_EXPANDED_KEY,
  type AddressListStorage,
  readAddressListExpanded,
  visibleAddressActivity,
  writeAddressListExpanded,
  type AddressActivityView,
} from "./address-activity";

const rows: readonly AddressActivityView[] = Array.from(
  { length: 9 },
  (_, index) => ({
    address: `user${index}@example.com`,
    domainId: index < 8 ? "domain-a" : "domain-b",
    lastActivityAt: index === 8 ? null : `2026-10-0${8 - index}T00:00:00.000Z`,
    unreadCount: index,
  }),
);

describe("address activity helpers", () => {
  test("sorts newest first, null activity last, and scopes by domain", () => {
    expect(
      visibleAddressActivity(rows, {
        domainId: "domain-a",
        filter: "",
        expanded: true,
      }).map((row) => row.address),
    ).toEqual([
      "user0@example.com",
      "user1@example.com",
      "user2@example.com",
      "user3@example.com",
      "user4@example.com",
      "user5@example.com",
      "user6@example.com",
      "user7@example.com",
    ]);
  });

  test("limits collapsed rows to seven but keeps a selected older address visible", () => {
    expect(
      visibleAddressActivity(rows, {
        selectedAddress: "user7@example.com",
        filter: "",
        expanded: false,
      }).map((row) => row.address),
    ).toHaveLength(8);
  });

  test("filters case-insensitively across all addresses", () => {
    expect(
      visibleAddressActivity(rows, {
        filter: "USER8@EXAMPLE",
        expanded: false,
      }).map((row) => row.address),
    ).toEqual(["user8@example.com"]);
  });

  test("keeps the selected address when a short filtered result excludes it", () => {
    expect(
      visibleAddressActivity(rows, {
        selectedAddress: "user8@example.com",
        filter: "user1@",
        expanded: false,
      }).map((row) => row.address),
    ).toEqual(["user1@example.com", "user8@example.com"]);
  });

  test("keeps the selected address in expanded filtered results", () => {
    expect(
      visibleAddressActivity(rows, {
        selectedAddress: "user8@example.com",
        filter: "user1@",
        expanded: true,
      }).map((row) => row.address),
    ).toEqual(["user1@example.com", "user8@example.com"]);
  });

  test("stores expansion state and tolerates storage failures", () => {
    const values = new Map<string, string>();
    const storage: AddressListStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    writeAddressListExpanded(storage, true);
    expect(values.get(ADDRESS_LIST_EXPANDED_KEY)).toBe("true");
    expect(readAddressListExpanded(storage)).toBe(true);
    const brokenStorage: AddressListStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
    };
    expect(readAddressListExpanded(brokenStorage)).toBe(false);
    expect(() => writeAddressListExpanded(brokenStorage, true)).not.toThrow();
  });
});
