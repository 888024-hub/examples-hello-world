import { serveFile } from "jsr:@std/http/file-server";

const HOST = Deno.env.get("GLOBED_TCP_HOST")?.trim() ?? "";
const PORT = Number(Deno.env.get("GLOBED_TCP_PORT") ?? "4349");
const TOKEN = Deno.env.get("GLOBED_PROXY_TOKEN") ?? "";
const MAX_CLIENT_MESSAGE_BYTES = 1024 * 1024;
const MAX_WS_BUFFER_BYTES = 2 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 8000;

let activeConnections = 0;
const MAX_CONNECTIONS = 50;

function configured(): boolean {
  return HOST.length > 0 &&
    Number.isInteger(PORT) &&
    PORT >= 1 &&
    PORT <= 65535 &&
    TOKEN.length >= 24;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
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

async function tunnel(req: Request): Promise<Response> {
  if (!configured()) {
    return json({
      error: "Configure GLOBED_TCP_HOST, GLOBED_TCP_PORT and a GLOBED_PROXY_TOKEN of at least 24 characters.",
    }, 503);
  }

  if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade required", {
      status: 426,
      headers: { upgrade: "websocket" },
    });
  }

  if (activeConnections >= MAX_CONNECTIONS) {
    return json({ error: "Bridge is at capacity" }, 503);
  }

  let tcp: Deno.Conn;
  try {
    tcp = await Deno.connect({
      hostname: HOST,
      port: PORT,
      transport: "tcp",
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    });
  } catch (error) {
    console.error("Could not connect to configured Globed TCP endpoint:", error);
    return json({ error: "Could not connect to the configured Globed TCP server" }, 502);
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

      const bytes = await bytesFromMessage(event.data);
      if (bytes.byteLength > MAX_CLIENT_MESSAGE_BYTES) {
        close(1009, "Message too large");
        return;
      }

      await writeAll(tcp, bytes);
    }).catch((error: unknown) => {
      console.warn("WebSocket-to-TCP forwarding failed:", error);
      close(1011, "TCP write failed");
    });
  });

  socket.addEventListener("close", () => close());
  socket.addEventListener("error", () => close(1011, "WebSocket error"));

  void (async () => {
    const buffer = new Uint8Array(16 * 1024);
    try {
      while (!closed) {
        const count = await tcp.read(buffer);
        if (count === null) {
          close(1000, "Globed server closed the connection");
          return;
        }
        if (count === 0) continue;

        if (socket.readyState !== WebSocket.OPEN) {
          close(1000, "WebSocket is not open");
          return;
        }
        if (socket.bufferedAmount > MAX_WS_BUFFER_BYTES) {
          close(1013, "Client is too slow");
          return;
        }

        // Keep payload bytes unchanged. TCP read boundaries are arbitrary,
        // so the WebSocket client must concatenate binary messages as a stream.
        socket.send(buffer.slice(0, count));
      }
    } catch (error) {
      if (!closed) {
        console.warn("TCP-to-WebSocket forwarding failed:", error);
        close(1011, "TCP read failed");
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

  if (url.pathname === "/ws") {
    if (req.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET" },
      });
    }
    return await tunnel(req);
  }

  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    return new Response("Not found", { status: 404 });
  }

  return await serveFile(req, "./index.html");
});
