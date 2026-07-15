export function normalizeSessionOrder(
  value: unknown,
  activeIds: readonly string[]
): string[] {
  const active = [...new Set(activeIds)];
  const activeSet = new Set(active);
  const seen = new Set<string>();
  const stored = Array.isArray(value) ? value.slice(0, 512) : [];
  const ordered = stored.flatMap((candidate) => {
    if (
      typeof candidate !== 'string' ||
      !activeSet.has(candidate) ||
      seen.has(candidate)
    ) {
      return [];
    }
    seen.add(candidate);
    return [candidate];
  });
  return [...ordered, ...active.filter((id) => !seen.has(id))];
}

export function reorderSessionIds(
  currentOrder: unknown,
  activeIds: readonly string[],
  draggedIds: readonly string[],
  targetId?: string
): string[] {
  const ordered = normalizeSessionOrder(currentOrder, activeIds);
  const dragged = new Set(draggedIds);
  const moving = ordered.filter((id) => dragged.has(id));
  if (moving.length === 0 || (targetId && dragged.has(targetId))) {
    return ordered;
  }
  const remaining = ordered.filter((id) => !dragged.has(id));
  const insertion = targetId ? remaining.indexOf(targetId) : remaining.length;
  const index = insertion < 0 ? remaining.length : insertion;
  return [
    ...remaining.slice(0, index),
    ...moving,
    ...remaining.slice(index)
  ];
}
