// Pure logic helper for popup status banner display modes.

export interface RecoveryRequiredState {
  reason: string;
  timestamp: number;
  applied?: number;
  skipped?: number;
  localNodeCount?: number;
  localLinkCount?: number;
  serverNodeCount?: number;
  detail?: string;
}

export function resolvePopupBannerMode({
  globalEnabled,
  gateClosed,
  recoveryRequired,
}: {
  globalEnabled: boolean;
  gateClosed: boolean;
  recoveryRequired?: RecoveryRequiredState | null;
}): "hidden" | "recovery" | "bootstrap" | "resume" {
  if (globalEnabled || gateClosed) return "hidden";
  if (recoveryRequired?.reason === "tombstone_rejection") return "recovery";
  if (recoveryRequired?.reason === "bootstrap_needed" || recoveryRequired?.reason === "empty_server_tree" || recoveryRequired?.reason === "unstable_server_tree") return "bootstrap";
  return "resume";
}
