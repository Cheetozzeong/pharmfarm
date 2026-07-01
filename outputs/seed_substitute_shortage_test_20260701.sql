SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @member_key := '2';
SET @account_id := 2;
SET @prescription_code := 'TEST-SUB-20260701-001';

SET @origin_code := 'TEST-SUB-ORIGIN';
SET @low_code := 'TEST-SUB-LOW';
SET @enough_code := 'TEST-SUB-ENOUGH';

SELECT GROUP_CONCAT(id) INTO @old_deduction_ids
FROM pharmfarm_prescription_stock_deduction
WHERE member_key = @member_key
  AND prescription_code = @prescription_code;

DELETE FROM pharmfarm_stock_movement
WHERE member_key = @member_key
  AND reference_type = 'PRESCRIPTION_SHORTAGE'
  AND FIND_IN_SET(reference_id, COALESCE(@old_deduction_ids, ''));

DELETE FROM pharmfarm_prescription_stock_deduction
WHERE member_key = @member_key
  AND prescription_code = @prescription_code;

DELETE drug
FROM pharmfarm_prescription_drug drug
JOIN pharmfarm_prescription prescription
  ON prescription.id = drug.prescription_id
WHERE prescription.prescription_code = @prescription_code;

DELETE FROM pharmfarm_prescription
WHERE prescription_code = @prescription_code;

DELETE movement
FROM pharmfarm_stock_movement movement
JOIN pharmfarm_stock stock
  ON stock.id = movement.stock_id
WHERE stock.member_key = @member_key
  AND stock.insurance_code IN (@origin_code, @low_code, @enough_code);

DELETE FROM pharmfarm_stock
WHERE member_key = @member_key
  AND insurance_code IN (@origin_code, @low_code, @enough_code);

INSERT INTO pharmfarm_stock (
  member_key,
  code_type,
  insurance_code,
  drug_name,
  drug_name_normalized,
  price,
  quantity,
  product_total_quantity,
  match_status,
  virtual_stock,
  created_by_account_id,
  active,
  created_at,
  updated_at
) VALUES
(
  @member_key,
  'TEST',
  @origin_code,
  '테스트 원처방 부족약',
  '테스트원처방부족약',
  100,
  0,
  30,
  'MANUAL',
  0,
  @account_id,
  1,
  NOW(),
  NOW()
),
(
  @member_key,
  'TEST',
  @low_code,
  '대체테스트정 10mg - 부족 후보',
  '대체테스트정10mg부족후보',
  150,
  3,
  30,
  'MANUAL',
  0,
  @account_id,
  1,
  NOW(),
  NOW()
),
(
  @member_key,
  'TEST',
  @enough_code,
  '대체테스트정 20mg - 충분 후보',
  '대체테스트정20mg충분후보',
  200,
  30,
  30,
  'MANUAL',
  0,
  @account_id,
  1,
  NOW(),
  NOW()
);

SELECT id INTO @origin_stock_id
FROM pharmfarm_stock
WHERE member_key = @member_key
  AND insurance_code = @origin_code
LIMIT 1;

INSERT INTO pharmfarm_prescription (
  prescription_code,
  prescription_group_id,
  prescription_group_label,
  qr_type,
  source,
  drug_count,
  captured_at,
  created_at,
  updated_at
) VALUES (
  @prescription_code,
  'TEST-SUB-20260701',
  '대체 처리 테스트 처방',
  'TEST',
  'MANUAL_TEST',
  2,
  NOW(6),
  NOW(6),
  NOW(6)
);

SET @prescription_id := LAST_INSERT_ID();

INSERT INTO pharmfarm_prescription_drug (
  prescription_id,
  line_no,
  insurance_code,
  drug_name,
  quantity_per_dose,
  daily_frequency,
  medication_days,
  total_quantity,
  memo,
  raw_json,
  created_at,
  updated_at
) VALUES
(
  @prescription_id,
  1,
  @origin_code,
  '테스트 원처방 부족약',
  1,
  8,
  1,
  8,
  '대체 처리 테스트 대상',
  JSON_OBJECT('test', true, 'type', 'substitute-shortage-target'),
  NOW(6),
  NOW(6)
),
(
  @prescription_id,
  2,
  'TEST-NORMAL-LINE',
  '테스트 일반 처방약',
  1,
  1,
  1,
  1,
  '상세 화면 전체 처방 표시 확인용',
  JSON_OBJECT('test', true, 'type', 'normal-line'),
  NOW(6),
  NOW(6)
);

INSERT INTO pharmfarm_prescription_stock_deduction (
  member_key,
  prescription_id,
  prescription_code,
  line_no,
  insurance_code,
  drug_name,
  drug_name_normalized,
  deduct_quantity,
  deducted_quantity,
  shortage_quantity,
  stock_before_quantity,
  stock_after_quantity,
  status,
  resolution_type,
  shortage_status,
  failure_reason,
  stock_id,
  memo,
  raw_json,
  created_at,
  updated_at
) VALUES (
  @member_key,
  @prescription_id,
  @prescription_code,
  '1',
  @origin_code,
  '테스트 원처방 부족약',
  '테스트원처방부족약',
  8,
  0,
  8,
  0,
  0,
  'SHORTAGE',
  NULL,
  'OPEN',
  '테스트 데이터: 원 처방 약품 재고 부족',
  @origin_stock_id,
  '대체 처리 테스트용 초과 처방',
  JSON_OBJECT('test', true, 'type', 'substitute-shortage-deduction'),
  NOW(),
  NOW()
);

SELECT
  @prescription_code AS prescription_code,
  @member_key AS member_key,
  @origin_stock_id AS origin_stock_id,
  (SELECT id FROM pharmfarm_stock WHERE member_key = @member_key AND insurance_code = @low_code LIMIT 1) AS low_substitute_stock_id,
  (SELECT quantity FROM pharmfarm_stock WHERE member_key = @member_key AND insurance_code = @low_code LIMIT 1) AS low_substitute_quantity,
  (SELECT id FROM pharmfarm_stock WHERE member_key = @member_key AND insurance_code = @enough_code LIMIT 1) AS enough_substitute_stock_id,
  (SELECT quantity FROM pharmfarm_stock WHERE member_key = @member_key AND insurance_code = @enough_code LIMIT 1) AS enough_substitute_quantity,
  (SELECT id FROM pharmfarm_prescription_stock_deduction WHERE member_key = @member_key AND prescription_code = @prescription_code LIMIT 1) AS deduction_id;
