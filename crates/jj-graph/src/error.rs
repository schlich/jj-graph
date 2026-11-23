//! The error every jj-graph request can fail with: a message for the user
//! and the HTTP status it maps to.

use crate::repo::ReadError;

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub status: u16,
    pub message: String,
}

impl AppError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    /// A 400: the request or the command it names is at fault.
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }

    pub fn not_found() -> Self {
        Self::new(404, "Not found.")
    }
}

impl From<ReadError> for AppError {
    fn from(err: ReadError) -> Self {
        Self::bad(err.0)
    }
}

pub type AppResult<T> = Result<T, AppError>;
