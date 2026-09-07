import { createHash, randomUUID } from "node:crypto";

import type {
  BrainEvent,
  BrainEventType,
  EventStore,
  LedgerVerificationResult,
} from "@neurosa/runtime-domain";

export const GENESIS_HASH = "0".repeat(64);

export interface LedgerClock {
  now(): string;
}

export interface LedgerIdGenerator {
  next(): string;
}

const systemClock: LedgerClock = { now: () => new Date().toISOString() };
const uuidGenerator: LedgerIdGenerator = { next: () => randomUUID() };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;

  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function calculateEventHash(
  event: Pick<
    BrainEvent,
    "sequence" | "eventType" | "activationId" | "timestamp" | "payload" | "previousHash"
  >,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        sequence: event.sequence,
        eventType: event.eventType,
        activationId: event.activationId,
        timestamp: event.timestamp,
        payload: event.payload,
        previousHash: event.previousHash,
      }),
      "utf8",
    )
    .digest("hex");
}

export function verifyLedgerEvents(events: readonly BrainEvent[]): LedgerVerificationResult {
  const errors: string[] = [];
  let previousHash = GENESIS_HASH;

  events.forEach((event, index) => {
    const expectedSequence = index + 1;
    if (event.sequence !== expectedSequence) {
      errors.push(
        `Nieciągła kolejność dziennika: oczekiwano ${String(expectedSequence)}, otrzymano ${String(event.sequence)}`,
      );
    }
    if (event.previousHash !== previousHash) {
      errors.push(`Nieprawidłowy previousHash zdarzenia ${event.eventId}`);
    }
    const expectedHash = calculateEventHash(event);
    if (event.eventHash !== expectedHash) {
      errors.push(`Nieprawidłowy eventHash zdarzenia ${event.eventId}`);
    }
    previousHash = event.eventHash;
  });

  return { valid: errors.length === 0, errors };
}

export class InMemoryEventStore implements EventStore {
  private readonly events: BrainEvent[] = [];

  appendEvent(event: BrainEvent): void {
    const previous = this.events.at(-1);
    if (event.sequence !== this.events.length + 1) {
      throw new Error("Nie można nadpisać ani zmienić kolejności zdarzeń dziennika");
    }
    if (event.previousHash !== (previous?.eventHash ?? GENESIS_HASH)) {
      throw new Error("Nieprawidłowy previousHash nowego zdarzenia dziennika");
    }
    this.events.push(structuredClone(event));
  }

  listEvents(): readonly BrainEvent[] {
    return structuredClone(this.events);
  }
}

export class HashChainLedger {
  constructor(
    private readonly store: EventStore,
    private readonly clock: LedgerClock = systemClock,
    private readonly ids: LedgerIdGenerator = uuidGenerator,
  ) {}

  append(eventType: BrainEventType, activationId: string | null, payload: unknown): BrainEvent {
    const events = this.store.listEvents();
    const previous = events.at(-1);
    const draft = {
      eventId: this.ids.next(),
      sequence: events.length + 1,
      eventType,
      activationId,
      timestamp: this.clock.now(),
      payload: structuredClone(payload),
      previousHash: previous?.eventHash ?? GENESIS_HASH,
    };
    const event: BrainEvent = { ...draft, eventHash: calculateEventHash(draft) };
    this.store.appendEvent(event);
    return event;
  }

  list(): readonly BrainEvent[] {
    return this.store.listEvents();
  }

  verifyLedger(): LedgerVerificationResult {
    return verifyLedgerEvents(this.list());
  }
}
