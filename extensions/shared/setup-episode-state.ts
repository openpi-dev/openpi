/** Broadcast whenever the package-owned setup episode becomes usable or ends. */
export const OPENPI_SETUP_EPISODE_CHANNEL = "openpi:setup-episode";

export interface OpenPiSetupEpisodeState {
  /** True for both armed and actively running setup episodes. */
  readonly active: boolean;
}
