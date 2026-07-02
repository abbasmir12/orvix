export function progressBar(value: number, width = 18): string {
  const safeValue = Math.max(0, Math.min(100, value));
  const filled = Math.round((safeValue / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function statusSymbol(status: string): string {
  if (status === "completed" || status === "Approved") return "✓";
  if (status === "active" || status === "In progress" || status === "Changes requested") return "•";
  if (status === "blocked") return "!";
  return "○";
}
