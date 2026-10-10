use std::path::Path;

use tokio::sync::broadcast;

use crate::{
    model::{
        ChangeEvent, DeleteRequest, ExplanationSummary, PublishRequest, StoredExplanation,
        validate_id,
    },
    store::Store,
};

#[derive(Clone)]
pub struct AppService {
    store: Store,
    changes: broadcast::Sender<ChangeEvent>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Invalid(String),
    #[error("explanation not found")]
    NotFound,
    #[error("revision conflict")]
    Conflict,
    #[error("storage failure")]
    Storage(String),
}

impl AppService {
    pub async fn open(path: &Path) -> Result<Self, ServiceError> {
        let store = Store::open(path).await?;
        let (changes, _) = broadcast::channel(128);
        Ok(Self { store, changes })
    }

    pub async fn list(&self) -> Result<Vec<ExplanationSummary>, ServiceError> {
        self.store.list().await
    }

    pub async fn get(&self, id: &str) -> Result<StoredExplanation, ServiceError> {
        validate_id(id).map_err(ServiceError::Invalid)?;
        self.store.get(id).await
    }

    pub async fn publish(
        &self,
        id: &str,
        request: PublishRequest,
    ) -> Result<StoredExplanation, ServiceError> {
        validate_id(id).map_err(ServiceError::Invalid)?;
        request.document.validate().map_err(ServiceError::Invalid)?;
        validate_revision(request.expected_revision)?;
        let id = id.to_owned();
        let store = self.store.clone();
        let changes = self.changes.clone();
        // Dropping a request must not interrupt COMMIT or its invalidation.
        tokio::spawn(async move {
            let stored = store
                .publish(&id, request.expected_revision, request.document)
                .await?;
            let _ = changes.send(ChangeEvent {
                id: stored.id.clone(),
                revision: stored.revision,
                deleted: false,
            });
            Ok(stored)
        })
        .await
        .map_err(|_| ServiceError::Storage("publication task failed".into()))?
    }

    pub async fn delete(
        &self,
        id: &str,
        request: DeleteRequest,
    ) -> Result<ChangeEvent, ServiceError> {
        validate_id(id).map_err(ServiceError::Invalid)?;
        if request.expected_revision == 0 {
            return Err(ServiceError::Invalid(
                "expectedRevision must be positive".into(),
            ));
        }
        validate_revision(request.expected_revision)?;
        let id = id.to_owned();
        let store = self.store.clone();
        let changes = self.changes.clone();
        // Dropping a request must not interrupt COMMIT or its invalidation.
        tokio::spawn(async move {
            let event = store.delete(&id, request.expected_revision).await?;
            let _ = changes.send(event.clone());
            Ok(event)
        })
        .await
        .map_err(|_| ServiceError::Storage("deletion task failed".into()))?
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.changes.subscribe()
    }
}

fn validate_revision(expected_revision: u64) -> Result<(), ServiceError> {
    if expected_revision >= i64::MAX as u64 {
        return Err(ServiceError::Invalid(
            "expectedRevision must be below SQLite integer maximum".into(),
        ));
    }
    Ok(())
}
