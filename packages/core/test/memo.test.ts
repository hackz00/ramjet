import { describe, expect, it } from "vitest";
import { BoundedLru } from "@/shared/memo";

describe("BoundedLru", () => {
  it("evicts the least recently used entry at capacity", () => {
    const lru = new BoundedLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
    expect(lru.size).toBe(2);
  });

  it("treats a get as a use", () => {
    const lru = new BoundedLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBeUndefined();
  });

  it("overwriting a key does not evict another", () => {
    const lru = new BoundedLru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 9);
    expect(lru.get("a")).toBe(9);
    expect(lru.get("b")).toBe(2);
  });

  it("rejects a capacity below one", () => {
    expect(() => new BoundedLru(0)).toThrow(RangeError);
  });
});
