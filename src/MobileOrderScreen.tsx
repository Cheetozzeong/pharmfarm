import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  CalendarDays,
  ChevronRight,
  RefreshCw,
  X,
} from "lucide-react";
import {
  MobileDetailDialog,
  RecordState,
  useOrderRecords,
} from "./MobileRecordUI";
import { orderDateLabel, orderDateRange } from "./mobileOrderDates";
import type { OrderDatePreset, OrderDateRange } from "./mobileOrderDates";

type ShortageRecord = {
  id: string;
  drugName: string;
  insuranceCode: string;
  prescriptionCode: string;
  totalQuantity: number;
  deductedQuantity: number;
  shortageQuantity: number;
  shortageStatus?: string;
  createdAt: string;
  reason: string;
  arrivalReconciliationAvailable?: boolean;
};
type PrescriptionRecord = {
  id: string;
  prescriptionCode: string;
  primaryDrugName: string;
  primaryInsuranceCode: string;
  capturedAt: string;
  drugCount: number;
  totalQuantity: number;
  deductedQuantity: number;
  shortageQuantity: number;
  status: string;
  statusLabel: string;
  drugs: Array<{
    lineNo: number;
    drugName: string;
    insuranceCode: string;
    totalQuantity: number;
    deductedQuantity: number;
    shortageQuantity: number;
    quantityPerDose: number;
    dailyFrequency: number;
    medicationDays: number;
  }>;
};
type Tab = "prescriptions" | "shortages";
const filters = [
  ["OPEN", "주문 필요"],
  ["ORDERED", "주문 완료"],
  ["HOLD", "보류"],
  ["SUBSTITUTED", "대체 처리"],
] as const;
type Filter = (typeof filters)[number][0];

function recordStatus(record: ShortageRecord): Filter {
  if (
    record.shortageStatus === "ORDERED" ||
    record.shortageStatus === "SUBSTITUTED"
  )
    return record.shortageStatus;
  if (["HOLD", "RESOLVED", "IGNORED"].includes(record.shortageStatus ?? ""))
    return "HOLD";
  return "OPEN";
}
const searchText = (value: string) => value.replace(/\s/g, "").toLowerCase();
const quantity = (value: number) => value.toLocaleString("ko-KR");

