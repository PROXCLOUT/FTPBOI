import { create } from "zustand";
import { getSettings, resetSettings, type AppSettings, updateSettings } from "@/services/tauri-client";

interface SettingsState {
  settings: AppSettings | null;
  isLoading: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;
  reset: () => Promise<void>;
}

export const defaultSettings: AppSettings = {
  localStartPath: null,
  theme: "system",
  accentColor: "purple",
  editorMode: "system",
  customEditorPath: null,
  autoUploadOnSave: false,
  uploadPromptMode: "confirm",
  transferConcurrency: 4,
  conflictMode: "ask",
  timeoutSec: 20,
  keepAliveSec: 30,
  showHiddenFiles: false,
  allowPlainFtp: false,
  useMasterPassword: false,
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  isLoading: false,
  error: null,
  hydrate: async () => {
    set({ isLoading: true, error: null });
    try {
      const settings = await getSettings();
      set({ settings, isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Settings konnten nicht geladen werden";
      set({ error: message, isLoading: false, settings: defaultSettings });
    }
  },
  patchSettings: async (patch) => {
    const current = get().settings ?? defaultSettings;
    const next = { ...current, ...patch };
    const persisted = await updateSettings(next);
    set({ settings: persisted, error: null });
  },
  reset: async () => {
    const settings = await resetSettings();
    set({ settings, error: null });
  },
}));
