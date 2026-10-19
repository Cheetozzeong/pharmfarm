import { useState } from "react";
import { Check, ClipboardList, Heart, PackageMinus } from "lucide-react";
import type { FavoriteWholesaler } from "./wholesalerFavorites";

export function MobileWholesalerRow({
  wholesaler,
  selected,
  favorite,
  favoriteDisabled = false,
  onChoose,
  onToggleFavorite,
}: {
  wholesaler: FavoriteWholesaler;
  selected: boolean;
  favorite: boolean;
  favoriteDisabled?: boolean;
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
        disabled={favoriteDisabled}
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
  status,
  pendingIds,
  pendingId,
  onChoose,
  onToggleFavorite,
  onOrders,
  onRecentStock,
}: {
  favorites: FavoriteWholesaler[];
  status: "loading" | "ready" | "error";
  pendingIds: Set<string>;
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
        {status === "loading" ? (
          <p className="mobile-wholesaler-favorites-empty" role="status">
            찜한 도매상을 불러오고 있어요.
          </p>
        ) : visibleFavorites.length ? (
          visibleFavorites.map((item) => (
            <MobileWholesalerRow
              key={item.id}
              wholesaler={item}
              selected={pendingId === item.id}
              favorite={favoriteIds.has(item.id)}
              favoriteDisabled={pendingIds.size > 0}
              onChoose={onChoose}
              onToggleFavorite={(wholesaler) => {
                setRetainedFavorites(visibleFavorites);
                onToggleFavorite(wholesaler);
              }}
            />
          ))
        ) : (
          <div className="mobile-wholesaler-favorites-empty">
            <span className="mobile-wholesaler-empty-icon" aria-hidden="true">
              <Heart size={28} strokeWidth={1.8} />
            </span>
            <strong>도매처를 검색해 보세요</strong>
            <p>
              검색 결과에서 하트를 누르면
              <br />
              자주 찾는 도매상으로 모아볼 수 있어요.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
