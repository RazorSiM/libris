import type { Ref } from "vue";

export interface ServerEvent {
  type: string;
  bookId?: string;
  payload?: Record<string, unknown>;
  timestamp: string;
}

export type EventHandler = (event: ServerEvent) => void;

export interface ServerEventsApi {
  subscribe: (handler: EventHandler) => () => void;
  status: Ref<string>;
  error: Ref<Event | null>;
}
