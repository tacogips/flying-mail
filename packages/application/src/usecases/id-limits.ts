import { BadUserInputError } from "../errors";

/** Upper bound on an id array accepted from a caller. D1 allows at most 100
 * bound parameters per statement and these arrays are bound as `IN (...)`
 * lists, so a longer array would fail inside the database instead of with a
 * clear `BAD_USER_INPUT`. Re-exported from `mail-limits.ts`. */
export const MAX_IDS_PER_REQUEST = 100;

/** Rejects an id array longer than {@link MAX_IDS_PER_REQUEST}. An empty
 * array is left to each use case, which already treats it as a no-op. */
export function assertIdCountWithinLimit(
  ids: readonly unknown[],
  field: string,
): void {
  if (ids.length > MAX_IDS_PER_REQUEST) {
    throw new BadUserInputError(
      `${field} may not contain more than ${MAX_IDS_PER_REQUEST} ids`,
      field,
    );
  }
}
