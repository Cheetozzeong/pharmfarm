SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @target_member_key := COALESCE(@target_member_key, '2');
SET @source_member_key := COALESCE(
  @source_member_key,
  (SELECT CAST(pharmacy_id AS CHAR) FROM __pf_import_agent_prescription_line LIMIT 1),
  @target_member_key
);
SET @target_account_id := COALESCE(@target_account_id, CAST(@target_member_key AS UNSIGNED));
SET @replace_existing := COALESCE(@replace_existing, 1);

START TRANSACTION;

DROP TEMPORARY TABLE IF EXISTS __pf_import_codes;
CREATE TEMPORARY TABLE __pf_import_codes (
  prescription_code VARCHAR(64) NOT NULL,
  PRIMARY KEY (prescription_code)
);

INSERT IGNORE INTO __pf_import_codes (prescription_code)
SELECT DISTINCT prescription_code
FROM __pf_import_prescription
WHERE prescription_code <> '';

INSERT IGNORE INTO __pf_import_codes (prescription_code)
SELECT DISTINCT prescription_code
FROM __pf_import_prescription_stock_deduction
WHERE prescription_code <> ''
  AND prescription_code <> '대체 약품 부족 수량';

DROP TEMPORARY TABLE IF EXISTS __pf_prescription_stage;
CREATE TEMPORARY TABLE __pf_prescription_stage AS
SELECT
  p.*,
  CASE
    WHEN p.prescription_group_id = CONCAT('agent-pharmacy-', @source_member_key, '-', p.prescription_code)
      THEN CONCAT('agent-pharmacy-', @target_member_key, '-', p.prescription_code)
    ELSE p.prescription_group_id
  END AS target_prescription_group_id
FROM __pf_import_prescription p;

DROP TEMPORARY TABLE IF EXISTS __pf_old_prescription_ids;
CREATE TEMPORARY TABLE __pf_old_prescription_ids (
  id BIGINT NOT NULL,
  PRIMARY KEY (id)
);

INSERT IGNORE INTO __pf_old_prescription_ids (id)
SELECT p.id
FROM pharmfarm_prescription p
JOIN __pf_prescription_stage s
  ON s.prescription_code = p.prescription_code
 AND s.target_prescription_group_id = p.prescription_group_id;

INSERT IGNORE INTO __pf_old_prescription_ids (id)
SELECT d.prescription_id
FROM pharmfarm_prescription_stock_deduction d
JOIN __pf_import_codes c ON c.prescription_code = d.prescription_code
WHERE d.member_key = @target_member_key
  AND d.prescription_id IS NOT NULL;

DROP TEMPORARY TABLE IF EXISTS __pf_old_deduction_ids;
CREATE TEMPORARY TABLE __pf_old_deduction_ids (
  id BIGINT NOT NULL,
  PRIMARY KEY (id)
);

INSERT IGNORE INTO __pf_old_deduction_ids (id)
SELECT d.id
FROM pharmfarm_prescription_stock_deduction d
JOIN __pf_import_codes c ON c.prescription_code = d.prescription_code
WHERE d.member_key = @target_member_key;

INSERT IGNORE INTO __pf_old_deduction_ids (id)
SELECT d.id
FROM pharmfarm_prescription_stock_deduction d
JOIN __pf_old_prescription_ids p ON p.id = d.prescription_id
WHERE d.member_key = @target_member_key
  AND d.prescription_code = '대체 약품 부족 수량';

DELETE m
FROM pharmfarm_stock_movement m
LEFT JOIN __pf_import_codes c
  ON c.prescription_code = m.reference_id
LEFT JOIN __pf_old_deduction_ids od
  ON CAST(od.id AS CHAR) = m.reference_id
WHERE @replace_existing = 1
  AND m.member_key = @target_member_key
  AND (
    (m.reference_type IN ('PRESCRIPTION', 'PRESCRIPTION_OVERWRITE') AND c.prescription_code IS NOT NULL)
    OR (m.reference_type IN ('PRESCRIPTION_DEDUCTION', 'PRESCRIPTION_SHORTAGE') AND od.id IS NOT NULL)
  );

DELETE d
FROM pharmfarm_prescription_stock_deduction d
JOIN __pf_old_deduction_ids od ON od.id = d.id
WHERE @replace_existing = 1;

