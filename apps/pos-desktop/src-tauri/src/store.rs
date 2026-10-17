//! The till's local database (ADR-0015): one SQLite connection behind a mutex, exposed as the
//! `SqlDriver` surface of `@1pos/pos-offline` (execute / select / begin / commit / rollback).
//!
//! One connection, not a pool: `transaction()` in the store spans several IPC calls, and BEGIN …
//! COMMIT only means something if every statement in between runs on the same connection.
//! WAL + synchronous=FULL, so a committed sale survives a crash or a power cut.

use rusqlite::types::{Value, ValueRef};
use rusqlite::{params_from_iter, Connection};
use serde_json::{Map, Number, Value as Json};
use std::path::Path;
use std::sync::Mutex;

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Debug, serde::Serialize)]
pub struct Changes {
    pub changes: usize,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(err)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
        )
        .map_err(err)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        // A poisoned lock means a panic mid-statement; SQLite itself rolled the statement back.
        let conn = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(&conn)
    }

    pub fn execute(&self, sql: &str, params: &[Json]) -> Result<Changes, String> {
        let values = to_values(params)?;
        self.with(|c| {
            let mut stmt = c.prepare_cached(sql).map_err(err)?;
            let changes = stmt.execute(params_from_iter(values.iter())).map_err(err)?;
            Ok(Changes { changes })
        })
    }

    pub fn select(&self, sql: &str, params: &[Json]) -> Result<Vec<Map<String, Json>>, String> {
        let values = to_values(params)?;
        self.with(|c| {
            let mut stmt = c.prepare_cached(sql).map_err(err)?;
            let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
            let mut rows = stmt.query(params_from_iter(values.iter())).map_err(err)?;
            let mut out = Vec::new();
            while let Some(row) = rows.next().map_err(err)? {
                let mut obj = Map::with_capacity(names.len());
                for (i, name) in names.iter().enumerate() {
                    obj.insert(name.clone(), to_json(row.get_ref(i).map_err(err)?)?);
                }
                out.push(obj);
            }
            Ok(out)
        })
    }

    /// BEGIN IMMEDIATE takes the write lock up front, like the node:sqlite driver.
    pub fn begin(&self) -> Result<(), String> {
        self.with(|c| {
            if !c.is_autocommit() {
                return Err("A transaction is already open on the till database".into());
            }
            c.execute_batch("BEGIN IMMEDIATE").map_err(err)
        })
    }

    pub fn commit(&self) -> Result<(), String> {
        self.with(|c| c.execute_batch("COMMIT").map_err(err))
    }

    /// Rolling back when nothing is open is not an error (the failure may have ended the transaction).
    pub fn rollback(&self) -> Result<(), String> {
        self.with(|c| if c.is_autocommit() { Ok(()) } else { c.execute_batch("ROLLBACK").map_err(err) })
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// `SqlValue` is string | number | null on the TS side; anything else is a programming error.
fn to_values(params: &[Json]) -> Result<Vec<Value>, String> {
    params
        .iter()
        .map(|p| match p {
            Json::Null => Ok(Value::Null),
            Json::String(s) => Ok(Value::Text(s.clone())),
            Json::Number(n) => match n.as_i64() {
                Some(i) => Ok(Value::Integer(i)),
                None => n.as_f64().map(Value::Real).ok_or_else(|| format!("Unsupported number {n}")),
            },
            other => Err(format!("Unsupported SQL parameter: {other}")),
        })
        .collect()
}

fn to_json(v: ValueRef<'_>) -> Result<Json, String> {
    Ok(match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Json::Number).ok_or("Non-finite REAL in the till database")?,
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => return Err("BLOB columns are not used by the till store".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("till.sqlite")).unwrap();
        s.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount REAL)", &[]).unwrap();
        (dir, s)
    }

    #[test]
    fn executes_and_selects_with_typed_params() {
        let (_d, s) = store();
        assert_eq!(s.execute("INSERT INTO t VALUES (?, ?, ?)", &[json!(1), json!("Cola"), json!(null)]).unwrap().changes, 1);
        s.execute("INSERT INTO t VALUES (?, ?, ?)", &[json!(2), json!("Chips"), json!(1.5)]).unwrap();
        let rows = s.select("SELECT id, name, amount FROM t ORDER BY id", &[]).unwrap();
        assert_eq!(Json::Array(rows.into_iter().map(Json::Object).collect()), json!([
            { "id": 1, "name": "Cola", "amount": null },
            { "id": 2, "name": "Chips", "amount": 1.5 }
        ]));
        assert!(s.execute("INSERT INTO t VALUES (?, ?, ?)", &[json!(3), json!(["x"]), json!(null)]).is_err());
    }

    #[test]
    fn rollback_discards_and_commit_keeps() {
        let (_d, s) = store();
        s.begin().unwrap();
        s.execute("INSERT INTO t (name) VALUES ('a')", &[]).unwrap();
        assert!(s.begin().is_err(), "no nested transactions");
        s.rollback().unwrap();
        assert_eq!(s.select("SELECT count(*) AS n FROM t", &[]).unwrap()[0]["n"], json!(0));
        s.begin().unwrap();
        s.execute("INSERT INTO t (name) VALUES ('b')", &[]).unwrap();
        s.commit().unwrap();
        s.rollback().unwrap(); // nothing open: fine
        assert_eq!(s.select("SELECT count(*) AS n FROM t", &[]).unwrap()[0]["n"], json!(1));
    }

    #[test]
    fn committed_rows_survive_reopening_and_wal_is_on() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("till.sqlite");
        {
            let s = Store::open(&path).unwrap();
            s.execute("CREATE TABLE t (v TEXT)", &[]).unwrap();
            s.begin().unwrap();
            s.execute("INSERT INTO t VALUES ('kept')", &[]).unwrap();
            s.commit().unwrap();
            s.begin().unwrap();
            s.execute("INSERT INTO t VALUES ('lost')", &[]).unwrap();
            // dropped without commit: like a crash mid-sale
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.select("SELECT v FROM t", &[]).unwrap().len(), 1);
        assert_eq!(s.select("PRAGMA journal_mode", &[]).unwrap()[0]["journal_mode"], json!("wal"));
        assert_eq!(s.select("PRAGMA synchronous", &[]).unwrap()[0]["synchronous"], json!(2)); // FULL
    }
}
