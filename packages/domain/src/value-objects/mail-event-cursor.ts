const MAIL_EVENT_CURSOR_PATTERN = /^([0-9a-f]{16})\.(0|[1-9][0-9]*)$/;

export function formatMailEventCursor(epoch: string, seq: number): string {
  return `${epoch}.${seq}`;
}

export function parseMailEventCursor(
  raw: string,
): { readonly epoch: string; readonly seq: number } | null {
  if (typeof raw !== "string") {
    return null;
  }

  const match = MAIL_EVENT_CURSOR_PATTERN.exec(raw);
  if (match === null) {
    return null;
  }

  const epoch = match[1];
  const sequenceText = match[2];
  if (epoch === undefined || sequenceText === undefined) {
    return null;
  }

  const seq = Number(sequenceText);
  if (!Number.isSafeInteger(seq)) {
    return null;
  }

  return { epoch, seq };
}
