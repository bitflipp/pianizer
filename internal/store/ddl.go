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
  owner       VARCHAR(255)    NOT NULL DEFAULT '',
  name        VARCHAR(255)    NOT NULL,
  created_at  DATETIME(6)     NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_projects_owner_name (owner, name)
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

// Statements upgrading a pre-ownership projects table (name was globally
// unique, no owner column). Applied only when the owner column is missing.
const (
	ddlProjectsAddOwner    = `ALTER TABLE projects ADD COLUMN owner VARCHAR(255) NOT NULL DEFAULT '' AFTER id`
	ddlProjectsDropOldKey  = `ALTER TABLE projects DROP INDEX uq_projects_name`
	ddlProjectsAddOwnerKey = `ALTER TABLE projects ADD UNIQUE KEY uq_projects_owner_name (owner, name)`
)
