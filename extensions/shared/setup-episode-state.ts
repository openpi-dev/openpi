/** Broadcast whenever the package-owned setup episode becomes usable or ends. */
export const OPENPI_SETUP_EPISODE_CHANNEL = "openpi:setup-episode";

export interface OpenPiSetupEpisodeState {
  /** True only while the owned setup writer is active for a delivered request. */
  readonly active: boolean;
}
