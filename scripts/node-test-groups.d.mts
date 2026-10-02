export function partitionNodeTestsByPlatform(
  files: string[],
  platform?: NodeJS.Platform,
): { parallel: string[]; serial: string[] };

export function selectNodeTestShard(files: string[], shard: string): string[];
