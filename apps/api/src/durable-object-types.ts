import type { DurableObjectNamespaceLike } from "@flying-mail/adapter/realtime/mail-event-notifiers";

export type { DurableObjectNamespaceLike };

export interface HibernatableWebSocketLike {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment(): unknown;
}

export interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { readonly prefix: string }): Promise<Map<string, T>>;
  setAlarm(milliseconds: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface DurableObjectStateLike {
  readonly storage: DurableObjectStorageLike;
  acceptWebSocket(ws: HibernatableWebSocketLike, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableWebSocketLike[];
  setWebSocketAutoResponse(pair: unknown): void;
  getWebSocketAutoResponseTimestamp(ws: HibernatableWebSocketLike): Date | null;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