DELETE l
FROM pharmfarm_agent_prescription_line l
JOIN __pf_import_codes c ON c.prescription_code = l.prescription_code
WHERE @replace_existing = 1
  AND l.pharmacy_id = CAST(@target_member_key AS UNSIGNED);

DELETE d
FROM pharmfarm_prescription_drug d
JOIN __pf_old_prescription_ids p ON p.id = d.prescription_id
WHERE @replace_existing = 1;

DELETE p
FROM pharmfarm_prescription p
JOIN __pf_old_prescription_ids old_p ON old_p.id = p.id
WHERE @replace_existing = 1;

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
  merged_to_stock_id,
  created_at,
  updated_at
)
SELECT
  @target_member_key,
  s.code_type,
  s.insurance_code,
  s.drug_name,
  s.drug_name_normalized,
  s.price,
  s.quantity,
  s.product_total_quantity,
  s.match_status,
  s.virtual_stock,
  COALESCE(@target_account_id, s.created_by_account_id),
  s.active,
  NULL,
  COALESCE(s.created_at, NOW()),
  COALESCE(s.updated_at, NOW())
FROM __pf_import_stock s
WHERE s.insurance_code <> ''
ON DUPLICATE KEY UPDATE
  code_type = VALUES(code_type),
  drug_name = VALUES(drug_name),
  drug_name_normalized = VALUES(drug_name_normalized),
  price = VALUES(price),
  quantity = VALUES(quantity),
  product_total_quantity = VALUES(product_total_quantity),
  match_status = VALUES(match_status),
  virtual_stock = VALUES(virtual_stock),
  created_by_account_id = VALUES(created_by_account_id),
  active = VALUES(active),
  merged_to_stock_id = NULL,
  updated_at = VALUES(updated_at);

DROP TEMPORARY TABLE IF EXISTS __pf_stock_map;
CREATE TEMPORARY TABLE __pf_stock_map (
  source_stock_id BIGINT NOT NULL,
  target_stock_id BIGINT NOT NULL,
  PRIMARY KEY (source_stock_id),
  INDEX idx_target_stock_id (target_stock_id)
);

INSERT INTO __pf_stock_map (source_stock_id, target_stock_id)
SELECT s.id, t.id
FROM __pf_import_stock s
JOIN pharmfarm_stock t
  ON t.member_key = @target_member_key
 AND t.insurance_code = s.insurance_code;

