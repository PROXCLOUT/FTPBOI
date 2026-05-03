import type { FileEntry } from "@/services/contracts";

export type CreateMode = "folder" | "file";

export type InlineEditState = {
  kind: "create" | "rename";
  mode?: CreateMode;
  targetPath?: string;
  targetIsDir?: boolean;
  draftName: string;
  status: "editing" | "saving";
  shakeKey: number;
};

export interface FileContextMenuState {
  x: number;
  y: number;
  file: FileEntry | null;
}
