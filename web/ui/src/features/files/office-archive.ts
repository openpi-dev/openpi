import { unzipSync } from "fflate";

/** Bound declared ZIP expansion before either the preview or text parser allocates it. */
export function readOfficeArchive(
  data: ArrayBuffer,
  include: (path: string) => boolean,
) {
  let count = 0;
  let total = 0;
  return unzipSync(new Uint8Array(data), {
    filter: (entry) => {
      total += entry.originalSize;
      if (
        ++count > 2_000 ||
        total > 40 * 1024 * 1024 ||
        entry.originalSize > 10 * 1024 * 1024
      )
        throw new Error("Office document exceeds the expansion limit.");
      return include(entry.name);
    },
  });
}
