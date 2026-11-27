//! SQLite failures mapped into the driver-api taxonomy (spec §54).
//!
//! The extended result code goes where PostgreSQL puts its SQLSTATE
//! (`native_code`), by name: `SQLITE_CONSTRAINT_UNIQUE` says more than 2067.

use rusqlite::ffi;
use tuplenest_driver_api::{DriverError, ErrorCategory};

/// The name SQLite's own headers give an extended result code.
pub fn code_name(extended: i32) -> String {
    let name = match extended {
        ffi::SQLITE_ERROR => "SQLITE_ERROR",
        ffi::SQLITE_INTERNAL => "SQLITE_INTERNAL",
        ffi::SQLITE_PERM => "SQLITE_PERM",
        ffi::SQLITE_ABORT => "SQLITE_ABORT",
        ffi::SQLITE_BUSY => "SQLITE_BUSY",
        ffi::SQLITE_LOCKED => "SQLITE_LOCKED",
        ffi::SQLITE_NOMEM => "SQLITE_NOMEM",
        ffi::SQLITE_READONLY => "SQLITE_READONLY",
        ffi::SQLITE_INTERRUPT => "SQLITE_INTERRUPT",
        ffi::SQLITE_IOERR => "SQLITE_IOERR",
        ffi::SQLITE_CORRUPT => "SQLITE_CORRUPT",
        ffi::SQLITE_FULL => "SQLITE_FULL",
        ffi::SQLITE_CANTOPEN => "SQLITE_CANTOPEN",
        ffi::SQLITE_PROTOCOL => "SQLITE_PROTOCOL",
        ffi::SQLITE_SCHEMA => "SQLITE_SCHEMA",
        ffi::SQLITE_TOOBIG => "SQLITE_TOOBIG",
        ffi::SQLITE_CONSTRAINT => "SQLITE_CONSTRAINT",
        ffi::SQLITE_MISMATCH => "SQLITE_MISMATCH",
        ffi::SQLITE_MISUSE => "SQLITE_MISUSE",
        ffi::SQLITE_AUTH => "SQLITE_AUTH",
        ffi::SQLITE_RANGE => "SQLITE_RANGE",
        ffi::SQLITE_NOTADB => "SQLITE_NOTADB",
        ffi::SQLITE_CONSTRAINT_CHECK => "SQLITE_CONSTRAINT_CHECK",
        ffi::SQLITE_CONSTRAINT_FOREIGNKEY => "SQLITE_CONSTRAINT_FOREIGNKEY",
        ffi::SQLITE_CONSTRAINT_NOTNULL => "SQLITE_CONSTRAINT_NOTNULL",
        ffi::SQLITE_CONSTRAINT_PRIMARYKEY => "SQLITE_CONSTRAINT_PRIMARYKEY",
        ffi::SQLITE_CONSTRAINT_UNIQUE => "SQLITE_CONSTRAINT_UNIQUE",
        ffi::SQLITE_CONSTRAINT_TRIGGER => "SQLITE_CONSTRAINT_TRIGGER",
        ffi::SQLITE_CONSTRAINT_ROWID => "SQLITE_CONSTRAINT_ROWID",
        ffi::SQLITE_CONSTRAINT_DATATYPE => "SQLITE_CONSTRAINT_DATATYPE",
        ffi::SQLITE_READONLY_DBMOVED => "SQLITE_READONLY_DBMOVED",
        ffi::SQLITE_READONLY_DIRECTORY => "SQLITE_READONLY_DIRECTORY",
        ffi::SQLITE_BUSY_SNAPSHOT => "SQLITE_BUSY_SNAPSHOT",
        ffi::SQLITE_BUSY_TIMEOUT => "SQLITE_BUSY_TIMEOUT",
        ffi::SQLITE_CANTOPEN_ISDIR => "SQLITE_CANTOPEN_ISDIR",
        ffi::SQLITE_CANTOPEN_FULLPATH => "SQLITE_CANTOPEN_FULLPATH",
        ffi::SQLITE_IOERR_READ => "SQLITE_IOERR_READ",
        ffi::SQLITE_IOERR_WRITE => "SQLITE_IOERR_WRITE",
        _ => return format!("SQLITE_{extended}"),
    };
    name.to_string()
}

