-- Library Doctor generation identity for idempotent enqueue.
-- generation_key is optional for manual proposals; unique when present.
-- SQLite UNIQUE allows multiple NULL values, so manual proposals are unaffected.

ALTER TABLE library_doctor_proposals ADD COLUMN generation_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_library_doctor_proposals_generation_key
ON library_doctor_proposals (generation_key);
