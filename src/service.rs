use std::{path::Path, sync::Arc};

use tokio::sync::broadcast;

use crate::{
    chart_export::{
        ChartDownload, ExportError, ExportOptions, ExportPlan, ExportRenderer, ExportTarget,
    },
    model::{ChangeEvent, ExplanationSummary, PublishRequest, StoredExplanation, validate_id},
    store::Store,
};

#[derive(Clone)]
pub struct AppService {
    store: Store,
    changes: broadcast::Sender<ChangeEvent>,
    exports: Arc<ExportRenderer>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServiceError {
    #[error("{0}")]
    Invalid(String),
    #[error("explanation not found")]
    NotFound,
    #[error("explanation changed; refresh the library before trying again")]
    Conflict,
    #[error("storage failure")]
    Storage(String),
}

impl AppService {
    pub async fn open(path: &Path) -> Result<Self, ServiceError> {
        let store = Store::open(path).await?;
        let (changes, _) = broadcast::channel(128);
        let exports = Arc::new(ExportRenderer::new(
            path.parent().unwrap_or(Path::new(".")).join("exports"),
        ));
        Ok(Self {
            store,
            changes,
            exports,
        })
    }

    pub async fn list(&self) -> Result<Vec<ExplanationSummary>, ServiceError> {
        self.store.list().await
    }

    pub async fn get(&self, id: &str) -> Result<StoredExplanation, ServiceError> {
        validate_id(id).map_err(ServiceError::Invalid)?;
        self.store.get(id).await
    }

    pub async fn export_chart(
        &self,
        id: &str,
        target: ExportTarget,
        options: ExportOptions,
        base_url: &str,
    ) -> Result<ChartDownload, ExportError> {
        let stored = self.get(id).await?;
        let plan = ExportPlan::new(stored.document, target, options)?;
        self.exports.render(plan, base_url).await
    }

    pub async fn publish(
        &self,
        id: &str,
        request: PublishRequest,
    ) -> Result<StoredExplanation, ServiceError> {
        self.publish_with_revision(id, request, None).await
    }

    pub async fn publish_with_revision(
        &self,
        id: &str,
        request: PublishRequest,
        expected_revision: Option<u64>,
    ) -> Result<StoredExplanation, ServiceError> {
        validate_id(id).map_err(ServiceError::Invalid)?;
        request.document.validate().map_err(ServiceError::Invalid)?;
        let id = id.to_owned();
        let store = self.store.clone();
        let changes = self.changes.clone();
        // Dropping a request must not interrupt COMMIT or its invalidation.
        tokio::spawn(async move {
            let stored = store
                .publish(&id, request.document, expected_revision)
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

    pub async fn delete(&self, id: &str) -> Result<ChangeEvent, ServiceError> {
        self.delete_with_revision(id, None).await
    }

    pub async fn delete_with_revision(
        &self,
        id: &str,
        expected_revision: Option<u64>,
    ) -> Result<ChangeEvent, ServiceError> {
        validate_id(id).map_err(ServiceError::Invalid)?;
        let id = id.to_owned();
        let store = self.store.clone();
        let changes = self.changes.clone();
        // Dropping a request must not interrupt COMMIT or its invalidation.
        tokio::spawn(async move {
            let event = store.delete(&id, expected_revision).await?;
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