INSERT INTO pharmfarm_prescription (
  sample_id,
  prescription_code,
  prescription_group_id,
  prescription_group_label,
  qr_type,
  raw_qr_hash,
  raw_qr_text,
  source,
  drug_count,
  captured_at,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  NULL,
  p.prescription_code,
  p.target_prescription_group_id,
  p.prescription_group_label,
  p.qr_type,
  p.raw_qr_hash,
  NULL,
  p.source,
  p.drug_count,
  p.captured_at,
  COALESCE(p.created_at, NOW(6)),
  COALESCE(p.updated_at, NOW(6)),
  p.deleted_at
FROM __pf_prescription_stage p;

DROP TEMPORARY TABLE IF EXISTS __pf_prescription_map;
CREATE TEMPORARY TABLE __pf_prescription_map (
  source_prescription_id BIGINT NOT NULL,
  target_prescription_id BIGINT NOT NULL,
  PRIMARY KEY (source_prescription_id),
  INDEX idx_target_prescription_id (target_prescription_id)
);

INSERT INTO __pf_prescription_map (source_prescription_id, target_prescription_id)
SELECT s.id, MAX(t.id)
FROM __pf_prescription_stage s
JOIN pharmfarm_prescription t
  ON t.prescription_code = s.prescription_code
 AND t.prescription_group_id = s.target_prescription_group_id
GROUP BY s.id;

INSERT INTO pharmfarm_prescription_drug (
  prescription_id,
  line_no,
  insurance_code,
  drug_name,
  quantity_per_dose,
  daily_frequency,
  medication_days,
  total_quantity,
  pd_extype,
  pd_exrow,
  pd_element,
  substitution_role,
  memo,
  raw_json,
  created_at,
  updated_at,
  deleted_at
)
SELECT
  pm.target_prescription_id,
  d.line_no,
  d.insurance_code,
  d.drug_name,
  d.quantity_per_dose,
  d.daily_frequency,
  d.medication_days,
  d.total_quantity,
  d.pd_extype,
  d.pd_exrow,
  d.pd_element,
  d.substitution_role,
  d.memo,
  COALESCE(d.raw_json, JSON_OBJECT()),
  COALESCE(d.created_at, NOW(6)),
  COALESCE(d.updated_at, NOW(6)),
  d.deleted_at
FROM __pf_import_prescription_drug d
JOIN __pf_prescription_map pm ON pm.source_prescription_id = d.prescription_id;

INSERT INTO pharmfarm_agent_prescription_line (
  pharmacy_id,
  prescription_code,
  line_no,
  dosed_at,
  insurance_code,
  drug_name,
  dose,
  daily_count,
  medication_days,
  total_amount,
  pd_extype,
  pd_exrow,
  pd_element,
  substitution_role,
  raw_json,
  captured_at,
  created_at,
  updated_at
)
SELECT
  CAST(@target_member_key AS UNSIGNED),
  l.prescription_code,
  l.line_no,
  l.dosed_at,
  l.insurance_code,
  l.drug_name,
  l.dose,
  l.daily_count,
  l.medication_days,
  l.total_amount,
  l.pd_extype,
  l.pd_exrow,
  l.pd_element,
  l.substitution_role,
  l.raw_json,
  l.captured_at,
  COALESCE(l.created_at, NOW()),
  COALESCE(l.updated_at, NOW())
FROM __pf_import_agent_prescription_line l
ON DUPLICATE KEY UPDATE
  dosed_at = VALUES(dosed_at),
  insurance_code = VALUES(insurance_code),
  drug_name = VALUES(drug_name),
  dose = VALUES(dose),
  daily_count = VALUES(daily_count),
  medication_days = VALUES(medication_days),
  total_amount = VALUES(total_amount),
  pd_extype = VALUES(pd_extype),
  pd_exrow = VALUES(pd_exrow),
  pd_element = VALUES(pd_element),
  substitution_role = VALUES(substitution_role),
  raw_json = VALUES(raw_json),
  captured_at = VALUES(captured_at),
  updated_at = VALUES(updated_at);

DROP TEMPORARY TABLE IF EXISTS __pf_deduction_stage;
CREATE TEMPORARY TABLE __pf_deduction_stage AS
SELECT
  d.*,
  CASE
    WHEN d.prescription_code = '대체 약품 부족 수량'
      AND d.line_no REGEXP '^[0-9]+$'
      AND line_stock_map.target_stock_id IS NOT NULL
      THEN CAST(line_stock_map.target_stock_id AS CHAR)
    ELSE d.line_no
  END AS target_line_no,
  pm.target_prescription_id,
  stock_map.target_stock_id,
  substitute_map.target_stock_id AS target_substitute_stock_id
FROM __pf_import_prescription_stock_deduction d
LEFT JOIN __pf_prescription_map pm ON pm.source_prescription_id = d.prescription_id
LEFT JOIN __pf_stock_map stock_map ON stock_map.source_stock_id = d.stock_id
LEFT JOIN __pf_stock_map substitute_map ON substitute_map.source_stock_id = d.substitute_stock_id
LEFT JOIN __pf_stock_map line_stock_map
  ON d.prescription_code = '대체 약품 부족 수량'
 AND d.line_no REGEXP '^[0-9]+$'
 AND line_stock_map.source_stock_id = CAST(d.line_no AS UNSIGNED);

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
  substitute_stock_id,
  substitute_quantity,
  substitute_stock_before_quantity,
  substitute_stock_after_quantity,
  substitute_processed_at,
  memo,
  raw_json,
  resolved_at,
  shortage_resolved_at,
  created_at,
  updated_at
)
SELECT
  @target_member_key,
  ds.target_prescription_id,
  ds.prescription_code,
  ds.target_line_no,
  ds.insurance_code,
  ds.drug_name,
  ds.drug_name_normalized,
  ds.deduct_quantity,
  ds.deducted_quantity,
  ds.shortage_quantity,
  ds.stock_before_quantity,
  ds.stock_after_quantity,
  ds.status,
  ds.resolution_type,
  ds.shortage_status,
  ds.failure_reason,
  ds.target_stock_id,
  ds.target_substitute_stock_id,
  ds.substitute_quantity,
  ds.substitute_stock_before_quantity,
  ds.substitute_stock_after_quantity,
  ds.substitute_processed_at,
  ds.memo,
  ds.raw_json,
  ds.resolved_at,
  ds.shortage_resolved_at,
  COALESCE(ds.created_at, NOW()),
  COALESCE(ds.updated_at, NOW())
