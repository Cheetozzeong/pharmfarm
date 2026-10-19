import { useEffect, useRef, useState } from "react";
import {
  parseWholesalerFavorites,
  toggleWholesalerFavorite,
  wholesalerFavoriteKey,
} from "./wholesalerFavorites";
import type { FavoriteWholesaler } from "./wholesalerFavorites";
import { useToast } from "./Toast";

export type WholesalerFavoritesApi = {
  load: (signal: AbortSignal) => Promise<FavoriteWholesaler[]>;
  save: (
    id: string,
    favorite: boolean,
    signal: AbortSignal,
  ) => Promise<FavoriteWholesaler[]>;
  import: (ids: string[], signal: AbortSignal) => Promise<FavoriteWholesaler[]>;
};

export function useWholesalerFavorites(
  scope: string | null,
  enabled: boolean,
  api?: WholesalerFavoritesApi,
  legacyPharmacyId?: string | null,
) {
  const key = scope && enabled ? wholesalerFavoriteKey(scope) : null;
  const read = (storageKey = key) => {
    try {
      return storageKey
        ? parseWholesalerFavorites(localStorage.getItem(storageKey))
        : [];
    } catch {
      return [];
    }
  };
  const [items, setItems] = useState<FavoriteWholesaler[]>(() =>
    api ? [] : read(),
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    api && enabled ? "loading" : "ready",
  );
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const pending = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const toast = useToast();

  useEffect(() => {
    const abort = new AbortController();
    controller.current = abort;
    if (!api || !enabled || !scope) {
      const sync = (event: StorageEvent) => {
        if (event.key === key || event.key === null) setItems(read());
      };
      window.addEventListener("storage", sync);
      return () => {
        abort.abort();
        window.removeEventListener("storage", sync);
      };
    }
    setStatus("loading");
    const load = async () => {
      let next = await api.load(abort.signal);
      const legacyKey = legacyPharmacyId
        ? wholesalerFavoriteKey(legacyPharmacyId)
        : null;
      const legacy = legacyKey ? read(legacyKey) : [];
      if (legacy.length) {
        // Merge existing device preferences once; never replace another device's favorites.
        for (let index = 0; index < legacy.length; index += 500) {
          next = await api.import(
            legacy.slice(index, index + 500).map((item) => item.id),
            abort.signal,
          );
        }
        if (!abort.signal.aborted && legacyKey) {
          try {
            localStorage.removeItem(legacyKey);
          } catch {
            /* Server copy is already safe. */
          }
        }
      }
      if (!abort.signal.aborted) {
        setItems(next);
        setStatus("ready");
      }
    };
    void load().catch(() => {
      if (!abort.signal.aborted) setStatus("error");
    });
    return () => abort.abort();
  }, [api, enabled, scope, key, legacyPharmacyId]);

  const toggle = async (item: FavoriteWholesaler) => {
    if (!key) {
      toast("로그인 정보를 확인한 뒤 다시 시도해 주세요.", { tone: "error" });
      return;
    }
    if (pending.current.size > 0 || status === "loading") return;
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    pending.current.add(item.id);
    setPendingIds(new Set(pending.current));
    try {
      const current = api ? items : read();
      const favorite = !current.some((row) => row.id === item.id);
      const next = api
        ? await api.save(item.id, favorite, signal)
        : toggleWholesalerFavorite(current, item);
      if (signal.aborted) return;
      if (!api) localStorage.setItem(key, JSON.stringify(next));
      setItems(next);
      setStatus("ready");
      toast(`${item.name} ${favorite ? "찜했어요." : "찜을 해제했어요."}`, {
        tone: "success",
      });
    } catch {
      if (!signal.aborted)
        toast("찜을 저장하지 못했어요. 다시 시도해 주세요.", { tone: "error" });
    } finally {
      pending.current.delete(item.id);
      if (!signal.aborted) setPendingIds(new Set(pending.current));
    }
  };
  return { items, status, pendingIds, toggle };
}
