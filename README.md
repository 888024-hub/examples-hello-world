# Globed main-server WebSocket-to-TCP bridge

This Deno Deploy app is a transport adapter for the **official Globed main server**.
It does not require changing the central server. Instead, a patched Globed client
routes its chosen game-server connection through this bridge. The bridge translates
Qunet WebSocket messages to the framing used by the game server's TCP transport.

## Important: a client patch is required

The official central server supplies the actual gameplay-server URL to each client.
The stock client connects to that URL directly, so a server-side app alone cannot
reroute the gameplay connection. Apply `client-patch.diff` to the matching
`GlobedGD/globed2` source revision and set `GAME_WS_TCP_BRIDGE_BASE_URL` to:

```text
wss://YOUR-DEPLOY-HOST/ws/YOUR-TOKEN
```

Then build and use that custom client. The patch leaves the original selected
game-server address intact in Globed's state, but changes the transport connection
to the WSS bridge and hex-encodes the original address into `target_hex`.

## Deno Deploy environment

Set:

- `GLOBED_PROXY_TOKEN`: at least 24 URL-safe characters (letters, digits, `-`, `_`).
- `GLOBED_ALLOWED_GAME_HOSTS`: comma-separated hostnames/IPs that the official
  central server may advertise, for example `game1.example.org,game2.example.org`.
  Exact hostnames and wildcard domain rules such as `*.example.org` are supported.
- `GLOBED_ALLOWED_GAME_PORTS`: comma-separated TCP ports, usually `4349`.

You must populate the allowlist with the **actual game-server hosts** returned by
the official main server. The central server's HTTP/API hostname is not necessarily
the gameplay-server host. This bridge intentionally refuses unknown hosts instead
of becoming an unrestricted TCP proxy. When the official server list changes,
update the allowlist accordingly.

`/healthz` checks that the configuration is present; it does not prove that the
hosts are reachable from Deploy. The configured public game-server hosts must
accept TCP connections. The Globed game-server source currently defaults its TCP
listener to port `4349`, but the public server's running configuration is what
ultimately determines availability.

## How the transport conversion works

Ported from Qunet's stream transport and WebSocket transport implementation:

- Qunet WebSocket transport sends one Qunet message per binary WebSocket frame.
- Qunet TCP stream transport uses a 4-byte little-endian message-length prefix
  for ordinary messages, except initial `HandshakeStart` (`0x05`) and
  `ClientReconnect` (`0x0a`) messages sent by the client.
- The bridge converts those outer framing rules, buffers split/coalesced TCP reads,
  and forwards Qunet message bytes without interpreting gameplay events.

The bridge has an 8-second TCP connect timeout, a 16 MiB message limit, and a
maximum of 50 active connections per running instance. The URL token is visible
to anyone who can see the configured client/server address; the host and port
allowlist is the important backend restriction.

## Endpoints

- Health: `https://YOUR-DEPLOY-HOST/healthz`
- WebSocket: `wss://YOUR-DEPLOY-HOST/ws/YOUR-TOKEN?target_hex=...`

## Tests

Run `deno test framing_test.ts` locally before deploying. Also test the patched
client against the live main server; this environment has not run a live-server
integration test.
