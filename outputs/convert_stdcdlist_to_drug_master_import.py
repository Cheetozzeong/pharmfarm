#!/usr/bin/env python3
import argparse
import csv
from datetime import date
from pathlib import Path


OUTPUT_HEADERS = [
    "한글상품명",
    "약품규격",
    "제품총수량",
    "표준코드",
    "제품코드(개정후)",
    "전문일반구분",
    "비고",
    "StdCd_적용개시일자",
    "StdCd_적용종료일자",
    "StdCd_양도개시일자",
    "StdCd_양도종료일자",
    "StdCd_상한가",
    "StdCd_급여비급여구분",
    "StdCd_안전상비의약품여부",
    "StdCd_퇴장방지저가방사선여부",
    "StdCd_품목기준코드",
    "StdCd_식약처취소일자",
    "StdCd_일련번호제외여부코드",
    "StdCd_일련번호제외사유코드",
    "StdCd_의약품판독장비구분코드",
]


def yyyymmdd(value):
    compact = value.replace("-", "").strip()
    if len(compact) != 8 or not compact.isdigit():
        raise argparse.ArgumentTypeError("--as-of must be YYYYMMDD or YYYY-MM-DD")
    return compact


def derived_product_code(standard_code):
    standard_code = standard_code.strip()
    if len(standard_code) == 13 and standard_code.isdigit():
        return standard_code[3:12]
    return ""


def is_metadata_row(row):
    return len(row) == 2 and row[1].strip().startswith("수량:")


def is_active(row, as_of):
    return row[2].strip() <= as_of <= row[3].strip()


def choose_latest_active_rows(rows, as_of):
    chosen = {}
    inactive_rows = 0
    invalid_rows = 0

    for index, row in enumerate(rows):
        if len(row) != 17:
            invalid_rows += 1
            continue

        standard_code = row[0].strip()
        product_name = row[1].strip()
        product_code = derived_product_code(standard_code)
        if not standard_code or not product_name or not product_code:
            invalid_rows += 1
            continue

        if not is_active(row, as_of):
            inactive_rows += 1
            continue

        score = (row[2].strip(), row[3].strip(), index)
        current = chosen.get(standard_code)
        if current is None or score > current[0]:
            chosen[standard_code] = (score, row)

    return chosen, inactive_rows, invalid_rows


def output_row(row):
    standard_code = row[0].strip()
    return [
        row[1].strip(),
        "",
        row[6].strip() or "0",
        standard_code,
        derived_product_code(standard_code),
        row[10].strip(),
        "",
        row[2].strip(),
        row[3].strip(),
        row[4].strip(),
        row[5].strip(),
        row[7].strip(),
        row[8].strip(),
        row[9].strip(),
        row[11].strip(),
        row[12].strip(),
        row[13].strip(),
        row[14].strip(),
        row[15].strip(),
        row[16].strip(),
    ]


def convert(source, destination, as_of):
    with source.open("r", encoding="utf-8-sig", newline="") as input_file:
        reader = csv.reader(input_file)
        rows = list(reader)

    metadata = rows[0] if rows and is_metadata_row(rows[0]) else None
    data_rows = rows[1:] if metadata else rows
    chosen, inactive_rows, invalid_rows = choose_latest_active_rows(data_rows, as_of)

    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="") as output_file:
        writer = csv.writer(output_file)
        writer.writerow(OUTPUT_HEADERS)
        for _, row in sorted(chosen.values(), key=lambda item: item[0][2]):
            writer.writerow(output_row(row))

    duplicate_active_rows = len(data_rows) - inactive_rows - invalid_rows - len(chosen)
    print(f"source_rows={len(data_rows)}")
    if metadata:
        print(f"source_metadata={metadata[0]} / {metadata[1]}")
    print(f"as_of={as_of}")
    print(f"output_rows={len(chosen)}")
    print(f"inactive_rows_skipped={inactive_rows}")
    print(f"invalid_rows_skipped={invalid_rows}")
    print(f"duplicate_active_rows_resolved={duplicate_active_rows}")
    print(f"output={destination}")


def main():
    parser = argparse.ArgumentParser(
        description="Convert KPIS StdCdList.csv into PharmFarm drug master import CSV."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--as-of", type=yyyymmdd, default=date.today().strftime("%Y%m%d"))
    args = parser.parse_args()

    convert(args.source, args.destination, args.as_of)


if __name__ == "__main__":
    main()
