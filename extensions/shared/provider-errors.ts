/** Match the gateway's exact error code, including our native-retry prefix. */
export function isGatewayConcurrencyLimit(error: string | undefined) {
  return /(?:^|:\s*)gateway_concurrency_limit(?=[:\s]|$)/u.test(error ?? "");
}
