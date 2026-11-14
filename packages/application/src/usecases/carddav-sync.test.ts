import { createContact } from "@flying-mail/domain/entities/contact";
import {
  createCarddavAccountId,
  createCarddavBookId,
  createContactId,
  createUserId,
} from "@flying-mail/domain/value-objects/ids";
import { beforeEach, describe, expect, test } from "vitest";
import type { CarddavObject } from "../ports/carddav";
import type { ParsedVcardContact } from "../ports/vcard-codec";
import {
  type ContactFixture,
  NOW,
  seedContactFixture,
} from "../test-support/contact-fixtures";
import {
  createFakeDependencies,
  type CreateFakeDependenciesOptions,
  type FakeDependencies,
} from "../test-support/fakes";
import { adminViewer, memberViewer } from "../test-support/viewer-fixtures";
import { createUseCases, type UseCases } from "../usecases";

/** Sync policy: remote-wins conflicts, tombstone pushes, and the
 * unparsable/partial distinction the design doc calls out. The fake
 * `vcardCodec` round-trips a `ParsedVcardContact` through JSON -- the
 * application layer must not depend on `@flying-mail/adapter`, and RFC 6350
 * grammar is covered by that package's own round-trip fixtures. */

const ACCOUNT_ID = createCarddavAccountId("cda-1");
const LINK_ID = createCarddavBookId("cdl-1");
const REMOTE_URL = "https://p1-carddavws.icloud.com/1/carddavhome/card/";

function parsedContact(
  overrides: Partial<ParsedVcardContact> & { readonly uid: string },
): ParsedVcardContact {
  return {
    displayName: "Remote Contact",
    givenName: null,
    familyName: null,
    nickname: null,
    organization: null,
    title: null,
    emails: [],
    phones: [],
    postalAddresses: [],
    urls: [],
    note: null,
    birthday: null,
    extraVcardLines: null,
    unparsable: false,
    ...overrides,
  };
}

function remoteObject(
  href: string,
  contact: ParsedVcardContact,
  etag: string,
): CarddavObject {
  return { href, etag, vcard: JSON.stringify(contact) };
}

let fake: FakeDependencies;
let usecases: UseCases;
let fixture: ContactFixture;

