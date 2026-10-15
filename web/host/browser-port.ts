import type { Server } from "node:http";

// HTTP(S) ports blocked by Fetch, even when the TCP listener is healthy.
// https://fetch.spec.whatwg.org/#port-blocking
const blockedPorts = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53,
  69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117,
  119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514,
  515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989,
  990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export async function listenBrowserPort(
  server: Server,
  requestedPort: number,
  host: string,
) {
  if (requestedPort !== 0 && blockedPorts.has(requestedPort)) {
    throw new Error(`Web port ${requestedPort} is blocked by browsers; choose another port or 0 for automatic allocation.`);
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once("error", failed);
      try {
        server.listen(requestedPort, host, () => {
          server.removeListener("error", failed);
          resolve();
        });
      } catch (error) {
        server.removeListener("error", failed);
        reject(error);
      }
    });
    const address = server.address();
    if (address && typeof address !== "string" && !blockedPorts.has(address.port)) {
      return address.port;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    if (!address || typeof address === "string") {
      throw new Error("Web host did not expose a TCP port");
    }
  }
  throw new Error("Web host could not allocate a browser-compatible port after 8 attempts.");
}
