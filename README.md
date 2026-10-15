# Globed WebSocket-to-TCP bridge

This Deno Deploy app exposes an authenticated binary WebSocket endpoint at `/ws`
and relays its payload bytes to one configured Globed TCP endpoint. It does not
let clients select a destination host or port.

## Deploy configuration

Set these environment variables in Deno Deploy:

- `GLOBED_TCP_HOST`: hostname of the Globed **game server**.
- `GLOBED_TCP_PORT`: TCP port, normally `4349` when TCP is enabled on the game server.
- `GLOBED_PROXY_TOKEN`: a long random secret, at least 24 characters.

`/healthz` reports whether these settings are present and valid. It does not
test connectivity to the backend. WebSocket clients must connect to
`wss://<your-deployment-host>/ws` and send
`Authorization: Bearer <GLOBED_PROXY_TOKEN>` during the HTTP upgrade.

## Wire behavior

The bridge intentionally does **not** add, remove, compress, or interpret packet
headers. Each incoming binary WebSocket message is written to the TCP socket in
order. TCP reads are emitted as binary WebSocket messages. Since TCP does not
preserve read/write boundaries, the WebSocket client adapter must concatenate
all incoming binary payloads into one byte stream and expose stream-like reads
to the Globed/Qunet protocol layer.

The bridge is only the server half of the tunnel. The normal, unmodified Globed
client does not use WebSockets for gameplay connections. A compatible client-side
transport adapter is required, including the bearer header and byte-stream
reassembly. This repository does not include or build that native client adapter.

## Limits and security

- Only the configured backend is reachable; clients cannot supply host/port.
- Binary messages only, maximum 1 MiB per client message.
- 50 concurrent connections per running instance.
- Connection timeout: 8 seconds.
- A bearer token is required. Keep it secret and do not put it in a URL.
- This is a raw TCP relay, not a protocol-aware gameplay-event converter.

Test against a Globed game server with TCP enabled. Hosting TCP on port 4349
is the common default, but the port may be customized in your game-server
configuration.
