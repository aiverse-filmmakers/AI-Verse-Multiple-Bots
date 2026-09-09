import { createId } from "./id.js";
import { CoordinationStore } from "./store.js";
import type { AppendedEvent, CoordinationEvent } from "./types.js";
import { validateProtocolObject } from "./validator.js";

export interface PublishEventOptions {
  idempotencyKey?: string;
}

export type EventReplayQuery =
  | { scope: "global"; afterSequence?: number; limit?: number }
  | { scope: "room"; roomId: string; afterRoomSequence?: number; limit?: number; threadId?: string }
  | { scope: "run"; runId: string; afterRunSequence?: number; limit?: number }
  | { scope: "correlation"; correlationId: string; afterSequence?: number; limit?: number };

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error(`Event replay limit must be an integer between 1 and 1000; received ${String(value)}`);
  }
  return limit;
}

function nonNegativeCursor(value: number | undefined, name: string): number {
  const cursor = value ?? 0;
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new Error(`${name} must be a non-negative integer; received ${String(value)}`);
  }
  return cursor;
}

export class CanonicalEventBus {
  private readonly subscribers = new Set<(event: AppendedEvent) => void>();

  constructor(readonly store: CoordinationStore) {}

  subscribe(listener: (event: AppendedEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  prepare(event: CoordinationEvent): CoordinationEvent {
    validateProtocolObject(event, "event");
    const causationId = optionalString(event.causation_id);
    let correlationId = optionalString(event.correlation_id);

    if (causationId) {
      const parent = this.store.getEventById(causationId);
      if (!parent) throw new Error(`Causation event ${causationId} was not found`);
      const parentCorrelation = optionalString(parent.event.correlation_id) ?? parent.event.id;
      if (correlationId && correlationId !== parentCorrelation) {
        throw new Error(
          `Event ${event.id} correlation ${correlationId} conflicts with causation event ${causationId} correlation ${parentCorrelation}`
        );
      }
      correlationId = parentCorrelation;
    }

    if (!correlationId) correlationId = createId("corr");

    return {
      ...event,
      correlation_id: correlationId,
      causation_id: causationId
    };
  }

  publish(event: CoordinationEvent, options: PublishEventOptions = {}): AppendedEvent {
    const appended = this.store.appendEvent(this.prepare(event), options.idempotencyKey);
    this.publishCommitted([appended]);
    return appended;
  }

  publishCausedBy(
    event: CoordinationEvent,
    causationEventId: string,
    options: PublishEventOptions = {}
  ): AppendedEvent {
    return this.publish({ ...event, causation_id: causationEventId }, options);
  }

  replay(query: EventReplayQuery): AppendedEvent[] {
    const limit = boundedLimit(query.limit);
    switch (query.scope) {
      case "global":
        return this.store.listEventsAfter(nonNegativeCursor(query.afterSequence, "afterSequence"), limit);
      case "room":
        return this.store.listRoomEvents(
          query.roomId,
          nonNegativeCursor(query.afterRoomSequence, "afterRoomSequence"),
          limit,
          query.threadId
        );
      case "run":
        return this.store.listRunEvents(query.runId, nonNegativeCursor(query.afterRunSequence, "afterRunSequence"), limit);
      case "correlation":
        return this.store.listCorrelationEvents(
          query.correlationId,
          nonNegativeCursor(query.afterSequence, "afterSequence"),
          limit
        );
    }
  }

  publishCommitted(events: AppendedEvent[]): void {
    for (const event of events) {
      for (const listener of this.subscribers) listener(event);
    }
  }
}
