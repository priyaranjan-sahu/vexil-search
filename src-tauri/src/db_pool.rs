use rusqlite::{Connection, OpenFlags, Result as SqlResult};
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore};

pub struct DbPool {
    connections: Vec<Arc<Mutex<Connection>>>,
    semaphore: Arc<Semaphore>,
}

impl DbPool {
    pub fn new(max_conns: usize, path: &Path) -> SqlResult<Self> {
        let mut conns = Vec::with_capacity(max_conns);
        for _ in 0..max_conns {
            let conn = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_WAL,
            )?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "synchronous", "NORMAL")?;
            conns.push(Arc::new(Mutex::new(conn)));
        }
        Ok(Self {
            connections: conns,
            semaphore: Arc::new(Semaphore::new(max_conns)),
        })
    }

    pub async fn acquire(&self) -> DbConnGuard<'_> {
        let permit = self.semaphore.acquire().await.unwrap();
        // Simple round-robin connection selection
        let idx = permit
            .clone()
            .forget()
            .into_iter()
            .count()
            % self.connections.len();
        let conn = self.connections[idx].clone();
        DbConnGuard {
            _permit: permit,
            conn,
        }
    }
}

pub struct DbConnGuard<'a> {
    _permit: tokio::sync::SemaphorePermit<'a>,
    pub conn: Arc<Mutex<Connection>>,
}

impl<'a> std::ops::Deref for DbConnGuard<'a> {
    type Target = Arc<Mutex<Connection>>;

    fn deref(&self) -> &Self::Target {
        &self.conn
    }
}