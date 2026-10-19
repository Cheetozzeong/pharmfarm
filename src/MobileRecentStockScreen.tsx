import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, CalendarDays, ChevronRight, RefreshCw } from "lucide-react";
import {
  MobileDetailDialog,
  RecordState,
  useOrderRecords,
} from "./MobileRecordUI";
import { orderDateLabel } from "./mobileOrderDates";
import type { OrderDateRange } from "./mobileOrderDates";
import { recentStockDays, recentStockRange } from "./mobileRecentStock";
import type { RecentStockRecord } from "./mobileRecentStock";

const quantity = (value: number) => value.toLocaleString("ko-KR");
const normalize = (value: string) => value.replace(/\s/g, "").toLowerCase();

export function MobileRecentStockScreen({
  loadRecords,
  onBack,
  onLoginRequired,
}: {
  loadRecords: (
    range: OrderDateRange,
    signal: AbortSignal,
  ) => Promise<RecentStockRecord[]>;
  onBack: () => void;
  onLoginRequired: () => void;
}) {
  const [range, setRange] = useState(recentStockRange);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RecentStockRecord | null>(null);
  const loader = useCallback(
    (signal: AbortSignal) => loadRecords(range, signal),
    [loadRecords, range],
  );
  const result = useOrderRecords(loader, true, revision);
  const visible = useMemo(
    () =>
      result.records.filter((record) =>
        normalize(`${record.drugName} ${record.insuranceCode}`).includes(
          normalize(query),
        ),
      ),
    [result.records, query],
  );
  const days = recentStockDays(range);
  const refresh = () => {
    setRange(recentStockRange());
    setRevision((value) => value + 1);
  };
  const dateLabel = (day: string, index: number) =>
    `${day.slice(5).replace("-", ".")}${index === 0 ? " 오늘" : ""}`;
  return (
    <div className="mobile-order-page mobile-recent-stock-page">
      <header className="mobile-order-header">
        <button
          type="button"
          aria-label="이전 화면으로 돌아가기"
          onClick={onBack}
        >
          <ArrowLeft size={22} aria-hidden="true" />
        </button>
        <h1>최근 차감 재고</h1>
        <button
          type="button"
          aria-label="최근 차감 재고 새로고침"
          disabled={result.status === "loading"}
          onClick={refresh}
        >
          <RefreshCw size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="mobile-order-controls">
        <div className="mobile-recent-stock-period">
          <CalendarDays size={20} aria-hidden="true" />
          <span>
            <strong>최근 3일</strong>
            <time>{orderDateLabel(range)}</time>
          </span>
        </div>
        <p>최근 처방 약품의 차감 수량과 현재 남은 재고입니다.</p>
        <label className="search-field">
          <span className="search-icon" />
          <input
            aria-label="최근 차감 재고 검색"
            placeholder="약품명 · 보험코드 검색"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      <div
        className="mobile-order-list"
        aria-busy={result.status === "loading"}
      >
        <RecordState
          {...result}
          empty={
            visible.length
              ? null
              : query
                ? "검색 결과가 없습니다"
                : "최근 3일간 처방 내역이 없습니다"
          }
          onRetry={refresh}
          onLoginRequired={onLoginRequired}
        >
          <p
            className="mobile-order-count mobile-recent-stock-count"
            role="status"
          >
            <span>약품 {visible.length}개</span>
            <span>남은 재고 적은 순</span>
          </p>
          {visible.map((record) => (
            <button
              type="button"
              className="mobile-order-item mobile-recent-stock-row"
              key={record.id}
              aria-haspopup="dialog"
              onClick={() => setSelected(record)}
            >
              <span className="mobile-recent-stock-row-top">
                <span className="mobile-order-item-copy">
                  <strong>{record.drugName}</strong>
                  <span>{record.insuranceCode || "보험코드 없음"}</span>
                </span>
                <span
                  className={`mobile-recent-stock-remaining ${record.remainingQuantity !== null && record.remainingQuantity <= 0 ? "is-empty" : ""}`}
                >
                  <span>남은 재고</span>
                  <b>
                    {record.remainingQuantity === null
                      ? "확인 필요"
                      : `${quantity(record.remainingQuantity)}개`}
                  </b>
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </span>
              <span className="mobile-recent-stock-daily">
                {days.map((day, index) => (
                  <span key={day}>
                    <span>{dateLabel(day, index)}</span>
                    <b>{quantity(record.dailyQuantities[day] ?? 0)}개 차감</b>
                  </span>
                ))}
              </span>
              <span className="mobile-recent-stock-total">
                3일 합계 <b>{quantity(record.deductedQuantity)}개 차감</b>
              </span>
            </button>
          ))}
        </RecordState>
      </div>
      <footer className="mobile-order-footer">
        <button className="primary-btn" type="button" onClick={onBack}>
          이전 화면으로 돌아가기
        </button>
      </footer>
      {selected && (
        <MobileDetailDialog
          title="최근 차감 재고 상세"
          onClose={() => setSelected(null)}
        >
          <div className="mobile-order-prescription-overview">
            <strong>{selected.drugName}</strong>
            <span>{selected.insuranceCode || "보험코드 없음"}</span>
          </div>
          <dl className="mobile-order-detail">
            <div>
              <dt>조회 기간</dt>
              <dd>{orderDateLabel(range)}</dd>
            </div>
            <div>
              <dt>남은 재고</dt>
              <dd>
                {selected.remainingQuantity === null
                  ? "재고 확인 필요"
                  : `${quantity(selected.remainingQuantity)}개`}
              </dd>
            </div>
            <div>
              <dt>3일 차감</dt>
              <dd>{quantity(selected.deductedQuantity)}개</dd>
            </div>
            {days.map((day, index) => (
              <div key={day}>
                <dt>{dateLabel(day, index)}</dt>
                <dd>{quantity(selected.dailyQuantities[day] ?? 0)}개 차감</dd>
              </div>
            ))}
          </dl>
          <p className="mobile-recent-stock-note">
            남은 재고는 조회 시점 기준입니다. 처방이 없거나 실제 차감되지 않은
            수량은 합계에 포함하지 않습니다.
          </p>
        </MobileDetailDialog>
      )}
    </div>
  );
}
