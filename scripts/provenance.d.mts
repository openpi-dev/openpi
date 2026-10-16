export const OPENPI_PACKAGE_NAME: "@tt-a1i/openpi";

export function normalizePath(value: string, base?: string): string;

export function collectReportedPaths(
  stdout?: string,
  stderr?: string,
): string[];

export function evaluateOpenPiProvenance(
  reportedPaths: readonly string[],
  checkoutPath?: string,
  options?: {
    normalize?: (value: string) => string;
    packageName?: string;
    readPackageName?: (directory: string) => string | undefined;
  },
): {
  checkoutPath: string;
  openPiSources: string[];
  matches: boolean;
};
