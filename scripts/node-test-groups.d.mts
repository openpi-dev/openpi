export function partitionNodeTestsByPlatform(
  files: string[],
  platform?: NodeJS.Platform,
): { parallel: string[]; serial: string[] };
