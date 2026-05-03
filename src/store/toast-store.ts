import { create } from "zustand";

export type ToastTone = "success" | "error" | "info";

export interface ToastMessage {
  id: string;
  tone: ToastTone;
  title: string;
  details?: string;
}

interface ToastState {
  toasts: ToastMessage[];
  push: (tone: ToastTone, title: string, details?: string, timeoutMs?: number) => void;
  remove: (id: string) => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (tone, title, details, timeoutMs = 4000) => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    set((state) => ({ toasts: [...state.toasts, { id, tone, title, details }].slice(-5) }));
    window.setTimeout(() => {
      get().remove(id);
    }, timeoutMs);
  },
  remove: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));
