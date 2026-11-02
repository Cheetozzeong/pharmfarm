import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  ClipboardList,
  RefreshCw,
} from "lucide-react";
import {
  prescriptionLineChanges,
  prescriptionChangeSummary,
  prescriptionDecisionReadiness,
} from "./prescriptionChangeView";
import type {
  PrescriptionChangeLine as Line,
  PrescriptionLineChange,
} from "./prescriptionChangeView";
import "./PrescriptionChanges.css";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;
type StockEffect = {
  stockId: number;
  drugName: string;
  insuranceCode?: string;
  beforeQuantity?: number;
  returnQuantity: number;
  afterQuantity?: number;
  blocked?: boolean;
};
type Processing = {
  line_no: string;
  insurance_code: string;
  deducted_quantity: number;
  substitute_quantity: number;
  shortage_quantity: number;
  shortage_status?: string;
};
type Change = {
  id: number;
  pharmacyId: number;
  prescriptionCode: string;
  status: string;
  reason: string;
  cancellation: boolean;
  before: Line[];
  after: Line[];
  current?: Line[];
  processing?: Processing[];
  capturedAt: string;
  createdAt: string;
  decidedAt?: string;
  decidedByAccountId?: number;
  memo?: string;
  stockEffects?: StockEffect[];
  reviewToken?: string;
  canApprove?: boolean;
  currentReason?: string;
};
const labels: Record<string, string> = {
  PENDING: "확인 필요",
  AUTO_APPLIED: "자동 반영",
  APPROVED: "승인 반영",
  REJECTED: "기존 처방 유지",
  SUPERSEDED: "새 수정본 있음",
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const payload = (value: unknown) => object(object(value).data ?? value);
const message = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "요청을 완료하지 못했습니다. 다시 확인해 주세요.";
const date = (value?: string) =>
  value ? value.replace("T", " ").slice(0, 19) : "-";
export function PrescriptionChangeAlert({
  request,
  navigate,
}: {
  request: Api;
  navigate: (path: string) => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true,
      pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const data = payload(await request("/prescription-changes/summary"));
        if (active) {
          setCount(Number(data.pendingCount ?? 0));
          setError("");
        }
      } catch (e) {
        if (active) setError(message(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [request]);
  if (error)
    return (
      <div className="rx-change-alert" role="status">
        <AlertTriangle size={20} />
        <span>변동 처방 알림을 확인하지 못했습니다. {error}</span>
        <button onClick={() => navigate("/cms/prescriptions/changes")}>
          변동 처방 확인
        </button>
      </div>
    );
  if (!count) return null;
  return (
    <div className="rx-change-alert" role="status" aria-live="polite">
      <AlertTriangle size={23} aria-hidden="true" />
      <div>
        <strong>확인이 필요한 변동 처방 {count}건</strong>
        <p>
          이팜 수정 내용과 기존 재고 처리가 겹칩니다. 변경 내용을 확인해 주세요.
        </p>
      </div>
      <button
        type="button"
        onClick={() => navigate("/cms/prescriptions/changes")}
      >
        변동 처방 내역관리 <ArrowRight size={16} />
      </button>
    </div>
  );
}

export function PrescriptionChangePage({
  request,
  root,
  limited = false,
  refreshKey = 0,
}: {
  request: Api;
  root: boolean;
  limited?: boolean;
  refreshKey?: number;
}) {
  const [status, setStatus] = useState("PENDING");
  const [keyword, setKeyword] = useState("");
  const [pharmacy, setPharmacy] = useState("");
  const [filter, setFilter] = useState({ keyword: "", pharmacy: "" });
  const [page, setPage] = useState(0);
  const [records, setRecords] = useState<Change[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Change | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [memo, setMemo] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const detailRequest = useRef(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listPanel = useRef<HTMLElement>(null);
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) return;
    detailHeading.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 900px)").matches) {
      detailHeading.current
        ?.closest(".rx-change-detail")
        ?.scrollIntoView({ block: "start" });
    }
  }, [selectedId]);
  const batchPage = Math.floor(page / 5);
  const visibleRecords = records.slice((page % 5) * 10, ((page % 5) + 1) * 10);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSelected(null);
    setDetailLoading(false);
    detailRequest.current++;
    const query = new URLSearchParams({ status, page: String(batchPage) });
    if (filter.keyword) query.set("keyword", filter.keyword);
    if (root && filter.pharmacy) query.set("pharmacyId", filter.pharmacy);
    request(`/prescription-changes?${query}`)
      .then((raw) => {
        if (!active) return;
        const data = payload(raw);
        setRecords(Array.isArray(data.items) ? (data.items as Change[]) : []);
        const nextTotal = Number(data.total ?? 0);
        setTotal(nextTotal);
        setPage((current) =>
          Math.min(current, Math.max(0, Math.ceil(nextTotal / 10) - 1)),
        );
      })
      .catch((e) => {
        if (active) {
          setError(message(e));
          setRecords([]);
          setTotal(0);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [request, status, filter, batchPage, root, reload, refreshKey]);
  useEffect(() => {
    setSelected(null);
    setDetailLoading(false);
    detailRequest.current++;
  }, [page]);
  useEffect(
    () => () => {
      detailRequest.current++;
    },
    [],
  );
  async function open(record: Change) {
    const id = ++detailRequest.current;
    setDetailLoading(true);
    setSelected(null);
    setMemo("");
    setConfirmed(false);
    setError("");
    setNotice("");
    try {
      const data = payload(await request(`/prescription-changes/${record.id}`));
      if (id === detailRequest.current) setSelected(data as unknown as Change);
    } catch (e) {
      if (id === detailRequest.current) setError(message(e));
    } finally {
      if (id === detailRequest.current) setDetailLoading(false);
    }
  }
  async function decide(action: "APPROVE" | "REJECT") {
    if (
      !selected ||
      saving ||
      !confirmed ||
      !memo.trim() ||
      !selected.reviewToken
    )
      return;
    setSaving(true);
    setError("");
    try {
      await request(`/prescription-changes/${selected.id}/decision`, {
        method: "POST",
        body: JSON.stringify({
          action,
          reviewToken: selected.reviewToken,
          confirmed,
          memo: memo.trim(),
        }),
      });
      setNotice(
        action === "APPROVE"
          ? "변경 내용과 재고 보정을 반영했습니다."
          : "기존 처방 유지 결정을 기록했습니다.",
      );
      setReload((value) => value + 1);
    } catch (e) {
      setError(message(e));
      setConfirmed(false);
    } finally {
      setSaving(false);
    }
  }
  const pending = selected?.status === "PENDING";
  const comparisonBefore = pending
    ? (selected?.current ?? selected?.before ?? [])
    : (selected?.before ?? []);
  const lineChanges = selected
    ? prescriptionLineChanges(
        comparisonBefore,
        selected.after,
        selected.cancellation,
      )
    : [];
  const readiness = prescriptionDecisionReadiness({
    memo,
    confirmed,
    reviewToken: selected?.reviewToken,
    canApprove: selected?.canApprove,
    saving,
  });
  const pageCount = Math.max(1, Math.ceil(total / 10));
  function closeDetail() {
    if (saving) return;
    detailRequest.current++;
    setSelected(null);
    setDetailLoading(false);
    setError("");
    if (window.matchMedia("(max-width: 900px)").matches) {
      window.requestAnimationFrame(() =>
        listPanel.current?.scrollIntoView({ block: "start" }),
      );
    }
  }
  return (
    <section className="cms-content rx-change-page">
      <div className="rx-change-heading">
        <div>
          <h2>변동 처방 내역관리</h2>
          <p>이팜 수정 내용을 확인하고, 우리 쪽 처방과 재고에 반영합니다.</p>
        </div>
        <button
          type="button"
          className="rx-change-secondary"
          onClick={() => setReload((value) => value + 1)}
          disabled={saving}
        >
          <RefreshCw size={15} aria-hidden="true" /> 새로고침
        </button>
      </div>
      <form
        className="rx-change-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(0);
          setFilter({ keyword: keyword.trim(), pharmacy: pharmacy.trim() });
        }}
      >
        <label>
          처리 상태
          <select
            value={status}
            disabled={saving}
            onChange={(event) => {
              setPage(0);
              setStatus(event.target.value);
            }}
          >
            <option value="PENDING">확인 필요</option>
            <option value="ALL">전체 내역</option>
            <option value="AUTO_APPLIED">자동 반영</option>
            <option value="APPROVED">승인 반영</option>
            <option value="REJECTED">기존 처방 유지</option>
            <option value="SUPERSEDED">새 수정본 있음</option>
          </select>
        </label>
        <label className="rx-change-search">
          처방전 번호
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="처방전 번호 검색"
          />
        </label>
        {root && (
          <label>
            약국 ID
            <input
              type="number"
              min="1"
              value={pharmacy}
              onChange={(event) => setPharmacy(event.target.value)}
              placeholder="전체 약국"
            />
          </label>
        )}
        <button type="submit" disabled={loading || saving}>
          조회
        </button>
        <span className="rx-change-filter-note">
          일반 수정은 자동 반영되고, 재고 처리가 겹치는 내역만 확인합니다.
        </span>
      </form>
      {error && (
        <p className="rx-change-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="rx-change-notice" role="status">
          {notice}
        </p>
      )}
      <div
        className={`rx-change-layout ${selected || detailLoading ? "is-detail" : ""}`}
      >
        <section
          className="rx-change-list"
          ref={listPanel}
          aria-label="변동 처방 목록"
          aria-busy={loading}
        >
          <header>
            <strong>
              {labels[status] ?? "전체 내역"}
              <span className="rx-change-count">{total}건</span>
            </strong>
            <span>처방 선택</span>
          </header>
          <div className="rx-change-list-scroll">
            {loading ? (
              <p className="rx-change-empty">변동 처방을 불러오고 있습니다.</p>
            ) : !records.length ? (
              <p className="rx-change-empty">표시할 변동 처방이 없습니다.</p>
            ) : (
              visibleRecords.map((record) => {
                const changes = prescriptionLineChanges(
                  record.before,
                  record.after,
                  record.cancellation,
                );
                const names = [
                  ...new Set(
                    changes
                      .map(
                        (change) => (change.after ?? change.before)?.drugName,
                      )
                      .filter(Boolean),
                  ),
                ];
                return (
                  <button
                    type="button"
                    key={record.id}
                    disabled={saving}
                    className={`rx-change-list-item ${selected?.id === record.id ? "is-selected" : ""}`}
                    aria-pressed={selected?.id === record.id}
                    onClick={() => void open(record)}
                  >
                    <span className="rx-change-list-top">
                      <strong>{record.prescriptionCode}</strong>
                      <StatusBadge status={record.status} />
                    </span>
                    <span className="rx-change-list-summary">
                      {prescriptionChangeSummary(changes, record.cancellation)}
                    </span>
                    <span
                      className="rx-change-list-drugs"
                      title={names.join(", ")}
                    >
                      {names.slice(0, 2).join(", ") || "처방 정보 확인"}
                      {names.length > 2 ? ` 외 ${names.length - 2}품목` : ""}
                    </span>
                    <small>
                      {root ? `약국 ${record.pharmacyId} · ` : ""}
                      {date(record.capturedAt).slice(0, 16)}
                    </small>
                  </button>
                );
              })
            )}
          </div>
          <div className="rx-change-pagination">
            <button
              type="button"
              disabled={page === 0 || loading || saving}
              onClick={() => setPage((value) => value - 1)}
            >
              이전
            </button>
            <span>
              {page + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={page + 1 >= pageCount || loading || saving}
              onClick={() => setPage((value) => value + 1)}
            >
              다음
            </button>
          </div>
        </section>
        <section
          className="rx-change-detail"
          aria-label="선택한 처방 변경 내용"
          aria-busy={detailLoading}
        >
          {detailLoading ? (
            <div className="rx-change-empty">
              변경 상세를 불러오고 있습니다.
            </div>
          ) : !selected ? (
            <div className="rx-change-placeholder">
              <ClipboardList size={32} aria-hidden="true" />
              <strong>확인할 처방을 선택해 주세요</strong>
              <p>바뀐 약품과 재고 영향을 먼저 보여드립니다.</p>
            </div>
          ) : (
            <>
              <header className="rx-change-detail-header">
                <div className="rx-change-detail-title">
                  <button
                    type="button"
                    className="rx-change-mobile-back rx-change-secondary"
                    onClick={closeDetail}
                    disabled={saving}
                    aria-label="처방 목록으로 돌아가기"
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <div>
                    <div className="rx-change-detail-title-row">
                      <h3 ref={detailHeading} tabIndex={-1}>
                        {selected.prescriptionCode}
                      </h3>
                      <StatusBadge status={selected.status} />
                    </div>
                    <span>
                      수집 {date(selected.capturedAt)}
                      {root ? ` · 약국 ${selected.pharmacyId}` : ""}
                    </span>
                  </div>
                </div>
              </header>
              <div className="rx-change-detail-scroll" key={selected.id}>
                <div
                  className={`rx-change-review-note ${pending ? "is-pending" : ""}`}
                >
                  {pending && <AlertTriangle size={17} aria-hidden="true" />}
                  <div>
                    <strong>
                      {pending
                        ? "확인이 필요한 이유"
                        : (labels[selected.status] ?? "처리 내역")}
                    </strong>
                    <p>{selected.currentReason ?? selected.reason}</p>
                  </div>
                </div>
                <section className="rx-change-section">
                  <div className="rx-change-section-heading">
                    <h4>바뀐 약품</h4>
                    <span>
                      {prescriptionChangeSummary(
                        lineChanges,
                        selected.cancellation,
                      )}
                    </span>
                  </div>
                  <ChangedLines
                    changes={lineChanges}
                    cancellation={selected.cancellation}
                  />
                </section>
                <section className="rx-change-section rx-change-impact">
                  <div className="rx-change-section-heading">
                    <h4>
                      {pending
                        ? "수정 반영 시 재고 변화"
                        : "반영 당시 재고 변화"}
                    </h4>
                  </div>
                  {selected.stockEffects?.length ? (
                    <>
                      {selected.stockEffects.map((effect) => (
                        <div
                          className="rx-change-impact-row"
                          key={effect.stockId}
                        >
                          <div>
                            <strong>{effect.drugName}</strong>
                            <span>
                              {effect.blocked
                                ? "재고 연결 복구 필요"
                                : `${pending ? "현재" : "반영 전"} ${effect.beforeQuantity ?? "-"}개 → 반영 후 ${effect.afterQuantity ?? "-"}개`}
                            </span>
                          </div>
                          <b className={effect.blocked ? "is-blocked" : ""}>
                            +{effect.returnQuantity}개 복원
                          </b>
                        </div>
                      ))}
                      <p className="rx-change-help">
                        초과 차감한 수량을 전산 재고에 되돌립니다. 도매처 반품을
                        뜻하지 않습니다.
                      </p>
                    </>
                  ) : (
                    <p className="rx-change-help">
                      {pending
                        ? "재고에 다시 더할 수량은 없습니다. 기존 차감을 유지하고 부족 수량을 다시 계산합니다."
                        : "기록된 재고 보정이 없습니다."}
                    </p>
                  )}
                  {pending && (
                    <p className="rx-change-help">
                      추가로 필요한 수량은 부족분으로 기록하며, 자동으로 더
                      차감하지 않습니다.
                    </p>
                  )}
                </section>
                <details className="rx-change-disclosure">
                  <summary>
                    <span>전체 처방 비교</span>
                    <small>
                      우리 쪽 {comparisonBefore.length}품목 · 수정본{" "}
                      {selected.cancellation ? 0 : selected.after.length}품목
                    </small>
                    <ChevronRight size={16} aria-hidden="true" />
                  </summary>
                  <div className="rx-change-comparison">
                    <LineTable
                      title={pending ? "우리 쪽 현재 처방" : "수정 전 처방"}
                      lines={comparisonBefore}
                    />
                    <LineTable
                      title={
                        selected.cancellation
                          ? "이팜 수정본 · 처방 취소"
                          : "이팜 수정본"
                      }
                      lines={selected.cancellation ? [] : selected.after}
                    />
                  </div>
                </details>
                {Boolean(selected.processing?.length) && (
                  <details className="rx-change-disclosure">
                    <summary>
                      <span>차감·부족 처리 내역</span>
                      <small>{selected.processing?.length}품목</small>
                      <ChevronRight size={16} aria-hidden="true" />
                    </summary>
                    <div className="rx-change-processing">
                      {selected.processing?.map((item, index) => {
                        const line = comparisonBefore.find(
                          (line) => line.lineNo === item.line_no,
                        );
                        return (
                          <div key={`${item.line_no}:${index}`}>
                            <strong>
                              {line?.drugName || `처방 행 ${item.line_no}`}
                            </strong>
                            <p>
                              이미 차감 {item.deducted_quantity ?? 0}개 · 대체
                              차감 {item.substitute_quantity ?? 0}개 · 부족{" "}
                              {item.shortage_quantity ?? 0}개
                              {item.shortage_status
                                ? ` · ${workflowLabel(item.shortage_status)}`
                                : ""}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                )}
                {!pending && (
                  <details className="rx-change-disclosure">
                    <summary>
                      <span>처리 이력</span>
                      <small>{date(selected.decidedAt).slice(0, 16)}</small>
                      <ChevronRight size={16} aria-hidden="true" />
                    </summary>
                    <p className="rx-change-audit">
                      처리 {date(selected.decidedAt)}
                      {selected.decidedByAccountId
                        ? ` · 계정 #${selected.decidedByAccountId}`
                        : ""}
                      <br />
                      {selected.memo || "기록된 처리 사유가 없습니다."}
                    </p>
                  </details>
                )}
              </div>
              {pending &&
                (limited ? (
                  <div className="rx-change-decision">
                    <p className="rx-change-help">
                      처리는 약국 주계정 또는 관리자 계정으로 진행해 주세요.
                    </p>
                  </div>
                ) : (
                  <div className="rx-change-decision">
                    <div className="rx-change-decision-heading">
                      <label htmlFor="rx-change-memo">
                        처리 사유{" "}
                        <span className="rx-change-required">필수</span>
                      </label>
                      <span className={readiness.canKeep ? "is-ready" : ""}>
                        {Number(Boolean(memo.trim())) + Number(confirmed)}/2
                        완료
                      </span>
                    </div>
                    <textarea
                      id="rx-change-memo"
                      aria-required="true"
                      aria-describedby="rx-change-action-hint"
                      rows={1}
                      maxLength={1000}
                      value={memo}
                      disabled={saving}
                      onChange={(event) => setMemo(event.target.value)}
                      placeholder="변경 확인 내용과 처리 사유를 입력해 주세요."
                    />
                    <label className="rx-change-confirm">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        aria-required="true"
                        aria-describedby="rx-change-action-hint"
                        disabled={saving}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      <span>
                        변경 내용과 실제 재고를 확인했습니다.{" "}
                        <span className="rx-change-required">필수</span>
                      </span>
                    </label>
                    <div className="rx-change-decision-bottom">
                      <p
                        id="rx-change-action-hint"
                        className={
                          readiness.canKeep
                            ? "rx-change-ready"
                            : "rx-change-action-hint"
                        }
                        role="status"
                        aria-live="polite"
                      >
                        {readiness.canKeep && (
                          <Check size={14} aria-hidden="true" />
                        )}
                        {readiness.commonMessage}
                      </p>
                      <div className="rx-change-decision-buttons">
                        <button
                          type="button"
                          className="rx-change-secondary"
                          disabled={!readiness.canKeep}
                          onClick={() => void decide("REJECT")}
                        >
                          기존 처방 유지
                        </button>
                        <button
                          type="button"
                          disabled={!readiness.canApply}
                          onClick={() => void decide("APPROVE")}
                        >
                          {saving ? "처리 중" : "확인 후 수정 반영"}
                        </button>
                      </div>
                    </div>
                    {readiness.applyMessage && (
                      <p className="rx-change-blocked" role="status">
                        {readiness.applyMessage}
                      </p>
                    )}
                  </div>
                ))}
            </>
          )}
        </section>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rx-change-badge ${status === "PENDING" ? "is-pending" : ""}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

function ChangedLines({
  changes,
  cancellation,
}: {
  changes: PrescriptionLineChange[];
  cancellation: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? changes : changes.slice(0, 3);
  if (!changes.length)
    return (
      <p className="rx-change-help">
        약품별 수량 차이는 없습니다. 위의 변경 사유와 재고 영향을 확인해 주세요.
      </p>
    );
  return (
    <div className="rx-change-diff-list">
      {visible.map((change) => {
        const line = change.after ?? change.before!;
        return (
          <article className="rx-change-diff" key={change.key}>
            <div className="rx-change-diff-title">
              <div>
                <strong>{line.drugName || "약품명 없음"}</strong>
                <small>{line.insuranceCode}</small>
              </div>
              <span className={`rx-change-kind is-${change.kind}`}>
                {change.kind === "added"
                  ? "추가"
                  : change.kind === "removed"
                    ? cancellation
                      ? "취소"
                      : "삭제"
                    : "수정"}
              </span>
            </div>
            <div className="rx-change-quantity-diff">
              <span>
                <small>기존</small>
                <b>
                  {change.before
                    ? `${change.before.totalQuantity ?? change.before.quantity}개`
                    : "없음"}
                </b>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
              <span>
                <small>수정</small>
                <b>
                  {change.after
                    ? `${change.after.totalQuantity ?? change.after.quantity}개`
                    : "처방에서 제외"}
                </b>
              </span>
            </div>
            {change.fields.includes("복용 정보") && (
              <p className="rx-change-help">
                복용 정보: {change.before?.dose} × {change.before?.daily}회 ×{" "}
                {change.before?.days}일 → {change.after?.dose} ×{" "}
                {change.after?.daily}회 × {change.after?.days}일
              </p>
            )}
            {change.fields.filter(
              (field) => !["수량", "복용 정보"].includes(field),
            ).length > 0 && (
              <p className="rx-change-help">
                {change.fields
                  .filter((field) => !["수량", "복용 정보"].includes(field))
                  .join(" · ")}{" "}
                변경
              </p>
            )}
          </article>
        );
      })}
      {changes.length > 3 && (
        <button
          type="button"
          className="rx-change-expand"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? "변경 품목 접기"
            : `나머지 ${changes.length - 3}품목 더 보기`}
        </button>
      )}
    </div>
  );
}

function LineTable({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <section className="rx-change-lines">
      <h4>{title}</h4>
      {!lines.length ? (
        <p>처방 품목 없음</p>
      ) : (
        <div>
          <table>
            <thead>
              <tr>
                <th>약품</th>
                <th>1회 × 횟수 × 일수</th>
                <th>총 수량</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.lineNo}>
                  <td>
                    {line.drugName}
                    <small>
                      {line.insuranceCode} · 행 {line.lineNo}
                    </small>
                  </td>
                  <td>
                    {line.dose} × {line.daily} × {line.days}
                  </td>
                  <td>{line.totalQuantity ?? line.quantity}개</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
function workflowLabel(value: string) {
  return (
    (
      {
        ORDERED: "주문 완료",
        HOLD: "보류",
        SUBSTITUTED: "대체 처리",
        RESOLVED: "해결 완료",
        IGNORED: "제외",
        OPEN: "주문 필요",
      } as Record<string, string>
    )[value] ?? value
  );
}
