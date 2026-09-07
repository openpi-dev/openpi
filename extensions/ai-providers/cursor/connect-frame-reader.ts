/** Incremental Cursor Connect framing; callbacks consume complete frames synchronously. */
export class ConnectFrameReader {
  private readonly maxBytes: number;
  private readonly header = Buffer.alloc(5);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get incomplete() {
    return this.headerBytes !== 0;
  }

  get awaitingPayload() {
    return this.payload !== undefined;
  }

  push(chunk: Buffer, onFrame: (flags: number, data: Buffer) => void) {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload) {
        const copied = chunk.copy(
          this.payload,
          this.payloadBytes,
          offset,
          offset +
            Math.min(
              chunk.length - offset,
              this.payload.length - this.payloadBytes,
            ),
        );
        offset += copied;
        this.payloadBytes += copied;
      } else {
        if (this.headerBytes < 5) {
          const copied = chunk.copy(
            this.header,
            this.headerBytes,
            offset,
            offset + Math.min(5 - this.headerBytes, chunk.length - offset),
          );
          offset += copied;
          this.headerBytes += copied;
          if (this.headerBytes < 5) return;
        }
        const size = this.header.readUInt32BE(1);
        if (size > this.maxBytes)
          throw new Error(
            `Cursor Connect frame exceeds ${this.maxBytes} bytes`,
          );
        if (chunk.length - offset >= size) {
          const data = chunk.subarray(offset, offset + size);
          const flags = this.header[0]!;
          offset += size;
          this.headerBytes = 0;
          onFrame(flags, data);
          continue;
        }
        this.payload = Buffer.allocUnsafe(size);
        this.payloadBytes = 0;
        continue;
      }
      if (this.payloadBytes === this.payload.length) {
        const data = this.payload;
        const flags = this.header[0]!;
        this.payload = undefined;
        this.payloadBytes = 0;
        this.headerBytes = 0;
        onFrame(flags, data);
      }
    }
  }
}