FROM __pf_deduction_stage ds;

DROP TEMPORARY TABLE IF EXISTS __pf_deduction_map;
CREATE TEMPORARY TABLE __pf_deduction_map (
  source_deduction_id BIGINT NOT NULL,
  target_deduction_id BIGINT NOT NULL,
  PRIMARY KEY (source_deduction_id),
  INDEX idx_target_deduction_id (target_deduction_id)
);

INSERT INTO __pf_deduction_map (source_deduction_id, target_deduction_id)
SELECT ds.id, t.id
FROM __pf_deduction_stage ds
JOIN pharmfarm_prescription_stock_deduction t
  ON t.member_key = @target_member_key
 AND t.prescription_code = ds.prescription_code
 AND t.line_no = ds.target_line_no;

DELETE m
FROM pharmfarm_stock_movement m
LEFT JOIN __pf_import_codes c
  ON c.prescription_code = m.reference_id
LEFT JOIN __pf_deduction_map dm
  ON CAST(dm.target_deduction_id AS CHAR) = m.reference_id
WHERE m.member_key = @target_member_key
  AND (
    (m.reference_type IN ('PRESCRIPTION', 'PRESCRIPTION_OVERWRITE') AND c.prescription_code IS NOT NULL)
    OR (m.reference_type IN ('PRESCRIPTION_DEDUCTION', 'PRESCRIPTION_SHORTAGE') AND dm.target_deduction_id IS NOT NULL)
  );

INSERT INTO pharmfarm_stock_movement (
  member_key,
  stock_id,
  stock_item_id,
  purchase_history_id,
  movement_type,
  match_type,
  before_quantity,
  change_quantity,
  after_quantity,
  reason,
  reference_type,
  reference_id,
  drug_name_snapshot,
  insurance_code_snapshot,
  price_snapshot,
  wholesaler_name_snapshot,
  created_by,
  created_by_account_id,
  created_at
)
SELECT
  @target_member_key,
  sm.target_stock_id,
  NULL,
  NULL,
  m.movement_type,
  m.match_type,
  m.before_quantity,
  m.change_quantity,
  m.after_quantity,
  m.reason,
  m.reference_type,
  CASE
    WHEN m.reference_type IN ('PRESCRIPTION_DEDUCTION', 'PRESCRIPTION_SHORTAGE')
      AND dm.target_deduction_id IS NOT NULL
      THEN CAST(dm.target_deduction_id AS CHAR)
    ELSE m.reference_id
  END,
  m.drug_name_snapshot,
  m.insurance_code_snapshot,
  m.price_snapshot,
  m.wholesaler_name_snapshot,
  @target_member_key,
  @target_account_id,
  COALESCE(m.created_at, NOW())
FROM __pf_import_stock_movement m
JOIN __pf_stock_map sm ON sm.source_stock_id = m.stock_id
LEFT JOIN __pf_deduction_map dm
  ON m.reference_id REGEXP '^[0-9]+$'
 AND dm.source_deduction_id = CAST(m.reference_id AS UNSIGNED);

COMMIT;

SELECT
  @target_member_key AS target_member_key,
  (SELECT COUNT(*) FROM __pf_import_stock) AS staged_stock_rows,
  (SELECT COUNT(*) FROM __pf_import_prescription) AS staged_prescription_rows,
  (SELECT COUNT(*) FROM __pf_import_prescription_drug) AS staged_prescription_drug_rows,
  (SELECT COUNT(*) FROM __pf_import_prescription_stock_deduction) AS staged_deduction_rows,
  (SELECT COUNT(*) FROM __pf_import_stock_movement) AS staged_movement_rows,
  (SELECT COUNT(*) FROM pharmfarm_prescription_stock_deduction d JOIN __pf_import_codes c ON c.prescription_code = d.prescription_code WHERE d.member_key = @target_member_key) AS imported_deduction_rows;
