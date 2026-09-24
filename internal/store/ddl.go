package store

// Schema DDL, applied at startup with no migration framework — idempotent
// CREATE TABLE IF NOT EXISTS statements, parent table first so the foreign
// key in project_revisions has something to reference.
//
// Revision history entries are called "revisions" here to avoid colliding
// with the unrelated top-level `version: 1` field already present inside
// each saved project's own JSON document (a document-schema version, not a
// save-history version).
const (
	ddlProjects = `
CREATE TABLE IF NOT EXISTS projects (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(255)    NOT NULL,
  created_at  DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`

	ddlProjectRevisions = `
CREATE TABLE IF NOT EXISTS project_revisions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id   BIGINT UNSIGNED NOT NULL,
  revision_no  INT UNSIGNED    NOT NULL,
  data         LONGTEXT        NOT NULL CHECK (JSON_VALID(data)),
  size_bytes   INT UNSIGNED    NOT NULL,
  created_at   DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_revisions_project_no (project_id, revision_no),
  KEY idx_revisions_project_created (project_id, created_at),
  CONSTRAINT fk_revisions_project FOREIGN KEY (project_id)
    REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
)
