export type FavoriteWholesaler = { id: string; name: string; meta: string };

export function wholesalerFavoriteKey(pharmacyId: string): string {
  return `pharmfarm.wholesalerFavorites.v1:${encodeURIComponent(pharmacyId)}`;
}

export function parseWholesalerFavorites(
  value: string | null,
): FavoriteWholesaler[] {
  if (!value) return [];
  try {
    const items: unknown = JSON.parse(value);
    if (!Array.isArray(items)) return [];
    const seen = new Set<string>();
    return items.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (
        typeof row.id !== "string" ||
        !row.id.trim() ||
        typeof row.name !== "string" ||
        !row.name.trim() ||
        seen.has(row.id)
      )
        return [];
      seen.add(row.id);
      return [
        {
          id: row.id,
          name: row.name,
          meta: typeof row.meta === "string" ? row.meta : "",
        },
      ];
    });
  } catch {
    return [];
  }
}

export function toggleWholesalerFavorite(
  current: FavoriteWholesaler[],
  item: FavoriteWholesaler,
): FavoriteWholesaler[] {
  return current.some((row) => row.id === item.id)
    ? current.filter((row) => row.id !== item.id)
    : [...current, { id: item.id, name: item.name, meta: item.meta }];
}
