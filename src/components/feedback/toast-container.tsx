import { useToastStore } from "@/store/toast-store";

export function ToastContainer() {
  const toasts = useToastStore((state) => state.toasts);
  const remove = useToastStore((state) => state.remove);

  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={[
            "pointer-events-auto rounded-md border px-3 py-2 text-xs shadow-xl backdrop-blur",
            toast.tone === "success" && "border-emerald-500/60 bg-emerald-950/70 text-emerald-100",
            toast.tone === "error" && "border-red-500/60 bg-red-950/70 text-red-100",
            toast.tone === "info" && "border-zinc-600 bg-zinc-900/80 text-zinc-100",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-semibold">{toast.title}</p>
              {toast.details ? <p className="mt-0.5 break-words opacity-90">{toast.details}</p> : null}
            </div>
            <button type="button" onClick={() => remove(toast.id)} className="text-[10px] opacity-70 hover:opacity-100">
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
