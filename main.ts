import { serveFile } from "jsr:@std/http/file-server";
import {
  frameWebSocketQunetMessage,
  MAX_QUNET_FRAME_BYTES,
  QunetTcpFrameDecoder,
} from "./framing.ts";

const TOKEN = Deno.env.get("GLOBED_PROXY_TOKEN") ?? "";
const ALLOWED_HOSTS = new Set(
  (Deno.env.get("GLOBED_ALLOWED_GAME_HOSTS") ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean),
);
const ALLOWED_PORTS = new Set(
  (Deno.env.get("GLOBED_ALLOWED_GAME_PORTS") ?? "4349")
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535),
);

const MAX_WS_BUFFER_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 8000;
const MAX_CONNECTIONS = 50;

let activeConnections = 0;

function configured(): boolean {
  return TOKEN.length >= 24 &&
    /^[A-Za-z0-9_-]+$/.test(TOKEN) &&
    ALLOWED_HOSTS.size > 0 &&
    ALLOWED_PORTS.size > 0;
}

function isAllowedHost(hostname: string): boolean {
  for (const rule of ALLOWED_HOSTS) {
    if (rule.startsWith("*.")) {
      const suffix = rule.slice(1); // ".example.com"
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
        return true;
      }
    } else if (hostname === rule) {
      return true;
    }
  }
  return false;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function decodeHex(value: string): string {
  if (!value || value.length > 2048 || value.length % 2 !== 0 ||
      !/^[0-9a-f]+$/i.test(value)) {
    throw new TypeError("Invalid target_hex");
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

type TcpTarget = { hostname: string; port: number };

function parseAllowedTarget(targetHex: string | null): TcpTarget {
  if (!targetHex) throw new TypeError("Missing target_hex");

  const original = decodeHex(targetHex);
  let target: URL;

  try {
    // Qunet server listings usually provide protocol://host:port.
    // Add tcp:// for bare host:port addresses; do not allow a URL path/query.
    target = new URL(original.includes("://") ? original : `tcp://${original}`);
  } catch {
    throw new TypeError("Invalid game-server address");
  }

  if (!["udp:", "tcp:", "quic:", "qunet:"].includes(target.protocol)) {
    throw new TypeError("Unsupported game-server URL protocol");
  }
  if (target.username || target.password || target.pathname !== "/" ||
      target.search || target.hash || !target.port) {
    throw new TypeError("Expected a simple host:port game-server address");
  }

  const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
  const port = Number(target.port);

  if (!isAllowedHost(hostname)) {
    throw new TypeError("Game-server host is not allowlisted");
  }
  if (!ALLOWED_PORTS.has(port)) {
    throw new TypeError("Game-server TCP port is not allowlisted");
  }

  return { hostname, port };
}

async function bytesFromMessage(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  throw new TypeError("Binary WebSocket messages required");
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await conn.write(bytes.subarray(offset));
    if (written <= 0) throw new Error("TCP write made no progress");
    offset += written;
  }
}

async function tunnel(req: Request, url: URL): Promise<Response> {
  if (!configured()) {
    return json({
      error: "Configure GLOBED_PROXY_TOKEN, GLOBED_ALLOWED_GAME_HOSTS and GLOBED_ALLOWED_GAME_PORTS.",
    }, 503);
  }

  // Qunet's WebSocket client carries the URL path but does not currently
  // attach a custom Authorization header from Globed's game transport.
  if (url.pathname !== `/ws/${TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", {
      status: 426,
      headers: { upgrade: "websocket" },
    });
  }

  let target: TcpTarget;
  try {
    target = parseAllowedTarget(url.searchParams.get("target_hex"));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid target" }, 400);
  }

  if (activeConnections >= MAX_CONNECTIONS) {
    return json({ error: "Bridge is at capacity" }, 503);
  }

  let tcp: Deno.Conn;
  try {
    tcp = await Deno.connect({
      hostname: target.hostname,
      port: target.port,
      transport: "tcp",
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("Could not connect to allowlisted Globed TCP endpoint:", error);
    return json({ error: "Could not connect to the configured Globed game server" }, 502);
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  socket.binaryType = "arraybuffer";
  activeConnections++;

  let closed = false;
  let writeQueue = Promise.resolve();

  function close(code = 1000, reason = "Connection closed"): void {
    if (closed) return;
    closed = true;
    activeConnections = Math.max(0, activeConnections - 1);
    try {
      tcp.close();
    } catch {
      // The TCP connection may already be closed.
    }
    try {
      if (socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason.slice(0, 120));
      }
    } catch {
      // The WebSocket peer may already have disconnected.
    }
  }

  socket.addEventListener("message", (event: MessageEvent) => {
    writeQueue = writeQueue.then(async () => {
      if (closed) return;
      if (typeof event.data === "string") {
        close(1003, "Binary messages required");
        return;
      }

      const message = await bytesFromMessage(event.data);
      if (message.byteLength > MAX_QUNET_FRAME_BYTES) {
        close(1009, "Message too large");
        return;
      }

      // Maps one Qunet WS message into the TCP stream wire format.
      await writeAll(tcp, frameWebSocketQunetMessage(message));
    }).catch((error: unknown) => {
      console.warn("WebSocket-to-TCP forwarding failed:", error);
      if (error instanceof RangeError) close(1009, "Message too large");
      else close(1011, "TCP write failed");
    });
  });

  socket.addEventListener("close", () => close());
  socket.addEventListener("error", () => close(1011, "WebSocket error"));

  void (async () => {
    const decoder = new QunetTcpFrameDecoder();
    const buffer = new Uint8Array(16 * 1024);

    try {
      while (!closed) {
        const count = await tcp.read(buffer);
        if (count === null) {
          close(1000, "Globed server closed the connection");
          return;
        }
        if (count === 0) continue;

        for (const message of decoder.push(buffer.subarray(0, count))) {
          if (closed) return;
          if (socket.readyState !== WebSocket.OPEN) {
            close(1011, "WebSocket is not open");
            return;
          }
          if (socket.bufferedAmount > MAX_WS_BUFFER_BYTES) {
            close(1013, "Client is too slow");
            return;
          }
          socket.send(message);
        }
      }
    } catch (error) {
      if (!closed) {
        console.warn("TCP-to-WebSocket forwarding failed:", error);
        if (error instanceof RangeError) close(1009, "TCP frame too large");
        else close(1011, "TCP read failed");
      }
    } finally {
      if (!closed) close();
    }
  })();

  return response;
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);

  if (url.pathname === "/healthz" && req.method === "GET") {
    const ok = configured();
    return json({ ok, service: "globed-ws-tcp-bridge" }, ok ? 200 : 503);
  }

  if (url.pathname.startsWith("/ws")) {
    if (req.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET" },
      });
    }
    return await tunnel(req, url);
  }

  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return new Response("Not found", { status: 404 });
  }

  return await serveFile(req, "./index.html");
});