async function setup(
  options: Omit<CreateFakeDependenciesOptions, "now"> = {},
): Promise<void> {
  fake = createFakeDependencies({ now: NOW, ...options });
  usecases = createUseCases(fake.deps);
  fixture = await seedContactFixture(fake);
  await fake.deps.carddavAccountRepository.saveAccount({
    id: ACCOUNT_ID,
    userId: createUserId("usr-admin"),
    serverUrl: "https://contacts.icloud.com/",
    username: "ada@icloud.com",
    passwordCiphertext: "fake:app-password",
    principalUrl: null,
    homeSetUrl: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await fake.deps.carddavAccountRepository.saveBookLink({
    id: LINK_ID,
    accountId: ACCOUNT_ID,
    addressBookId: fixture.addressBookId,
    remoteUrl: REMOTE_URL,
    displayName: "iCloud",
    ctag: null,
    syncToken: null,
    lastSyncedAt: null,
  });
}

beforeEach(async () => {
  await setup();
});

describe("syncCarddavBook pull", () => {
  test("imports remote vCards and records their etags", async () => {
    await setup({
      carddav: {
        changes: [
          {
            changedHrefs: [`${REMOTE_URL}a.vcf`],
            deletedHrefs: [],
            syncToken: "token-2",
            ctag: "ctag-2",
            fullResync: false,
          },
        ],
        objects: new Map([
          [
            `${REMOTE_URL}a.vcf`,
            remoteObject(
              `${REMOTE_URL}a.vcf`,
              parsedContact({ uid: "remote-1", displayName: "Ada Lovelace" }),
              '"etag-a"',
            ),
          ],
        ]),
      },
    });

    const result = await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    expect(result).toMatchObject({ pulled: 1, deleted: 0, skipped: 0 });

    const imported = await fake.deps.contactRepository.findByUid(
      fixture.addressBookId,
      "remote-1",
    );
    expect(imported?.displayName).toBe("Ada Lovelace");

    const state = await fake.deps.carddavAccountRepository.findContactState(
      imported?.id ?? createContactId("missing"),
    );
    expect(state?.etag).toBe('"etag-a"');
    expect(state?.href).toBe(`${REMOTE_URL}a.vcf`);

    const link =
      await fake.deps.carddavAccountRepository.findBookLinkById(LINK_ID);
    expect(link?.syncToken).toBe("token-2");
    expect(link?.ctag).toBe("ctag-2");
  });

  test("a wholly unparsable vCard is skipped and excluded from the pulled count", async () => {
    await setup({
      carddav: {
        changes: [
          {
            changedHrefs: [`${REMOTE_URL}broken.vcf`],
            deletedHrefs: [],
            syncToken: "token-2",
            ctag: null,
            fullResync: false,
          },
        ],
        objects: new Map([
          [
            `${REMOTE_URL}broken.vcf`,
            {
              href: `${REMOTE_URL}broken.vcf`,
              etag: '"etag-x"',
              vcard: "UNPARSABLE",
            },
          ],
        ]),
      },
    });

    const result = await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    expect(result.pulled).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.warnings.join(" ")).toContain("unparsable");
    expect(
      await fake.deps.contactRepository.listByAddressBook(
        fixture.addressBookId,
      ),
    ).toEqual([]);
  });

  test("a remote deletion removes the local contact", async () => {
    await setup({
      carddav: {
        changes: [
          {
            changedHrefs: [`${REMOTE_URL}a.vcf`],
            deletedHrefs: [],
            syncToken: "token-2",
            ctag: null,
            fullResync: false,
          },
          {
            changedHrefs: [],
            deletedHrefs: [`${REMOTE_URL}a.vcf`],
            syncToken: "token-3",
            ctag: null,
            fullResync: false,
          },
        ],
        objects: new Map([
          [
            `${REMOTE_URL}a.vcf`,
            remoteObject(
              `${REMOTE_URL}a.vcf`,
              parsedContact({ uid: "remote-1", displayName: "Ada Lovelace" }),
              '"etag-a"',
            ),
          ],
        ]),
      },
    });

    await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    const second = await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    expect(second.deleted).toBe(1);
    expect(
      await fake.deps.contactRepository.findByUid(
        fixture.addressBookId,
        "remote-1",
      ),
    ).toBeNull();
  });
});

describe("syncCarddavBook push", () => {
  async function seedLocalContact(
    extraVcardLines: string | null = null,
  ): Promise<void> {
    await fake.deps.contactRepository.createContact(
      createContact({
        id: createContactId("cnt-local"),
        addressBookId: fixture.addressBookId,
        uid: "local-1",
        displayName: "Local Contact",
        extraVcardLines,
        createdAt: "2026-08-23T00:00:00.000Z",
        // Before the fixed clock's NOW, so the first sync sees it as dirty
        // (no contact state yet).
        updatedAt: "2026-08-23T00:00:00.000Z",
      }),
    );
  }

  test("pushes a locally created contact and stores the returned etag", async () => {
    await seedLocalContact();
    const result = await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    expect(result.pushed).toBe(1);
    const put = fake.carddavClient.calls.find((call) => call.kind === "PUT");
    expect(put?.href).toBe(`${REMOTE_URL}local-1.vcf`);
    expect(put?.etag).toBeNull();

    const state = await fake.deps.carddavAccountRepository.findContactState(
      createContactId("cnt-local"),
    );
    expect(state?.etag).not.toBeNull();

    // Now clean: a second sync pushes nothing.
    expect(
      (await usecases.syncCarddavBook(adminViewer(), LINK_ID)).pushed,
    ).toBe(0);
  });

  test("a partially-modeled vCard (extraVcardLines set) is still pushed -- only unparsable ones are excluded", async () => {
    await seedLocalContact("X-CUSTOM:keep-me");
    const result = await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    expect(result.pushed).toBe(1);
    const put = fake.carddavClient.calls.find((call) => call.kind === "PUT");
    expect(put).not.toBeUndefined();
  });

  test("a CONFLICT on push resolves remote-wins and reports the conflict", async () => {
    await setup({
      carddav: {
        putResults: new Map([
          [`${REMOTE_URL}local-1.vcf`, { outcome: "CONFLICT", etag: null }],
        ]),
        objects: new Map([
          [
            `${REMOTE_URL}local-1.vcf`,
            remoteObject(
              `${REMOTE_URL}local-1.vcf`,
              parsedContact({ uid: "local-1", displayName: "Remote wins" }),
              '"etag-remote"',
            ),
          ],
        ]),
      },
    });
    await seedLocalContact();

    const result = await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    expect(result.conflictsResolvedRemoteWins).toBe(1);
    expect(result.pushed).toBe(0);

    const stored = await fake.deps.contactRepository.findByUid(
      fixture.addressBookId,
      "local-1",
    );
    expect(stored?.displayName).toBe("Remote wins");
  });

  test("deleting a synced contact pushes a tombstone on the next sync", async () => {
    await seedLocalContact();
    await usecases.syncCarddavBook(adminViewer(), LINK_ID);

    const contact = await fake.deps.contactRepository.findByUid(
      fixture.addressBookId,
      "local-1",
    );
    expect(contact).not.toBeNull();
    expect(
      await usecases.deleteContact(
        adminViewer(),
        contact?.id ?? createContactId("missing"),
      ),
    ).toBe(true);
    // The contact state cascaded away, so the pending remote DELETE has to
    // be remembered in the tombstone table.
    expect(
      await fake.deps.carddavAccountRepository.listDeletions(LINK_ID),
    ).toHaveLength(1);

    const result = await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    expect(result.deleted).toBe(1);
    expect(
      fake.carddavClient.calls.filter((call) => call.kind === "DELETE"),
    ).toHaveLength(1);
    expect(
      await fake.deps.carddavAccountRepository.listDeletions(LINK_ID),
    ).toEqual([]);
  });

  test("a CONFLICT on a tombstone delete brings the remote contact back", async () => {
    // Scripted from the start: the tombstone DELETE this test drives will
    // hit these once the local contact is deleted and re-synced.
    await setup({
      carddav: {
        deleteResults: new Map([
          [`${REMOTE_URL}local-1.vcf`, { outcome: "CONFLICT" }],
        ]),
        objects: new Map([
          [
            `${REMOTE_URL}local-1.vcf`,
            remoteObject(
              `${REMOTE_URL}local-1.vcf`,
              parsedContact({ uid: "local-1", displayName: "Still alive" }),
              '"etag-remote"',
            ),
          ],
        ]),
      },
    });
    await seedLocalContact();
    await usecases.syncCarddavBook(adminViewer(), LINK_ID);

    const contact = await fake.deps.contactRepository.findByUid(
      fixture.addressBookId,
      "local-1",
    );
    await usecases.deleteContact(
      adminViewer(),
      contact?.id ?? createContactId("missing"),
    );

    await usecases.syncCarddavBook(adminViewer(), LINK_ID);
    const revived = await fake.deps.contactRepository.findByUid(
      fixture.addressBookId,
      "local-1",
    );
    expect(revived?.displayName).toBe("Still alive");
  });
});

describe("syncCarddavBook guards", () => {
  test("fails with SERVICE_UNAVAILABLE when no credential key is configured", async () => {
    await setup({ credentialCipherAvailable: false });
    await expect(
      usecases.syncCarddavBook(adminViewer(), LINK_ID),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  test("requires contact write authorization on the linked book", async () => {
    const bystander = memberViewer("usr-1", []);
    await expect(
      usecases.syncCarddavBook(bystander, LINK_ID),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
