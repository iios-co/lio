// Pure logic helper for popup status banner display modes.

export interface RecoveryRequiredState {
  reason: string;
  applied: number;
  skipped: number;
  localNodeCount: number;
  localLinkCount: number;
  serverNodeCount: number;
  timestamp: number;
}

export function resolvePopupBannerMode({
  globalEnabled,
  gateClosed,
  recoveryRequired,
}: {
  globalEnabled: boolean;
  gateClosed: boolean;
  recoveryRequired?: RecoveryRequiredState | null;
}): "hidden" | "recovery" | "resume" {
  if (globalEnabled || gateClosed) return "hidden";
  if (recoveryRequired?.reason === "tombstone_rejection") return "recovery";
  return "resume";
}
