use std::{
    fs::OpenOptions,
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sqlx::{
    Row, SqlitePool,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow},
};

use crate::{
    model::{ChangeEvent, Explanation, ExplanationSummary, StoredExplanation},
    service::ServiceError,
};

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
}

impl Store {
    pub async fn open(path: &Path) -> Result<Self, ServiceError> {
        prepare_file(path).map_err(storage)?;
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(false)
            .journal_mode(SqliteJournalMode::Wal)
            .busy_timeout(Duration::from_secs(5));
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        // SQLite can reject a concurrent WAL transition without invoking its busy handler.
        let pool = loop {
            match SqlitePoolOptions::new()
                .max_connections(4)
                .connect_with(options.clone())
                .await
            {
                Ok(pool) => break pool,
                Err(error) if sqlite_busy(&error) && tokio::time::Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => return Err(storage(error)),
            }
        };
        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.map_err(storage)?;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&mut *transaction)
            .await
            .map_err(storage)?;
        match version {
            0 => {
                sqlx::query("CREATE TABLE explanations (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0), document_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0), deleted INTEGER NOT NULL DEFAULT 0)")
                    .execute(&mut *transaction).await.map_err(storage)?;
                sqlx::query("PRAGMA user_version = 2")
                    .execute(&mut *transaction)
                    .await
                    .map_err(storage)?;
            }
            1 => {
                sqlx::query(
                    "ALTER TABLE explanations ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0",
                )
                .execute(&mut *transaction)
                .await
                .map_err(storage)?;
                sqlx::query("PRAGMA user_version = 2")
                    .execute(&mut *transaction)
                    .await
                    .map_err(storage)?;
            }
            2 => (),
            _ => {
                return Err(ServiceError::Storage(format!(
                    "unsupported database schema version {version}"
                )));
            }
        }
        transaction.commit().await.map_err(storage)?;
        Ok(Self { pool })
    }

    pub async fn list(&self) -> Result<Vec<ExplanationSummary>, ServiceError> {
        let rows = sqlx::query(
            "SELECT id, revision, document_json, updated_at_ms FROM explanations WHERE deleted = 0 ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(storage)?;
        rows.iter()
            .map(|row| {
                let stored = decode(row)?;
                Ok(ExplanationSummary {
                    id: stored.id,
                    title: stored.document.title,
                    description: stored.document.description,
                    revision: stored.revision,
                    updated_at_ms: stored.updated_at_ms,
                    diagram_count: stored.document.diagrams.len(),
                    scenario_count: stored.document.scenarios.len(),
                    link_count: stored.document.links.len(),
                })
            })
            .collect()
    }

    pub async fn get(&self, id: &str) -> Result<StoredExplanation, ServiceError> {
        let row = sqlx::query(
            "SELECT id, revision, document_json, updated_at_ms FROM explanations WHERE id = ? AND deleted = 0",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(storage)?
        .ok_or(ServiceError::NotFound)?;
        decode(&row)
    }

    pub(crate) async fn publish(
        &self,
        id: &str,
        document: Explanation,
        expected_revision: Option<u64>,
    ) -> Result<StoredExplanation, ServiceError> {
        let timestamp = timestamp()?;
        let json = serde_json::to_string(&document).map_err(storage)?;
        let mut transaction = self.pool.begin().await.map_err(storage)?;
        let revision = if let Some(expected) = expected_revision {
            let expected = i64::try_from(expected).map_err(|_| ServiceError::Conflict)?;
            sqlx::query_scalar::<_, i64>("UPDATE explanations SET revision = revision + 1, document_json = ?, updated_at_ms = ?, deleted = 0 WHERE id = ? AND revision = ? AND revision < 9223372036854775807 RETURNING revision")
                .bind(&json).bind(timestamp).bind(id).bind(expected)
                .fetch_optional(&mut *transaction).await.map_err(storage)?
                .ok_or(ServiceError::Conflict)?
        } else {
            sqlx::query_scalar::<_, i64>("INSERT INTO explanations (id, revision, document_json, updated_at_ms) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = explanations.revision + 1, document_json = excluded.document_json, updated_at_ms = excluded.updated_at_ms, deleted = 0 WHERE explanations.revision < 9223372036854775807 RETURNING revision")
            .bind(id).bind(&json).bind(timestamp).fetch_optional(&mut *transaction).await
            .map_err(storage)?
            .ok_or_else(|| ServiceError::Invalid("explanation update limit reached".into()))?
        };
        transaction.commit().await.map_err(storage)?;
        Ok(StoredExplanation {
            id: id.into(),
            revision: revision as u64,
            updated_at_ms: timestamp as u64,
            document,
        })
    }

    pub(crate) async fn delete(
        &self,
        id: &str,
        expected_revision: Option<u64>,
    ) -> Result<ChangeEvent, ServiceError> {
        let expected = expected_revision
            .map(i64::try_from)
            .transpose()
            .map_err(|_| ServiceError::Conflict)?;
        let timestamp = timestamp()?;
        let mut transaction = self.pool.begin().await.map_err(storage)?;
        let revision: Option<i64> = sqlx::query_scalar("UPDATE explanations SET deleted = 1, document_json = 'null', revision = revision + 1, updated_at_ms = ? WHERE id = ? AND deleted = 0 AND (? IS NULL OR revision = ?) AND revision < 9223372036854775807 RETURNING revision")
            .bind(timestamp).bind(id).bind(expected).bind(expected)
            .fetch_optional(&mut *transaction).await.map_err(storage)?;
        let Some(revision) = revision else {
            if expected.is_some() {
                return Err(ServiceError::Conflict);
            }
            let live: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM explanations WHERE id = ? AND deleted = 0)",
            )
            .bind(id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(storage)?;
            return Err(if live {
                ServiceError::Invalid("explanation update limit reached".into())
            } else {
                ServiceError::NotFound
            });
        };
        transaction.commit().await.map_err(storage)?;
        Ok(ChangeEvent {
            id: id.into(),
            revision: revision as u64,
            deleted: true,
        })
    }
}

fn timestamp() -> Result<i64, ServiceError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(storage)?
        .as_millis();
    i64::try_from(millis).map_err(storage)
}

fn decode(row: &SqliteRow) -> Result<StoredExplanation, ServiceError> {
    let revision: i64 = row.try_get("revision").map_err(storage)?;
    let timestamp: i64 = row.try_get("updated_at_ms").map_err(storage)?;
    let json: String = row.try_get("document_json").map_err(storage)?;
    let mut document: Explanation = serde_json::from_str(&json).map_err(storage)?;
    for relationship in &mut document.domain.relationships {
        relationship.source_cardinality = relationship.source_cardinality.explicit();
        relationship.target_cardinality = relationship.target_cardinality.explicit();
    }
    Ok(StoredExplanation {
        id: row.try_get("id").map_err(storage)?,
        revision: u64::try_from(revision).map_err(storage)?,
        updated_at_ms: u64::try_from(timestamp).map_err(storage)?,
        document,
    })
}

fn prepare_file(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(std::io::Error::other(
                    "database path must be a regular file, not a symlink",
                ));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(path) {
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    return prepare_file(path);
                }
                Err(error) => return Err(error),
            }
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

fn storage(error: impl std::fmt::Display) -> ServiceError {
    ServiceError::Storage(error.to_string())
}

fn sqlite_busy(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|error| error.code())
        .and_then(|code| code.parse::<i32>().ok())
        .is_some_and(|code| matches!(code & 0xff, 5 | 6))
}
