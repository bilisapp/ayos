import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/events/ringBuffer.ts";
import type { JobEvent } from "../src/events/schema.ts";

function pushN(buf: RingBuffer, n: number, from = 0): JobEvent[] {
  const out: JobEvent[] = [];
  for (let i = 0; i < n; i++) out.push(buf.push({ type: "phase", data: { i: from + i } }));
  return out;
}

describe("seq", () => {
  it("starts at 1 and increments monotonically", () => {
    const buf = new RingBuffer();
    expect(buf.push({ type: "phase", data: { state: "cloning" } }).seq).toBe(1);
    expect(buf.push({ type: "phase", data: { state: "fixing" } }).seq).toBe(2);
    expect(buf.push({ type: "done", data: {} }).seq).toBe(3);
    expect(buf.all().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("stamps ts automatically but honours an explicit one", () => {
    const buf = new RingBuffer();
    const auto = buf.push({ type: "phase", data: {} });
    expect(Number.isNaN(Date.parse(auto.ts))).toBe(false);
    const fixed = buf.push({ type: "phase", data: {}, ts: "2026-08-27T00:00:00.000Z" });
    expect(fixed.ts).toBe("2026-08-27T00:00:00.000Z");
  });

  it("returns the same object it stored", () => {
    const buf = new RingBuffer();
    const ev = buf.push({ type: "agent_message", data: { text: "hi" } });
    expect(buf.all()[0]).toEqual(ev);
  });
});

describe("since()", () => {
  it("replays everything for since(0) and since() with no arg", () => {
    const buf = new RingBuffer();
    pushN(buf, 5);
    expect(buf.since().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(buf.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(buf.since(-10).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns strictly events after the given seq (client has already seen n)", () => {
    const buf = new RingBuffer();
    pushN(buf, 5);
    expect(buf.since(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(buf.since(1).map((e) => e.seq)).toEqual([2, 3, 4, 5]);
  });

  it("returns nothing when the client is already caught up or ahead", () => {
    const buf = new RingBuffer();
    pushN(buf, 5);
    expect(buf.since(5)).toEqual([]);
    expect(buf.since(99)).toEqual([]);
  });

  it("hands back copies, so a caller cannot mutate the buffer", () => {
    const buf = new RingBuffer();
    pushN(buf, 3);
    buf.all().pop();
    buf.since(0).pop();
    expect(buf.size).toBe(3);
  });
});

describe("capacity eviction", () => {
  it("drops the oldest events while seq keeps climbing", () => {
    const buf = new RingBuffer(3);
    pushN(buf, 5);
    expect(buf.size).toBe(3);
    expect(buf.all().map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(buf.push({ type: "done", data: {} }).seq).toBe(6);
    expect(buf.all().map((e) => e.seq)).toEqual([4, 5, 6]);
  });

  it("since() over an evicted range returns only what survived", () => {
    const buf = new RingBuffer(3);
    pushN(buf, 6);
    // client last saw seq 1; events 2-3 are gone, it gets 4,5,6 and `dropped` warns it
    expect(buf.since(1).map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(buf.dropped).toBe(true);
  });

  it("never exceeds capacity across many pushes", () => {
    const buf = new RingBuffer(10);
    pushN(buf, 1000);
    expect(buf.size).toBe(10);
    expect(buf.all().map((e) => e.seq)).toEqual([991, 992, 993, 994, 995, 996, 997, 998, 999, 1000]);
  });
});

describe("dropped flag", () => {
  it("is false for an empty buffer", () => {
    expect(new RingBuffer(3).dropped).toBe(false);
  });

  it("is false while everything since seq 1 is still held", () => {
    const buf = new RingBuffer(3);
    pushN(buf, 3);
    expect(buf.dropped).toBe(false);
  });

  it("flips to true on the first eviction", () => {
    const buf = new RingBuffer(3);
    pushN(buf, 3);
    expect(buf.dropped).toBe(false);
    buf.push({ type: "phase", data: {} });
    expect(buf.dropped).toBe(true);
  });
});

describe("toJSON / fromJSON (resume on restart)", () => {
  it("round-trips events and continues seq where it left off", () => {
    const buf = new RingBuffer(100);
    pushN(buf, 4);
    const snap = buf.toJSON();
    expect(snap.nextSeq).toBe(5);

    const revived = RingBuffer.fromJSON(snap, 100);
    expect(revived.all()).toEqual(buf.all());
    expect(revived.push({ type: "done", data: {} }).seq).toBe(5);
    expect(revived.since(4).map((e) => e.seq)).toEqual([5]);
  });

  it("preserves nextSeq even when the buffer evicted everything it held", () => {
    const buf = new RingBuffer(2);
    pushN(buf, 10);
    const revived = RingBuffer.fromJSON(buf.toJSON(), 2);
    expect(revived.toJSON().nextSeq).toBe(11);
    expect(revived.push({ type: "done", data: {} }).seq).toBe(11);
    expect(revived.dropped).toBe(true);
  });

  it("snapshot is a copy — later pushes do not leak into it", () => {
    const buf = new RingBuffer(100);
    pushN(buf, 2);
    const snap = buf.toJSON();
    pushN(buf, 2, 2);
    expect(snap.events).toHaveLength(2);
    expect(snap.nextSeq).toBe(3);
  });

  it("fromJSON(undefined) yields a fresh buffer starting at seq 1", () => {
    const buf = RingBuffer.fromJSON(undefined);
    expect(buf.size).toBe(0);
    expect(buf.dropped).toBe(false);
    expect(buf.push({ type: "phase", data: {} }).seq).toBe(1);
  });

  it("re-trims to capacity when restored with a smaller cap", () => {
    const buf = new RingBuffer(100);
    pushN(buf, 10);
    const revived = RingBuffer.fromJSON(buf.toJSON(), 3);
    expect(revived.size).toBe(3);
    expect(revived.all().map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(revived.push({ type: "done", data: {} }).seq).toBe(11);
  });

  it("derives nextSeq from the last event when the snapshot omits it", () => {
    const events: JobEvent[] = [
      { seq: 7, ts: "2026-08-27T00:00:00.000Z", type: "phase", data: {} },
    ];
    const buf = new RingBuffer(10, events);
    expect(buf.push({ type: "done", data: {} }).seq).toBe(8);
  });

  it("survives repeated snapshot/restore cycles without resetting seq", () => {
    let buf = new RingBuffer(5);
    for (let round = 0; round < 4; round++) {
      pushN(buf, 3);
      buf = RingBuffer.fromJSON(buf.toJSON(), 5);
    }
    expect(buf.toJSON().nextSeq).toBe(13);
  });
});
