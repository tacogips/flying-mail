import {
  type AddressBook,
  createAddressBook,
  updateAddressBook,
} from "@mailcal/domain/entities/address-book";
import {
  type AddressBookId,
  createAddressBookId,
  type MailAddressId,
} from "@mailcal/domain/value-objects/ids";
import type { AppDependencies } from "../dependencies";
import { ConflictError, NotFoundError } from "../errors";
import {
  authorizesContactRead,
  requireContactWrite,
} from "../policies/authorization";
import type { Viewer } from "../policies/viewer";
import {
  createContactAccessContext,
  listReadableAddressBooks,
  loadWritableAddressBook,
  resolveAddressBookOwner,
} from "./contact-access";
import { translateDomainError } from "./translate-domain-error";

export interface CreateAddressBookUseCaseInput {
  readonly mailAddressId: MailAddressId;
  readonly name: string;
  readonly description?: string | null;
  readonly isDefault?: boolean;
}

export interface UpdateAddressBookUseCaseInput {
  readonly name?: string;
  readonly description?: string | null;
}

/** Omitting `mailAddressId` yields every book the viewer may read, across
 * every address; supplying one narrows to that address's own books (empty
 * when the viewer cannot read it, never an error -- mirrors a denied read
 * anywhere else in mailcal). */
export function createListAddressBooksUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  mailAddressId?: MailAddressId,
) => Promise<readonly AddressBook[]> {
  return async (viewer, mailAddressId) => {
    if (mailAddressId === undefined) {
      return listReadableAddressBooks(deps, viewer);
    }
    const context = createContactAccessContext();
    const owner = await resolveAddressBookOwner(deps, mailAddressId, context);
    if (owner === null || !authorizesContactRead(viewer, owner)) {
      return [];
    }
    return deps.addressBookRepository.listByMailAddresses([mailAddressId]);
  };
}

export function createCreateAddressBookUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  input: CreateAddressBookUseCaseInput,
) => Promise<AddressBook> {
  return async (viewer, input) => {
    const owner = await resolveAddressBookOwner(deps, input.mailAddressId);
    if (owner === null) {
      throw new NotFoundError("MailAddress", input.mailAddressId);
    }
    requireContactWrite(viewer, owner);

    if (input.isDefault === true) {
      const existingDefault =
        await deps.addressBookRepository.findDefaultForMailAddress(
          input.mailAddressId,
        );
      if (existingDefault !== null) {
        throw new ConflictError(
          "This mail address already has a default address book",
        );
      }
    }

    const now = deps.clock.now().toISOString();
    try {
      const book = createAddressBook({
        id: createAddressBookId(deps.random.uuid()),
        mailAddressId: input.mailAddressId,
        name: input.name,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.isDefault === undefined
          ? {}
          : { isDefault: input.isDefault }),
        createdAt: now,
      });
      await deps.addressBookRepository.save(book);
      return book;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

export function createUpdateAddressBookUseCase(
  deps: AppDependencies,
): (
  viewer: Viewer,
  id: AddressBookId,
  input: UpdateAddressBookUseCaseInput,
) => Promise<AddressBook> {
  return async (viewer, id, input) => {
    const book = await loadWritableAddressBook(deps, viewer, id);
    const now = deps.clock.now().toISOString();
    try {
      const updated = updateAddressBook(
        book,
        {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined
            ? {}
            : { description: input.description }),
        },
        now,
      );
      await deps.addressBookRepository.save(updated);
      return updated;
    } catch (error) {
      throw translateDomainError(error);
    }
  };
}

/** Hard delete. Contacts and any CardDAV link on the address book cascade. */
export function createDeleteAddressBookUseCase(
  deps: AppDependencies,
): (viewer: Viewer, id: AddressBookId) => Promise<boolean> {
  return async (viewer, id) => {
    await loadWritableAddressBook(deps, viewer, id);
    await deps.addressBookRepository.delete(id);
    return true;
  };
}
