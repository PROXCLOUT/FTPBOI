import { create } from "zustand";
import type { SecurityEvent } from "@/services/tauri-client";

interface SecurityState {
  pendingEvent: SecurityEvent | null;
  mitmEvent: SecurityEvent | null;
  plainFtpPending: boolean;
  setSecurityEvent: (event: SecurityEvent) => void;
  clearSecurityEvent: () => void;
  openPlainFtpWarning: () => void;
  closePlainFtpWarning: () => void;
}

export const useSecurityStore = create<SecurityState>((set) => ({
  pendingEvent: null,
  mitmEvent: null,
  plainFtpPending: false,
  setSecurityEvent: (event) =>
    set({
      pendingEvent: event.kind === "fingerprint_changed" ? null : event,
      mitmEvent: event.kind === "fingerprint_changed" ? event : null,
    }),
  clearSecurityEvent: () => set({ pendingEvent: null, mitmEvent: null }),
  openPlainFtpWarning: () => set({ plainFtpPending: true }),
  closePlainFtpWarning: () => set({ plainFtpPending: false }),
}));
