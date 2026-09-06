import { ValidationError } from "../errors";
import type { AddressBookId, MailAddressId } from "../value-objects/ids";

/** A contacts rolodex owned by one provisioned mail address (not a user):
 * `support@example.com`'s contacts belong to that mailbox, independent of
 * who staffs it -- see design-docs/specs/design-contacts.md "Ownership
 * model". Deleting a book hard-deletes its contacts. */
export interface AddressBook {
  readonly id: AddressBookId;
  readonly mailAddressId: MailAddressId;
  readonly name: string;
  readonly description: string | null;
  /** At most one default book per address is a repository-level unique
   * index (surfaced as `CONFLICT`), not a domain invariant: the
   * constructor has no way to see sibling rows for the same address. */
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAddressBookInput {
  readonly id: AddressBookId;
  readonly mailAddressId: MailAddressId;
  readonly name: string;
  readonly description?: string | null;
  readonly isDefault?: boolean;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export const MAX_ADDRESS_BOOK_NAME_LENGTH = 120;
export const MAX_ADDRESS_BOOK_DESCRIPTION_LENGTH = 2000;

export function createAddressBook(input: CreateAddressBookInput): AddressBook {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ValidationError("address book name must not be empty", "name");
  }
  if (name.length > MAX_ADDRESS_BOOK_NAME_LENGTH) {
    throw new ValidationError(
      `address book name must be at most ${MAX_ADDRESS_BOOK_NAME_LENGTH} characters`,
      "name",
    );
  }
  const description = input.description?.trim() ?? "";
  if (description.length > MAX_ADDRESS_BOOK_DESCRIPTION_LENGTH) {
    throw new ValidationError(
      `address book description must be at most ${MAX_ADDRESS_BOOK_DESCRIPTION_LENGTH} characters`,
      "description",
    );
  }
  return {
    id: input.id,
    mailAddressId: input.mailAddressId,
    name,
    description: description.length === 0 ? null : description,
    isDefault: input.isDefault ?? false,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt ?? input.createdAt,
  };
}

export interface UpdateAddressBookInput {
  readonly name?: string;
  readonly description?: string | null;
}

/** Applies a partial edit through the same validation the factory uses --
 * an absent field is left untouched, an explicit `null` description clears
 * it. `mailAddressId` and `isDefault` are not editable here: reassigning a
 * book to a different address, or its default status, is a repository-level
 * operation (see the design doc), not a field update. */
export function updateAddressBook(
  book: AddressBook,
  input: UpdateAddressBookInput,
  updatedAt: string,
): AddressBook {
  return createAddressBook({
    id: book.id,
    mailAddressId: book.mailAddressId,
    name: input.name ?? book.name,
    description:
      input.description === undefined ? book.description : input.description,
    isDefault: book.isDefault,
    createdAt: book.createdAt,
    updatedAt,
  });
}
