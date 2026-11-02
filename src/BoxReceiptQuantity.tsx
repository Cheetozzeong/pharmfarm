import { Check, Minus, Package, Plus } from "lucide-react";

type BoxReceiptQuantityProps = {
  item: {
    id: string;
    drug: {
      boxPackageCount?: number;
      boxMappingRevision?: number;
      boxQuantityConfirmed?: boolean;
      baseProductTotalQuantity?: number;
      productTotalQuantity: number;
    };
  };
  onSelectQuantity: (
    itemId: string,
    count: number,
    confirmed?: boolean,
  ) => void;
};

const quantityFormat = new Intl.NumberFormat("ko-KR");

export function BoxReceiptQuantity({
  item,
  onSelectQuantity,
}: BoxReceiptQuantityProps) {
  const count = item.drug.boxPackageCount ?? 0;
  const valid = Number.isInteger(count) && count >= 1 && count <= 10000;
  const confirmed = item.drug.boxQuantityConfirmed === true && valid;
  const previouslyRegistered = Boolean(item.drug.boxMappingRevision);
  const baseQuantity = item.drug.baseProductTotalQuantity ?? 0;
  const inputId = `box-count-${item.id}`;
  const hintId = `box-hint-${item.id}`;
  const formattedCount = quantityFormat.format(count);

  function changeCount(delta: number) {
    const nextCount = Math.min(10000, Math.max(1, (valid ? count : 0) + delta));
    onSelectQuantity(item.id, nextCount, false);
  }

  return (
    <section
      className={`box-receipt-quantity ${confirmed ? "is-confirmed" : ""}`}
      aria-label="박스 포장 수량 확인"
    >
      <div className="box-receipt-heading">
        <span className="box-receipt-title">
          <Package size={17} aria-hidden="true" />
          박스당 수량
        </span>
        <span className="box-receipt-badge">
          {confirmed
            ? "확인 완료"
            : previouslyRegistered
              ? "확인 필요"
              : "처음 등록"}
        </span>
      </div>

      <div className="box-receipt-editor">
        <label htmlFor={inputId}>1박스에 들어 있는 수량</label>
        <div className="box-receipt-stepper">
          <button
            type="button"
            aria-label="박스당 수량 1개 줄이기"
            disabled={!valid || count <= 1}
            onClick={() => changeCount(-1)}
          >
            <Minus size={20} aria-hidden="true" />
          </button>
          <div
            className={`box-receipt-value ${count >= 1000 ? "is-long-count" : ""}`}
          >
            <input
              id={inputId}
              aria-label="1박스에 들어 있는 낱개 포장 수량"
              aria-describedby={hintId}
              type="number"
              inputMode="numeric"
              min="1"
              max="10000"
              step="1"
              value={count || ""}
              style={{
                width: count ? `${String(count).length + 0.3}ch` : "3ch",
              }}
              placeholder="수량"
              onChange={(event) =>
                onSelectQuantity(item.id, Number(event.target.value), false)
              }
              onKeyDown={(event) => {
                if (event.key === "Enter" && valid) {
                  event.preventDefault();
                  onSelectQuantity(item.id, count, true);
                  event.currentTarget.blur();
                }
              }}
            />
            <span aria-hidden="true">개</span>
          </div>
          <button
            type="button"
            aria-label="박스당 수량 1개 늘리기"
            disabled={count >= 10000}
            onClick={() => changeCount(1)}
          >
            <Plus size={20} aria-hidden="true" />
          </button>
        </div>
        <p id={hintId} className="box-receipt-hint">
          {previouslyRegistered
            ? "박스에 적힌 개수와 다르면 수정해 주세요."
            : "박스에 적힌 포장 수량을 입력해 주세요."}
        </p>
      </div>

      <div className="box-receipt-total">
        <span>
          이번 입고
          {valid && baseQuantity > 1 && (
            <small>
              1포장 {quantityFormat.format(baseQuantity)}개 × {formattedCount}
              포장
            </small>
          )}
        </span>
        <strong>
          {valid
            ? `+${quantityFormat.format(item.drug.productTotalQuantity)}개`
            : "수량 입력 대기"}
        </strong>
      </div>

      <button
        type="button"
        className="box-receipt-confirm"
        disabled={!valid}
        aria-pressed={confirmed}
        onClick={() => onSelectQuantity(item.id, count, true)}
      >
        <span className="box-receipt-check" aria-hidden="true">
          {confirmed && <Check size={15} strokeWidth={3} />}
        </span>
        {confirmed
          ? `${formattedCount}개 확인 완료`
          : valid
            ? `${formattedCount}개가 맞아요`
            : "수량 입력 후 확인"}
      </button>
      <p className="box-receipt-footnote">
        입고 확정 후 다음 스캔에도 적용됩니다.
      </p>
    </section>
  );
}
