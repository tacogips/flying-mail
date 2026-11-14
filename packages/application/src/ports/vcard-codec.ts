import type { Contact } from "@flying-mail/domain/entities/contact";

export interface ParsedVcardEmail {
  readonly address: string;
  readonly label: string | null;
}

export interface ParsedVcardPhone {
  readonly number: string;
  readonly label: string | null;
}

export interface ParsedVcardPostalAddress {
  readonly formatted: string;
  readonly label: string | null;
}

export interface ParsedVcardContact {
  readonly uid: string;
  readonly displayName: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly nickname: string | null;
  readonly organization: string | null;
  readonly title: string | null;
  readonly emails: readonly ParsedVcardEmail[];
  readonly phones: readonly ParsedVcardPhone[];
  readonly postalAddresses: readonly ParsedVcardPostalAddress[];
  readonly urls: readonly string[];
  readonly note: string | null;
  readonly birthday: string | null;
  /** Every unsupported line (`PHOTO`, `X-*`, `item1.`-grouped, ...)
   * verbatim, folded/unfolded but otherwise untouched, for round-trip
   * fidelity. */
  readonly extraVcardLines: string | null;
  /** True only when the vCard could not be parsed at all. A partially
   * modeled vCard is not flagged here; it imports what it can and keeps the
   * rest in `extraVcardLines`. */
  readonly unparsable: boolean;
}

/** RFC 6350 subset codec. The application layer states the contract and the
 * adapter owns the grammar. */
export interface VcardCodec {
  /** `null` when the vCard could not be parsed at all. */
  parseVcard(vcard: string): ParsedVcardContact | null;
  /** vCard 3.0 output -- iCloud's dialect. */
  formatVcard(contact: Contact): string;
}
