export const MAX_QUNET_FRAME_BYTES = 16 * 1024 * 1024;

const TCP_READ_CHUNK_BYTES = 16 * 1024;

/**
 * Adapt a Qunet WebSocket message to Qunet's TCP stream wire format.
 * The message payload is otherwise unchanged.
 */
export function frameWebSocketQunetMessage(
  message: Uint8Array,
  maxFrameBytes = MAX_QUNET_FRAME_BYTES,
): Uint8Array {
  if (message.byteLength === 0) {
    throw new TypeError("Empty Qunet WebSocket message");
  }
  if (message.byteLength > maxFrameBytes) {
    throw new RangeError("Qunet message is too large");
  }

  const type = message[0];

  // Qunet TCP omits the length prefix for these initial connection messages.
  if (type === 0x05 || type === 0x0a) {
    return message;
  }

  const framed = new Uint8Array(4 + message.byteLength);
  new DataView(framed.buffer).setUint32(0, message.byteLength, true);
  framed.set(message, 4);
  return framed;
}

/**
 * Turns Qunet TCP's length-prefixed byte stream into complete Qunet messages.
 * TCP read boundaries may split headers/messages or combine multiple messages.
 * Zero-length records are ignored by Qunet's stream transport and are skipped.
 */
export class QunetTcpFrameDecoder {
  private buffer = new Uint8Array(TCP_READ_CHUNK_BYTES);
  private used = 0;

  constructor(
    private readonly maxFrameBytes = MAX_QUNET_FRAME_BYTES,
  ) {}

  push(chunk: Uint8Array): Uint8Array[] {
    const maxPendingBytes = this.maxFrameBytes + 4 + TCP_READ_CHUNK_BYTES;
    const required = this.used + chunk.byteLength;

    if (required > maxPendingBytes) {
      throw new RangeError("Incomplete TCP frame exceeds the size limit");
    }

    if (required > this.buffer.byteLength) {
      let capacity = this.buffer.byteLength;
      while (capacity < required) {
        capacity = Math.min(maxPendingBytes, capacity * 2);
      }

      const grown = new Uint8Array(capacity);
      grown.set(this.buffer.subarray(0, this.used));
      this.buffer = grown;
    }

    this.buffer.set(chunk, this.used);
    this.used += chunk.byteLength;

    const frames: Uint8Array[] = [];
    let offset = 0;

    while (this.used - offset >= 4) {
      const frameLength = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset + offset,
        4,
      ).getUint32(0, true);

      if (frameLength === 0) {
        offset += 4;
        continue;
      }

      if (frameLength > this.maxFrameBytes) {
        throw new RangeError("TCP frame exceeds the size limit");
      }

      if (this.used - offset < 4 + frameLength) {
        break;
      }

      frames.push(this.buffer.slice(offset + 4, offset + 4 + frameLength));
      offset += 4 + frameLength;
    }

    if (offset > 0) {
      this.buffer.copyWithin(0, offset, this.used);
      this.used -= offset;
    }

    if (this.used > this.maxFrameBytes + 4) {
      throw new RangeError("Incomplete TCP frame exceeds the size limit");
    }

    return frames;
  }
}
