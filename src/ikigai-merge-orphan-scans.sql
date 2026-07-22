-- ============================================================
-- Ikigai orphan merge — run ONCE on the DB server (psql)
--
-- Deletes duplicate chapters from ikigai-fallback comic_scans
-- that have a real-team sibling. Real team wins; only chapters
-- with chapter_number > sibling max get reparented.
--
-- Run: psql "$DATABASE_URL" -f ikigai-merge-orphan-scans.sql
--
-- Safe to re-run (idempotent). ~4700 chapters, 140 orphan rows.
-- ============================================================

BEGIN;

-- 1. Reparent: move chapters newer than sibling's max to the sibling
UPDATE chapters c
SET comic_scan_id = sib.id
FROM comic_scans o
JOIN comic_scans sib
  ON sib.comic_id = o.comic_id
 AND sib.scan_group_id <> 1
LEFT JOIN (
  SELECT comic_scan_id, max(chapter_number) AS mx
  FROM chapters GROUP BY comic_scan_id
) sm ON sm.comic_scan_id = sib.id
WHERE c.comic_scan_id = o.id
  AND o.scan_group_id = 1
  AND c.chapter_number > COALESCE(sm.mx, 0);

-- 2. Delete: all remaining duplicate chapters under orphan scans
DELETE FROM chapters c
USING comic_scans o
WHERE c.comic_scan_id = o.id
  AND o.scan_group_id = 1
  AND EXISTS (
    SELECT 1 FROM comic_scans s
    WHERE s.comic_id = o.comic_id AND s.scan_group_id <> 1
  );

-- 3. Delete: the orphan comic_scans rows (only those with siblings)
DELETE FROM comic_scans o
WHERE o.scan_group_id = 1
  AND EXISTS (
    SELECT 1 FROM comic_scans s
    WHERE s.comic_id = o.comic_id AND s.scan_group_id <> 1
  );

COMMIT;

-- 4. Cleanup (optional but recommended after large delete)
VACUUM ANALYZE chapters;
VACUUM ANALYZE comic_scans;
