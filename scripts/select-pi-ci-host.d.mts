export const PI_FAMILY: string[];
export function supportFloor(manifest: { peerDependencies: Record<string, string> }): string;
export function assertStableAtLeast(version: string, floor: string): void;
export function verifyInstalledHost(root: string, version: string, listing: string): void;
export function selectPiHost(options?: {
  root?: string;
  endpoint?: string;
  run?: (command: string, args: string[], options: object) => string;
}): string;
