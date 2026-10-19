import { useEffect, useState } from "react";
import { Check, ClipboardList, Heart, PackageMinus } from "lucide-react";
import {
  parseWholesalerFavorites,
  toggleWholesalerFavorite,
  wholesalerFavoriteKey,
} from "./wholesalerFavorites";
import type { FavoriteWholesaler } from "./wholesalerFavorites";
import { useToast } from "./Toast";

export function useWholesalerFavorites(
  pharmacyId: string | null,
  enabled: boolean,
) {
  const key = pharmacyId && enabled ? wholesalerFavoriteKey(pharmacyId) : null;
  const read = () => {
    try {
      return key ? parseWholesalerFavorites(localStorage.getItem(key)) : [];
    } catch {
      return [];
    }
  };
  const [items, setItems] = useState(read);
  const toast = useToast();
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setItems(read());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key]);
  const toggle = (item: FavoriteWholesaler) => {
    if (!key) {
      toast("로그인 정보를 확인한 뒤 다시 시도해 주세요.", { tone: "error" });
      return;
    }
    try {
      // Re-read before changing so another tab's favorites are preserved.
      const current = parseWholesalerFavorites(localStorage.getItem(key));
      const next = toggleWholesalerFavorite(current, item);
      localStorage.setItem(key, JSON.stringify(next));
      setItems(next);
      toast(
        `${item.name} ${next.some((row) => row.id === item.id) ? "찜했어요." : "찜을 해제했어요."}`,
        { tone: "success" },
      );
    } catch {
      toast("찜을 저장하지 못했어요. 다시 시도해 주세요.", { tone: "error" });
    }
  };
  return { items, toggle };
}

export function MobileWholesalerRow({
  wholesaler,
  selected,
  favorite,
  onChoose,
  onToggleFavorite,
}: {
  wholesaler: FavoriteWholesaler;
  selected: boolean;
  favorite: boolean;
  onChoose: (item: FavoriteWholesaler) => void;
  onToggleFavorite: (item: FavoriteWholesaler) => void;
}) {
  return (
    <div className={`mobile-wholesaler-choice ${selected ? "is-active" : ""}`}>
      <button
        type="button"
        className={`choice-row ${selected ? "is-active" : ""}`}
        aria-pressed={selected}
        aria-label={`${wholesaler.name} 선택`}
        onClick={() => onChoose(wholesaler)}
      >
        <span className="mobile-wholesaler-selection" aria-hidden="true">
          {selected && <Check size={14} strokeWidth={3} />}
        </span>
        <span>
          <strong>{wholesaler.name}</strong>
          <em>{wholesaler.meta}</em>
        </span>
      </button>
      <button
        type="button"
        className="mobile-wholesaler-heart"
        aria-label={`${wholesaler.name} ${favorite ? "찜 해제" : "찜하기"}`}
        aria-pressed={favorite}
        onClick={() => onToggleFavorite(wholesaler)}
      >
        <Heart
          size={22}
          fill={favorite ? "currentColor" : "none"}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

export function MobileWholesalerHome({
  favorites,
  pendingId,
  onChoose,
  onToggleFavorite,
  onOrders,
  onRecentStock,
}: {
  favorites: FavoriteWholesaler[];
  pendingId: string;
  onChoose: (item: FavoriteWholesaler) => void;
  onToggleFavorite: (item: FavoriteWholesaler) => void;
  onOrders?: () => void;
  onRecentStock?: () => void;
}) {
  // Keep rows in place for this visit so an accidental removal is reversible.
  // Leaving the home view unmounts this component and clears the snapshot.
  const [retainedFavorites, setRetainedFavorites] = useState(favorites);
  const retainedIds = new Set(retainedFavorites.map((item) => item.id));
  const favoriteIds = new Set(favorites.map((item) => item.id));
  const visibleFavorites = [
    ...retainedFavorites.map(
      (item) => favorites.find((current) => current.id === item.id) ?? item,
    ),
    ...favorites.filter((item) => !retainedIds.has(item.id)),
  ];
  return (
    <div className="mobile-wholesaler-home">
      {(onOrders || onRecentStock) && (
        <nav
          className="mobile-wholesaler-shortcuts"
          aria-label="모바일 업무 메뉴"
        >
          {onOrders && (
            <button
              type="button"
              className="mobile-order-entry"
              onClick={onOrders}
            >
              <ClipboardList size={22} aria-hidden="true" />
              <strong>주문관리</strong>
            </button>
          )}
          {onRecentStock && (
            <button
              type="button"
              className="mobile-order-entry mobile-recent-stock-entry"
              onClick={onRecentStock}
            >
              <PackageMinus size={22} aria-hidden="true" />
              <strong>최근 차감 재고</strong>
            </button>
          )}
        </nav>
      )}
      <section
        className="mobile-wholesaler-favorites"
        aria-labelledby="wholesaler-favorites-title"
      >
        <header>
          <h2 id="wholesaler-favorites-title">
            <Heart size={18} aria-hidden="true" />
            자주 찾는 도매상
          </h2>
          <span>{favorites.length}곳</span>
        </header>
        {visibleFavorites.length ? (
          visibleFavorites.map((item) => (
            <MobileWholesalerRow
              key={item.id}
              wholesaler={item}
              selected={pendingId === item.id}
              favorite={favoriteIds.has(item.id)}
              onChoose={onChoose}
              onToggleFavorite={(wholesaler) => {
                setRetainedFavorites(visibleFavorites);
                onToggleFavorite(wholesaler);
              }}
            />
          ))
        ) : (
          <div className="mobile-wholesaler-favorites-empty">
            <strong>찜한 도매상이 없어요</strong>
            <p>도매처를 검색한 뒤 하트를 눌러 추가해 보세요.</p>
          </div>
        )}
      </section>
    </div>
  );
}