/// Category and title for a primary result code (and its message).
fn classify(primary: i32, message: &str) -> (ErrorCategory, &'static str) {
    let lower = message.to_ascii_lowercase();
    match primary {
        ffi::SQLITE_INTERRUPT => (ErrorCategory::Cancelled, "Query cancelled"),
        ffi::SQLITE_READONLY => (ErrorCategory::ReadOnlyViolation, "Read-only database"),
        ffi::SQLITE_CONSTRAINT => (ErrorCategory::ConstraintViolation, "Constraint violation"),
        ffi::SQLITE_BUSY | ffi::SQLITE_LOCKED => (ErrorCategory::LockTimeout, "Database is locked"),
        ffi::SQLITE_CANTOPEN => (
            ErrorCategory::DatabaseMissing,
            "Cannot open the database file",
        ),
        ffi::SQLITE_NOTADB => (ErrorCategory::Configuration, "Not a SQLite database"),
        ffi::SQLITE_CORRUPT => (ErrorCategory::DriverFailure, "Database file is damaged"),
        ffi::SQLITE_FULL => (ErrorCategory::DiskFull, "Disk full"),
        ffi::SQLITE_PERM | ffi::SQLITE_AUTH => (ErrorCategory::Authorization, "Permission denied"),
        ffi::SQLITE_NOMEM | ffi::SQLITE_TOOBIG => {
            (ErrorCategory::ResourceExhausted, "Out of memory")
        }
        ffi::SQLITE_IOERR => (ErrorCategory::DriverFailure, "Disk I/O error"),
        ffi::SQLITE_MISMATCH => (ErrorCategory::ConstraintViolation, "Datatype mismatch"),
        _ if lower.contains("no such table") || lower.contains("no such view") => {
            (ErrorCategory::SchemaMissing, "Relation not found")
        }
        _ if lower.contains("no such column") => (ErrorCategory::Syntax, "Column not found"),
        _ if lower.contains("syntax error") || lower.contains("incomplete input") => {
            (ErrorCategory::Syntax, "Syntax error")
        }
        _ if lower.contains("attempt to write a readonly database") => {
            (ErrorCategory::ReadOnlyViolation, "Read-only database")
        }
        _ => (ErrorCategory::DriverFailure, "Database error"),
    }
}

/// Map a rusqlite error, with the SQL it was about when there is one.
pub fn normalize(e: rusqlite::Error) -> Box<DriverError> {
    match e {
        rusqlite::Error::SqliteFailure(err, msg) => {
            let message = msg.unwrap_or_else(|| err.to_string());
            let (category, title) = classify(err.extended_code & 0xff, &message);
            DriverError::new(category, title)
                .with_native_code(code_name(err.extended_code))
                .with_original_message(message)
                .into()
        }
        rusqlite::Error::SqlInputError {
            error, msg, offset, ..
        } => {
            let (category, title) = classify(error.extended_code & 0xff, &msg);
            let start = offset.max(0) as usize;
            DriverError::new(category, title)
                .with_native_code(code_name(error.extended_code))
                .with_original_message(msg)
                .with_query_range(start, start + 1)
                .into()
        }
        rusqlite::Error::MultipleStatement => {
            DriverError::new(ErrorCategory::Syntax, "One statement at a time")
                .with_explanation(
                    "SQLite runs one statement per request; the text holds more than one. \
                     Nothing was run.",
                )
                .into()
        }
        rusqlite::Error::InvalidParameterCount(given, expected) => {
            DriverError::new(ErrorCategory::Configuration, "Wrong number of parameters")
                .with_original_message(format!("{given} given, {expected} expected"))
                .into()
        }
        other => DriverError::new(ErrorCategory::DriverFailure, "Driver error")
            .with_original_message(other.to_string())
            .into(),
    }
}

/// The refusal for a statement that would write on a read-only profile.
pub fn read_only_refusal() -> Box<DriverError> {
    DriverError::new(
        ErrorCategory::ReadOnlyViolation,
        "This connection is read-only: the statement writes, so it was refused. Nothing was run.",
    )
    .with_native_code(code_name(ffi::SQLITE_READONLY))
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_extended_codes() {
        assert_eq!(
            code_name(ffi::SQLITE_CONSTRAINT_UNIQUE),
            "SQLITE_CONSTRAINT_UNIQUE"
        );
        assert_eq!(code_name(9999), "SQLITE_9999");
    }

    #[test]
    fn message_decides_within_plain_sqlite_error() {
        assert_eq!(
            classify(ffi::SQLITE_ERROR, "no such table: nope").0,
            ErrorCategory::SchemaMissing
        );
        assert_eq!(
            classify(ffi::SQLITE_ERROR, "near \"selct\": syntax error").0,
            ErrorCategory::Syntax
        );
        assert_eq!(
            classify(ffi::SQLITE_ERROR, "something else").0,
            ErrorCategory::DriverFailure
        );
    }
}
