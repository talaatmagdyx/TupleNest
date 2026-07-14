//! Normalized error model (master spec §54).
//!
//! Drivers must map native failures into this taxonomy so the rest of the
//! product never branches on database-specific error strings.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    Configuration,
    Dns,
    Network,
    Proxy,
    Ssh,
    Tls,
    Authentication,
    Authorization,
    DatabaseMissing,
    SchemaMissing,
    Syntax,
    ConstraintViolation,
    Deadlock,
    LockTimeout,
    StatementTimeout,
    ConnectionTimeout,
    Cancelled,
    ResourceExhausted,
    DiskFull,
    ReadOnlyViolation,
    SerializationConflict,
    Unsupported,
    DriverFailure,
    Internal,
}

impl ErrorCategory {
    /// Whether retrying the same operation may succeed without user changes.
    pub fn default_retryability(self) -> Retryability {
        use ErrorCategory::*;
        match self {
            Network | ConnectionTimeout | Deadlock | LockTimeout | SerializationConflict => {
                Retryability::Retryable
            }
            Dns | Proxy | Ssh | ResourceExhausted | DiskFull => Retryability::MaybeRetryable,
            _ => Retryability::NotRetryable,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retryability {
    Retryable,
    MaybeRetryable,
    NotRetryable,
}

/// A normalized driver error, safe to serialize to the frontend.
///
/// Invariant: no field may ever contain credentials or secret parameters.
#[derive(Debug, Clone, Error, Serialize, Deserialize)]
#[error("{title}")]
pub struct DriverError {
    pub category: ErrorCategory,
    /// Short user-facing title, e.g. "Authentication failed".
    pub title: String,
    /// Longer user-facing explanation.
    pub explanation: String,
    /// Database-native error code (e.g. SQLSTATE), if any.
    pub native_code: Option<String>,
    /// Original driver/database message (sanitized).
    pub original_message: Option<String>,
    pub retryability: Retryability,
    /// Byte range in the submitted query this error relates to, if known.
    pub query_range: Option<(usize, usize)>,
    /// Suggested user actions, in priority order.
    pub suggested_actions: Vec<String>,
}

impl DriverError {
    pub fn new(category: ErrorCategory, title: impl Into<String>) -> Self {
        Self {
            category,
            title: title.into(),
            explanation: String::new(),
            native_code: None,
            original_message: None,
            retryability: category.default_retryability(),
            query_range: None,
            suggested_actions: Vec::new(),
        }
    }

    pub fn with_explanation(mut self, explanation: impl Into<String>) -> Self {
        self.explanation = explanation.into();
        self
    }

    pub fn with_native_code(mut self, code: impl Into<String>) -> Self {
        self.native_code = Some(code.into());
        self
    }

    pub fn with_original_message(mut self, message: impl Into<String>) -> Self {
        self.original_message = Some(message.into());
        self
    }

    pub fn with_query_range(mut self, start: usize, end: usize) -> Self {
        self.query_range = Some((start, end));
        self
    }

    pub fn with_suggested_action(mut self, action: impl Into<String>) -> Self {
        self.suggested_actions.push(action.into());
        self
    }

    pub fn cancelled() -> Self {
        Self::new(ErrorCategory::Cancelled, "Query cancelled")
            .with_explanation("The operation was cancelled before it completed.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadlock_is_retryable_by_default() {
        let err = DriverError::new(ErrorCategory::Deadlock, "Deadlock detected");
        assert_eq!(err.retryability, Retryability::Retryable);
    }

    #[test]
    fn syntax_error_is_not_retryable() {
        let err = DriverError::new(ErrorCategory::Syntax, "Syntax error")
            .with_native_code("42601")
            .with_query_range(10, 15);
        assert_eq!(err.retryability, Retryability::NotRetryable);
        assert_eq!(err.query_range, Some((10, 15)));
    }

    #[test]
    fn serializes_snake_case_categories() {
        let json = serde_json::to_string(&ErrorCategory::ConstraintViolation).unwrap();
        assert_eq!(json, "\"constraint_violation\"");
    }
}
