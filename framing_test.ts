import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  frameWebSocketQunetMessage,
  QunetTcpFrameDecoder,
} from "./framing.ts";

Deno.test("ordinary WebSocket message gets a little-endian TCP length prefix", () => {
  const message = new Uint8Array([0x80, 0xaa, 0xbb]);
  const framed = frameWebSocketQunetMessage(message);

  assertEquals(framed.slice(0, 4), new Uint8Array([3, 0, 0, 0]));
  assertEquals(framed.slice(4), message);
});

Deno.test("Qunet HandshakeStart and ClientReconnect are not length-prefixed", () => {
  const handshake = new Uint8Array([0x05, 1, 0, 2, 0]);
  const reconnect = new Uint8Array([0x0a, 1, 2, 3, 4]);

  assert(frameWebSocketQunetMessage(handshake) === handshake);
  assert(frameWebSocketQunetMessage(reconnect) === reconnect);
});

Deno.test("TCP decoder handles split messages and multiple frames", () => {
  const decoder = new QunetTcpFrameDecoder();
  const first = new Uint8Array([3, 0, 0, 0, 0x80, 0xaa, 0xbb]);
  const second = new Uint8Array([2, 0, 0, 0, 0x03, 0x10]);
  const both = new Uint8Array([...first, ...second]);

  assertEquals(decoder.push(both.slice(0, 2)), []);
  assertEquals(decoder.push(both.slice(2, 9)), [new Uint8Array([0x80, 0xaa, 0xbb])]);
  assertEquals(decoder.push(both.slice(9)), [new Uint8Array([0x03, 0x10])]);
});

Deno.test("TCP decoder skips zero-length records", () => {
  const decoder = new QunetTcpFrameDecoder();
  assertEquals(decoder.push(new Uint8Array([0, 0, 0, 0])), []);
});

Deno.test("TCP decoder rejects oversized frames", () => {
  const decoder = new QunetTcpFrameDecoder(2);
  assertThrows(() => decoder.push(new Uint8Array([3, 0, 0, 0])));
});
