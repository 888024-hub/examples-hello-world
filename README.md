# Globed WebSocket-to-TCP bridge

This Deno Deploy app exposes an authenticated WebSocket endpoint for a Globed
**game server** whose TCP transport is enabled. It translates the outer Qunet
transport framing while preserving the Qunet message payloads.

## Configure Deno Deploy

Set these environment variables:

- `GLOBED_TCP_HOST`: hostname/IP of the actual Globed game server, reachable from Deno Deploy.
- `GLOBED_TCP_PORT`: game server TCP port; normally `4349`.
- `GLOBED_PROXY_TOKEN`: at least 24 URL-safe characters (letters, digits, `-`, `_`).

`/healthz` checks the configuration, not backend reachability.

## Configure the game server

Enable TCP in the game server config, commonly:

```toml
[tcp]
enable = true
address = "[::]:4349"
```

Set the game's advertised client-facing address to the deployed WebSocket URL:

```toml
server_address = "wss://YOUR-DEPLOY-HOST/ws/YOUR-TOKEN"
```

Replace the host and token with your deployment hostname and the exact value of
`GLOBED_PROXY_TOKEN`. Keep the TCP backend host/port configured separately in
Deno Deploy. The backend must be reachable from Deploy; `localhost` will refer
to the Deploy instance, not your game server.

The path token is needed because Globed's current Qunet WebSocket transport
passes the URL path but does not set a custom Authorization header. The token
is included in the game's advertised URL, so it is **not secret from people
allowed to see that server address**; its main purpose is to make the endpoint
harder to discover. This service always connects to one fixed backend and does
not accept arbitrary client-supplied hosts or ports.

## How packet conversion works

Qunet WebSocket transport sends one Qunet message per binary WebSocket frame.
Qunet TCP transport uses a 4-byte little-endian message-length prefix on most
messages, with special handling for `HandshakeStart` (`0x05`) and
`ClientReconnect` (`0x0a`). The bridge:

- adds TCP length prefixes to ordinary incoming WebSocket Qunet messages;
- forwards `HandshakeStart` and `ClientReconnect` without a prefix;
- parses arbitrary TCP read chunks into complete frames and removes their
  prefixes before sending one binary WebSocket message per Qunet message;
- passes the Qunet message bytes themselves unchanged.

It caps messages at 16 MiB, connection attempts at 8 seconds, and active
connections at 50 per running instance.

## Endpoint and limitations

- WebSocket endpoint: `wss://YOUR-DEPLOY-HOST/ws/YOUR-TOKEN`
- Health endpoint: `https://YOUR-DEPLOY-HOST/healthz`
- Only binary Qunet messages are accepted.

This adapts transport framing; it does not decode or alter gameplay events.
The Globed client build must have Qunet WebSocket support enabled. Test with
your actual Globed version and server before relying on it in a live session.
