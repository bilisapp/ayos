import type { JobEvent } from "./schema.ts";

/**
 * Bounded event log kept in actor state. Old events are dropped once the cap is
 * hit; `seq` keeps increasing so a reconnecting client can tell it missed some.
 */
export class RingBuffer {
  private items: JobEvent[];
  private nextSeq: number;

  constructor(
    private readonly capacity: number = 2000,
    initial: JobEvent[] = [],
    nextSeq?: number,
  ) {
    this.items = initial.slice(-capacity);
    this.nextSeq = nextSeq ?? (this.items.at(-1)?.seq ?? 0) + 1;
  }

  push(event: Omit<JobEvent, "seq" | "ts"> & { ts?: string }): JobEvent {
    const full: JobEvent = {
      seq: this.nextSeq++,
      ts: event.ts ?? new Date().toISOString(),
      type: event.type,
      data: event.data,
    };
    this.items.push(full);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    return full;
  }

  /** Events with seq > after, for replay on (re)connect. */
  since(after = 0): JobEvent[] {
    return after <= 0 ? [...this.items] : this.items.filter((e) => e.seq > after);
  }

  all(): JobEvent[] {
    return [...this.items];
  }

  get size(): number {
    return this.items.length;
  }

  get dropped(): boolean {
    return (this.items[0]?.seq ?? 1) > 1;
  }

  toJSON(): { events: JobEvent[]; nextSeq: number } {
    return { events: [...this.items], nextSeq: this.nextSeq };
  }

  static fromJSON(
    snapshot: { events: JobEvent[]; nextSeq: number } | undefined,
    capacity = 2000,
  ): RingBuffer {
    return new RingBuffer(capacity, snapshot?.events ?? [], snapshot?.nextSeq);
  }
}
