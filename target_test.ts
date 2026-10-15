import { assertEquals, assertThrows } from "@std/assert";
import { parseAllowedTarget } from "./target.ts";

function toHex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

const hosts = new Set(["*.globed.example", "203.0.113.8"]);
const ports = new Set([4349]);

Deno.test("accepts a Globed-style udp:// host URL for TCP forwarding", () => {
  assertEquals(
    parseAllowedTarget(
      toHex("udp://game.globed.example:4349"),
      hosts,
      ports,
    ),
    { hostname: "game.globed.example", port: 4349 },
  );
});

Deno.test("accepts bare host:port by treating it as tcp://", () => {
  assertEquals(
    parseAllowedTarget(toHex("game.globed.example:4349"), hosts, ports),
    { hostname: "game.globed.example", port: 4349 },
  );
});

Deno.test("accepts an exact allowlisted IPv4 target", () => {
  assertEquals(
    parseAllowedTarget(toHex("udp://203.0.113.8:4349"), hosts, ports),
    { hostname: "203.0.113.8", port: 4349 },
  );
});

Deno.test("rejects hosts outside the allowlist", () => {
  assertThrows(() =>
    parseAllowedTarget(toHex("udp://not-allowed.example:4349"), hosts, ports)
  );
});

Deno.test("rejects ports outside the allowlist", () => {
  assertThrows(() =>
    parseAllowedTarget(toHex("tcp://game.globed.example:4444"), hosts, ports)
  );
});

Deno.test("rejects URLs with paths or query parameters", () => {
  assertThrows(() =>
    parseAllowedTarget(toHex("udp://game.globed.example:4349/path"), hosts, ports)
  );
  assertThrows(() =>
    parseAllowedTarget(toHex("udp://game.globed.example:4349?x=1"), hosts, ports)
  );
});

Deno.test("rejects malformed target_hex", () => {
  assertThrows(() => parseAllowedTarget("xyz", hosts, ports));
});