function DateRangeDialog({
  range,
  onApply,
  onClose,
}: {
  range: OrderDateRange;
  onApply: (range: OrderDateRange) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(range);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  const presets: Array<[OrderDatePreset, string]> = [
    ["today", "오늘"],
    ["week", "최근 7일"],
    ["month", "이번 달"],
  ];
  return (
    <dialog
      ref={dialogRef}
      className="mobile-order-date-dialog"
      aria-labelledby="order-date-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          const nextRange = {
            startDate: String(values.get("startDate") ?? ""),
            endDate: String(values.get("endDate") ?? ""),
          };
          if (
            !nextRange.startDate ||
            !nextRange.endDate ||
            nextRange.startDate > nextRange.endDate
          ) {
            setError("시작일과 종료일을 올바른 순서로 선택해 주세요.");
            return;
          }
          onApply(nextRange);
        }}
      >
        <header>
          <h2 id="order-date-title">처방 내역 조회 기간</h2>
          <button type="button" aria-label="기간 설정 닫기" onClick={onClose}>
            <X size={20} aria-hidden="true" />
          </button>
        </header>
        <p>조회할 기간을 간단히 선택하세요.</p>
        <div
          className="mobile-order-date-presets"
          role="group"
          aria-label="빠른 기간 선택"
        >
          {presets.map(([value, label]) => {
            const preset = orderDateRange(value);
            return (
              <button
                type="button"
                key={value}
                aria-pressed={
                  preset.startDate === draft.startDate &&
                  preset.endDate === draft.endDate
                }
                onClick={() => {
                  setDraft(preset);
                  setError("");
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <label>
          시작일
          <input
            type="date"
            name="startDate"
            required
            value={draft.startDate}
            max={draft.endDate || undefined}
            onChange={(event) => {
              const value = event.target.value;
              setDraft((current) => ({
                ...current,
                startDate: value,
              }));
              setError("");
            }}
          />
        </label>
        <label>
          종료일
          <input
            type="date"
            name="endDate"
            required
            value={draft.endDate}
            min={draft.startDate || undefined}
            onChange={(event) => {
              const value = event.target.value;
              setDraft((current) => ({
                ...current,
                endDate: value,
              }));
              setError("");
            }}
          />
        </label>
        {error && (
          <p className="mobile-order-date-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="secondary-btn" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary-btn">
            이 기간으로 조회
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function PrescriptionDetailDialog({
  record,
  onClose,
}: {
  record: PrescriptionRecord;
  onClose: () => void;
}) {
  return (
    <MobileDetailDialog title="처방 내역 상세" onClose={onClose}>
      <div className="mobile-order-prescription-overview">
        <time>{record.capturedAt}</time>
        <strong>{record.primaryDrugName}</strong>
        <span
          className={`mobile-order-status ${["FAILED", "SHORTAGE", "PARTIAL_DEDUCTED"].includes(record.status) ? "is-warning" : ""}`}
        >
          {record.statusLabel}
        </span>
      </div>
      <dl className="mobile-order-detail">
        <div>
          <dt>처방전</dt>
          <dd>{record.prescriptionCode}</dd>
        </div>
        <div>
          <dt>처방 수량</dt>
          <dd>{quantity(record.totalQuantity)}개</dd>
        </div>
        <div>
          <dt>차감 수량</dt>
          <dd>{quantity(record.deductedQuantity)}개</dd>
        </div>
        <div>
          <dt>부족 수량</dt>
          <dd>{quantity(record.shortageQuantity)}개</dd>
        </div>
      </dl>
      <div className="mobile-order-drugs" aria-label="처방 약품">
        {record.drugs.length === 0 ? (
          <p>품목별 상세 정보가 제공되지 않았습니다.</p>
        ) : (
          record.drugs.map((drug, index) => (
            <div key={`${drug.lineNo}-${index}`}>
              <strong>{drug.drugName}</strong>
              <span>{drug.insuranceCode}</span>
              {drug.quantityPerDose > 0 &&
                drug.dailyFrequency > 0 &&
                drug.medicationDays > 0 && (
                  <span>
                    1회 {quantity(drug.quantityPerDose)}개 · 하루{" "}
                    {drug.dailyFrequency}회 · {drug.medicationDays}일
                  </span>
                )}
              <b>
                처방 {quantity(drug.totalQuantity)}개 · 차감{" "}
                {quantity(drug.deductedQuantity)}개
                {drug.shortageQuantity > 0 && (
                  <em> · 부족 {quantity(drug.shortageQuantity)}개</em>
                )}
              </b>
            </div>
          ))
        )}
      </div>
    </MobileDetailDialog>
  );
}

function ShortageDetailDialog({
  record,
  onClose,
}: {
  record: ShortageRecord;
  onClose: () => void;
}) {
  return (
    <MobileDetailDialog title="초과 처방 상세" onClose={onClose}>
      <div className="mobile-order-prescription-overview">
        <time>{record.createdAt}</time>
        <strong>{record.drugName}</strong>
        <span>{record.insuranceCode || "보험코드 없음"}</span>
      </div>
      {record.arrivalReconciliationAvailable && (
        <p className="mobile-order-arrival">입고 재고 확인 필요</p>
      )}
      <dl className="mobile-order-detail">
        <div>
          <dt>처방전</dt>
          <dd>{record.prescriptionCode}</dd>
        </div>
        <div>
          <dt>처방 수량</dt>
          <dd>{quantity(record.totalQuantity)}개</dd>
        </div>
        <div>
          <dt>차감 수량</dt>
          <dd>{quantity(record.deductedQuantity)}개</dd>
        </div>
        <div>
          <dt>부족 수량</dt>
          <dd>{quantity(record.shortageQuantity)}개</dd>
        </div>
        <div>
          <dt>상태</dt>
          <dd>
            {filters.find(([value]) => value === recordStatus(record))![1]}
          </dd>
        </div>
        {record.reason && (
          <div>
            <dt>사유</dt>
            <dd>{record.reason}</dd>
          </div>
        )}
      </dl>
    </MobileDetailDialog>
  );
}

export function MobileOrderScreen({
  loadShortages,
  loadPrescriptions,
  onBack,
  onLoginRequired,
}: {
  loadShortages: (signal: AbortSignal) => Promise<ShortageRecord[]>;
  loadPrescriptions: (
    range: OrderDateRange,
    signal: AbortSignal,
  ) => Promise<PrescriptionRecord[]>;
  onBack: () => void;
  onLoginRequired: () => void;
}) {
  const [tab, setTab] = useState<Tab>("prescriptions");
  const [range, setRange] = useState(() => orderDateRange("today"));
  const [dateOpen, setDateOpen] = useState(false);
  const [selectedShortage, setSelectedShortage] =
    useState<ShortageRecord | null>(null);
  const [selectedPrescription, setSelectedPrescription] =
    useState<PrescriptionRecord | null>(null);
  const [prescriptionQuery, setPrescriptionQuery] = useState("");
  const [shortageQuery, setShortageQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [revisions, setRevisions] = useState({
    prescriptions: 0,
    shortages: 0,
  });
  const prescriptionLoader = useCallback(
    (signal: AbortSignal) => loadPrescriptions(range, signal),
    [loadPrescriptions, range],
  );
  const prescriptions = useOrderRecords(
    prescriptionLoader,
    tab === "prescriptions",
    revisions.prescriptions,
  );
  const shortages = useOrderRecords(
    loadShortages,
    tab === "shortages",
    revisions.shortages,
  );
  const active = tab === "prescriptions" ? prescriptions : shortages;
  const refresh = () =>
    setRevisions((current) => ({ ...current, [tab]: current[tab] + 1 }));
  const visiblePrescriptions = useMemo(
    () =>
      prescriptions.records.filter((record) =>
        searchText(
          [
            record.primaryDrugName,
            record.primaryInsuranceCode,
            record.prescriptionCode,
            ...record.drugs.map(
              (drug) => `${drug.drugName} ${drug.insuranceCode}`,
            ),
          ].join(" "),
        ).includes(searchText(prescriptionQuery)),
      ),
    [prescriptions.records, prescriptionQuery],
  );
  const matchingShortages = useMemo(
    () =>
      shortages.records.filter((record) =>
        searchText(
          `${record.drugName} ${record.insuranceCode} ${record.prescriptionCode}`,
        ).includes(searchText(shortageQuery)),
      ),
    [shortages.records, shortageQuery],
  );
  const visibleShortages = matchingShortages.filter(
    (record) => recordStatus(record) === filter,
  );
  const filterLabel = filters.find(([value]) => value === filter)![1];

  return (
    <div className="mobile-order-page">
      <header className="mobile-order-header">
        <button
          type="button"
          aria-label="이전 화면으로 돌아가기"
          onClick={onBack}
        >
          <ArrowLeft size={22} aria-hidden="true" />
        </button>
        <h1>주문관리</h1>
        <button
          type="button"
          aria-label="주문관리 새로고침"
          disabled={active.status === "loading"}
          onClick={refresh}
        >
          <RefreshCw size={20} aria-hidden="true" />
        </button>
      </header>
      <div
        className="mobile-order-tabs"
        role="tablist"
        aria-label="주문관리 내역"
      >
        {(
          [
            ["prescriptions", "처방 내역"],
            ["shortages", "초과 처방"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            role="tab"
            id={`order-tab-${value}`}
            key={value}
            aria-selected={tab === value}
            aria-controls={`order-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "prescriptions"
                  : event.key === "End"
                    ? "shortages"
                    : value === "prescriptions"
                      ? "shortages"
                      : "prescriptions";
              setTab(next);
              document.getElementById(`order-tab-${next}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <section
        className="mobile-order-panel"
        id="order-panel-prescriptions"
        role="tabpanel"
        aria-labelledby="order-tab-prescriptions"
        hidden={tab !== "prescriptions"}
      >
        <div className="mobile-order-controls">
          <button
            className="mobile-order-date-trigger"
            type="button"
            aria-haspopup="dialog"
            onClick={() => setDateOpen(true)}
          >
            <CalendarDays size={18} aria-hidden="true" />
            <span>
              <em>조회 기간</em>
              <strong>{orderDateLabel(range)}</strong>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <label className="search-field">
            <span className="search-icon" />
            <input
              aria-label="처방 내역 검색"
              placeholder="약품명 · 보험코드 · 처방전 검색"
              value={prescriptionQuery}
              onChange={(event) => setPrescriptionQuery(event.target.value)}
            />
          </label>
        </div>
        <div
          className="mobile-order-list"
          aria-busy={prescriptions.status === "loading"}
        >
          <RecordState
            {...prescriptions}
            empty={
              visiblePrescriptions.length
                ? null
                : prescriptionQuery
                  ? "검색 결과가 없습니다"
                  : "선택한 기간의 처방 내역이 없습니다"
            }
            onRetry={refresh}
            onLoginRequired={onLoginRequired}
          >
            <p className="mobile-order-count" role="status">
              처방전 {visiblePrescriptions.length}건 ·{" "}
              {visiblePrescriptions.reduce(
                (sum, record) => sum + record.drugCount,
                0,
              )}
              개 품목
            </p>
            {visiblePrescriptions.map((record) => (
              <button
                type="button"
                className="mobile-order-item mobile-order-record-row mobile-order-prescription-row"
                key={record.id}
                aria-haspopup="dialog"
                onClick={() => setSelectedPrescription(record)}
              >
                <span className="mobile-order-item-copy">
                  <time>{record.capturedAt}</time>
                  <strong>{record.primaryDrugName}</strong>
                  <span>
                    {record.primaryInsuranceCode} · {record.drugCount}개 품목
                  </span>
                </span>
                <span
                  className={`mobile-order-status ${["FAILED", "SHORTAGE", "PARTIAL_DEDUCTED"].includes(record.status) ? "is-warning" : ""}`}
                >
                  {record.statusLabel}
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            ))}
          </RecordState>
        </div>
      </section>

      <section
        className="mobile-order-panel"
        id="order-panel-shortages"
        role="tabpanel"
        aria-labelledby="order-tab-shortages"
        hidden={tab !== "shortages"}
      >
        <div className="mobile-order-controls">
          <p>현재 초과 처방의 부족 수량과 주문 상태를 확인하세요.</p>
          <label className="search-field">
            <span className="search-icon" />
            <input
              aria-label="초과 처방 검색"
              placeholder="약품명 · 보험코드 · 처방전 검색"
              value={shortageQuery}
              onChange={(event) => setShortageQuery(event.target.value)}
            />
          </label>
          <div
            className="mobile-order-filters"
            role="group"
            aria-label="초과 처방 상태"
          >
            {filters.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
                <b>
                  {shortages.status === "done"
                    ? matchingShortages.filter(
                        (record) => recordStatus(record) === value,
                      ).length
                    : "—"}
                </b>
              </button>
            ))}
          </div>
        </div>
        <div
          className="mobile-order-list"
          aria-busy={shortages.status === "loading"}
        >
          <RecordState
            {...shortages}
            empty={
              visibleShortages.length
                ? null
                : shortageQuery
                  ? "검색 결과가 없습니다"
                  : `${filterLabel} 내역이 없습니다`
            }
            onRetry={refresh}
            onLoginRequired={onLoginRequired}
          >
            <p className="mobile-order-count" role="status">
              {filterLabel} {visibleShortages.length}건 · 부족{" "}
              {quantity(
                visibleShortages.reduce(
                  (sum, record) => sum + record.shortageQuantity,
                  0,
                ),
              )}
              개
            </p>
            {visibleShortages.map((record) => (
              <button
                type="button"
                className="mobile-order-item mobile-order-record-row mobile-order-shortage-row"
                key={record.id}
                aria-haspopup="dialog"
                onClick={() => setSelectedShortage(record)}
              >
                <span className="mobile-order-item-copy">
                  <strong>{record.drugName}</strong>
                  <span>{record.insuranceCode || "보험코드 없음"}</span>
                  <time>{record.createdAt}</time>
                </span>
                <span className="mobile-order-quantity">
                  <b>{quantity(record.shortageQuantity)}개</b>
                  <span>부족</span>
                </span>
                <ChevronRight size={18} aria-hidden="true" />
              </button>
            ))}
          </RecordState>
        </div>
      </section>
      <footer className="mobile-order-footer">
        <button className="primary-btn" type="button" onClick={onBack}>
          이전 화면으로 돌아가기
        </button>
      </footer>
      {selectedShortage && (
        <ShortageDetailDialog
          record={selectedShortage}
          onClose={() => setSelectedShortage(null)}
        />
      )}
      {selectedPrescription && (
        <PrescriptionDetailDialog
          record={selectedPrescription}
          onClose={() => setSelectedPrescription(null)}
        />
      )}
      {dateOpen && (
        <DateRangeDialog
          range={range}
          onClose={() => setDateOpen(false)}
          onApply={(next) => {
            setRange(next);
            setDateOpen(false);
          }}
        />
      )}
    </div>
  );
}
