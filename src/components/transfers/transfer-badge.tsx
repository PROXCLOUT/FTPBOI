interface TransferBadgeProps {
  totalProgress: number;
  activeCount: number;
  onClick: () => void;
}

export function TransferBadge({ totalProgress, activeCount, onClick }: TransferBadgeProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="fixed bottom-12 right-4 z-30 rounded-full border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-xs text-zinc-100 shadow-lg backdrop-blur-md"
    >
      {activeCount > 0 ? `${activeCount} Transfers • ${totalProgress}%` : "Transfers"}
    </button>
  );
}
