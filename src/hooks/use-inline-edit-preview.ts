import { useMemo } from "react";
import type { FileEntry } from "@/services/contracts";
import type { InlineEditState } from "@/components/files/file-browser-types";

export function useInlineEditPreview(
  sourceEntries: FileEntry[],
  inlineEdit: InlineEditState | null,
): FileEntry | null {
  return useMemo(() => {
    if (!inlineEdit) return null;
    if (inlineEdit.kind === "rename" && inlineEdit.targetPath) {
      const target = sourceEntries.find((entry) => entry.path === inlineEdit.targetPath);
      if (target) return target;
    }
    const mode = inlineEdit.mode ?? "folder";
    const draft = inlineEdit.draftName.trim();
    return {
      id: `temp-new-${mode}`,
      name: draft || (mode === "folder" ? "Unbenannter Ordner" : "neue_datei.txt"),
      path: `temp-new-${mode}`,
      size: 0,
      is_dir: mode === "folder",
      modified_at: 0,
      extension: mode === "file" ? "txt" : "",
      permissions: "-",
    } as FileEntry;
  }, [inlineEdit, sourceEntries]);
}
