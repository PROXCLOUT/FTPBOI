export const INVALID_NAME_PATTERN = /[\/\\:*?"<>|]/;

export function getParentPath(value: string): string {
  const segments = value.split("/").filter(Boolean);
  const parent = `/${segments.slice(0, -1).join("/")}`;
  return parent || "/";
}

export function getBreadcrumbs(value: string): Array<{ label: string; path: string }> {
  const segments = value.split("/").filter(Boolean);
  const breadcrumbs: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
  let current = "";
  for (const segment of segments) {
    current += `/${segment}`;
    breadcrumbs.push({ label: segment, path: current });
  }
  return breadcrumbs;
}

export function validateEntryName(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Name darf nicht leer sein.";
  if (trimmed === "." || trimmed === "..") return "Name darf nicht . oder .. sein.";
  if (INVALID_NAME_PATTERN.test(trimmed)) return 'Ungültige Zeichen im Namen: / \\ : * ? " < > |';
  return null;
}
