/**
 * @deprecated moved to ../shared/result-delivery.ts (shared kernel) — kept as
 * a re-export for internal imports; new code imports from shared directly.
 */
export {
  createDeferredResultDelivery,
  createIdleResultBatcher,
  hasTerminalCapacity,
  resultDeliveryOptions,
  type IdleResultBatcherOptions,
} from "../../shared/result-delivery.ts";
