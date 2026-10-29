import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, RefreshCw } from "lucide-react";
import "./PrescriptionChanges.css";

type Api = (path: string, init?: RequestInit) => Promise<unknown>;
type Line = {
  lineNo: string;
  insuranceCode: string;
  drugName: string;
  dose: string;
  daily: string;
  days: number;
  quantity: number;
  totalQuantity?: string;
  substitutionType: number;
};
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
const quantity = (lines: Line[]) =>
  lines
    .filter(
      (line) =>
        line.insuranceCode.length >= 9 &&
        ![1, 9].includes(line.substitutionType),
    )
    .reduce((sum, line) => sum + line.quantity, 0);

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
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSelected(null);
    setDetailLoading(false);
    detailRequest.current++;
    const query = new URLSearchParams({ status, page: String(page) });
    if (filter.keyword) query.set("keyword", filter.keyword);
    if (root && filter.pharmacy) query.set("pharmacyId", filter.pharmacy);
    request(`/prescription-changes?${query}`)
      .then((raw) => {
        if (!active) return;
        const data = payload(raw);
        setRecords(Array.isArray(data.items) ? (data.items as Change[]) : []);
        setTotal(Number(data.total ?? 0));
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
  }, [request, status, filter, page, root, reload, refreshKey]);
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
  return (
    <section className="cms-content rx-change-page">
      <div className="rx-change-heading">
        <div>
          <h2>변동 처방 내역관리</h2>
          <p>
            일반 수정은 자동 반영합니다. 반환 재고·대체·완료 처리와 겹치는
            변경만 확인합니다.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setReload((value) => value + 1)}
          disabled={saving}
        >
          <RefreshCw size={16} /> 새로고침
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
        <label>
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
      <div className="rx-change-layout">
        <div className="rx-change-list" aria-busy={loading}>
          <header>
            <strong>{labels[status] ?? "변동 처방"}</strong>
            <span>{total}건</span>
          </header>
          {loading ? (
            <p>변동 처방을 불러오고 있습니다.</p>
          ) : records.length === 0 ? (
            <p>표시할 변동 처방이 없습니다.</p>
          ) : (
            records.map((record) => (
              <button
                type="button"
                key={record.id}
                disabled={saving}
                className={selected?.id === record.id ? "is-selected" : ""}
                onClick={() => void open(record)}
              >
                <span
                  className={`rx-change-badge ${record.status === "PENDING" ? "is-pending" : ""}`}
                >
                  {labels[record.status] ?? record.status}
                </span>
                <strong>{record.prescriptionCode}</strong>
                <span>
                  {quantity(record.before)}개 →{" "}
                  {record.cancellation
                    ? "처방 취소"
                    : `${quantity(record.after)}개`}
                </span>
                <small>
                  {root ? `약국 ${record.pharmacyId} · ` : ""}
                  {date(record.capturedAt)}
                </small>
                <p>{record.reason}</p>
              </button>
            ))
          )}
          <div className="rx-change-pagination">
            <button
              type="button"
              disabled={page === 0 || loading || saving}
              onClick={() => setPage((value) => value - 1)}
            >
              이전
            </button>
            <span>
              {page + 1} / {Math.max(1, Math.ceil(total / 50))}
            </span>
            <button
              type="button"
              disabled={(page + 1) * 50 >= total || loading || saving}
              onClick={() => setPage((value) => value + 1)}
            >
              다음
            </button>
          </div>
        </div>
        <div className="rx-change-detail" aria-busy={detailLoading}>
          {detailLoading ? (
            <p>변경 상세를 불러오고 있습니다.</p>
          ) : !selected ? (
            <p>목록에서 변동 처방을 선택해 주세요.</p>
          ) : (
            <>
              <header>
                <div>
                  <span
                    className={`rx-change-badge ${pending ? "is-pending" : ""}`}
                  >
                    {labels[selected.status] ?? selected.status}
                  </span>
                  <h3>{selected.prescriptionCode}</h3>
                </div>
                <span>{date(selected.capturedAt)}</span>
              </header>
              <p className="rx-change-reason">
                {selected.currentReason ?? selected.reason}
              </p>
              <div className="rx-change-comparison">
                <LineTable title="이전 처방" lines={selected.before} />
                <LineTable
                  title={
                    selected.cancellation ? "수정본 · 처방 취소" : "이팜 수정본"
                  }
                  lines={selected.after}
                />
              </div>
              {selected.processing && selected.processing.length > 0 && (
                <div className="rx-change-processing">
                  <strong>현재 재고 처리</strong>
                  {selected.processing.map((item, index) => (
                    <p key={`${item.line_no}:${index}`}>
                      행 {item.line_no} · 차감 {item.deducted_quantity ?? 0}개 ·
                      대체 {item.substitute_quantity ?? 0}개 · 부족{" "}
                      {item.shortage_quantity ?? 0}개
                      {item.shortage_status
                        ? ` · ${workflowLabel(item.shortage_status)}`
                        : ""}
                    </p>
                  ))}
                </div>
              )}
              {pending && (
                <>
                  <div className="rx-change-effects">
                    <h4>승인 시 재고 보정</h4>
                    {!selected.stockEffects?.length ? (
                      <p>
                        반환되는 재고가 없습니다. 기존 차감 수량을 유지하고 부족
                        수량을 다시 계산합니다.
                      </p>
                    ) : (
                      selected.stockEffects.map((effect) => (
                        <div key={effect.stockId}>
                          <strong>{effect.drugName}</strong>
                          <span>
                            {effect.blocked
                              ? "재고 연결 복구 필요"
                              : `${effect.beforeQuantity}개 → ${effect.afterQuantity}개`}
                          </span>
                          <b>반환 +{effect.returnQuantity}개</b>
                        </div>
                      ))
                    )}
                    <small>
                      새로운 약품이나 늘어난 미차감 수량은 부족분으로
                      기록합니다. 입고 재고 차감은 기존 확인 절차로 처리합니다.
                    </small>
                  </div>
                  {limited ? (
                    <p>
                      승인은 약국 주계정 또는 관리자 계정으로 진행해 주세요.
                    </p>
                  ) : (
                    <div className="rx-change-decision">
                      <label>
                        처리 사유
                        <textarea
                          maxLength={1000}
                          value={memo}
                          disabled={saving}
                          onChange={(event) => setMemo(event.target.value)}
                          placeholder="변경 확인 내용과 재고 보정 사유를 입력해 주세요."
                        />
                      </label>
                      <label className="rx-change-confirm">
                        <input
                          type="checkbox"
                          checked={confirmed}
                          disabled={saving}
                          onChange={(event) =>
                            setConfirmed(event.target.checked)
                          }
                        />
                        처방 변경과 반환할 실물 재고를 확인했습니다.
                      </label>
                      <div>
                        <button
                          type="button"
                          className="rx-change-secondary"
                          disabled={saving || !confirmed || !memo.trim()}
                          onClick={() => void decide("REJECT")}
                        >
                          기존 처방 유지
                        </button>
                        <button
                          type="button"
                          disabled={
                            saving ||
                            !confirmed ||
                            !memo.trim() ||
                            !selected.canApprove
                          }
                          onClick={() => void decide("APPROVE")}
                        >
                          {saving ? "처리 중" : "확인 후 수정 반영"}
                        </button>
                      </div>
                      {!selected.canApprove && (
                        <p role="status">
                          재고 연결을 복구한 뒤 수정 반영을 승인할 수 있습니다.
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
              {!pending && Boolean(selected.stockEffects?.length) && (
                <div className="rx-change-effects">
                  <h4>반영 당시 재고 보정</h4>
                  {selected.stockEffects?.map((effect) => (
                    <div key={effect.stockId}>
                      <strong>{effect.drugName}</strong>
                      <span>
                        {effect.beforeQuantity}개 → {effect.afterQuantity}개
                      </span>
                      <b>반환 +{effect.returnQuantity}개</b>
                    </div>
                  ))}
                </div>
              )}
              {!pending && (
                <p className="rx-change-audit">
                  처리 {date(selected.decidedAt)}
                  {selected.decidedByAccountId
                    ? ` · 계정 #${selected.decidedByAccountId}`
                    : ""}
                  {selected.memo ? ` · ${selected.memo}` : ""}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </section>
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
