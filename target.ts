export type TcpTarget = { hostname: string; port: number };

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

function isAllowedHost(hostname: string, allowedHosts: ReadonlySet<string>): boolean {
  for (const rule of allowedHosts) {
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

/**
 * Parses the original game-server URL sent by the patched client, then checks
 * it against fixed host and port allowlists before the bridge opens a TCP socket.
 */
export function parseAllowedTarget(
  targetHex: string | null,
  allowedHosts: ReadonlySet<string>,
  allowedPorts: ReadonlySet<number>,
): TcpTarget {
  if (!targetHex) throw new TypeError("Missing target_hex");

  const original = decodeHex(targetHex);
  let target: URL;

  try {
    // Globed normally advertises addresses such as udp://host:4349.
    // Bare host:port addresses are supported too.
    target = new URL(original.includes("://") ? original : `tcp://${original}`);
  } catch {
    throw new TypeError("Invalid game-server address");
  }

  if (!["udp:", "tcp:", "quic:", "qunet:"].includes(target.protocol)) {
    throw new TypeError("Unsupported game-server URL protocol");
  }

  // URL.pathname is "" for non-special schemes like udp:// and qunet://.
  if (target.username || target.password ||
      (target.pathname !== "" && target.pathname !== "/") ||
      target.search || target.hash || !target.port) {
    throw new TypeError("Expected a simple host:port game-server address");
  }

  const hostname = target.hostname.toLowerCase().replace(/.$/, "");
  const port = Number(target.port);

  if (!isAllowedHost(hostname, allowedHosts)) {
    throw new TypeError("Game-server host is not allowlisted");
  }
  if (!allowedPorts.has(port)) {
    throw new TypeError("Game-server TCP port is not allowlisted");
  }

  return { hostname, port };
}
