/**
 * @deprecated moved to ../shared/result-delivery.ts (shared kernel) — kept as
 * a re-export for internal imports and tests; new code imports from shared.
 */
export {
  createDeferredResultDelivery,
  createIdleResultBatcher,
  hasTerminalCapacity,
  resultDeliveryOptions,
  type IdleResultBatcherOptions,
} from "../../shared/result-delivery.ts";
