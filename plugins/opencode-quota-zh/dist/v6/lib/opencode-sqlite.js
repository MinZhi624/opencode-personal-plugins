function toParams(params) {
    return Array.isArray(params) ? params : [];
}
function runBunPragma(db, sql) {
    try {
        db.query(sql).run();
    }
    catch {
        // ignore
    }
}
function runNodePragma(db, sql) {
    try {
        db.exec(sql);
    }
    catch {
        // ignore
    }
}
async function openWithNodeSqlite(dbPath) {
    const mod = (await import("node:sqlite"));
    const db = new mod.DatabaseSync(dbPath, {
        readOnly: true,
        enableForeignKeyConstraints: true,
        open: true,
    });
    // Keep reads deterministic and avoid accidental writes.
    runNodePragma(db, "PRAGMA query_only = ON;");
    // Avoid transient SQLITE_BUSY errors (WAL).
    runNodePragma(db, "PRAGMA busy_timeout = 5000;");
    return {
        all(sql, params) {
            const stmt = db.prepare(sql);
            return stmt.all(...toParams(params));
        },
        get(sql, params) {
            const stmt = db.prepare(sql);
            const row = stmt.get(...toParams(params));
            return row ?? null;
        },
        close() {
            try {
                db.close();
            }
            catch {
                // ignore
            }
        },
    };
}
async function openWithBunSqlite(dbPath) {
    const mod = (await import("bun:sqlite"));
    const db = new mod.Database(dbPath, { readonly: true });
    // Keep reads deterministic and avoid accidental writes.
    runBunPragma(db, "PRAGMA query_only = ON;");
    // Avoid transient SQLITE_BUSY errors (WAL).
    runBunPragma(db, "PRAGMA busy_timeout = 5000;");
    return {
        all(sql, params) {
            const stmt = db.query(sql);
            return stmt.all(...toParams(params));
        },
        get(sql, params) {
            const stmt = db.query(sql);
            const row = stmt.get(...toParams(params));
            return row ?? null;
        },
        close() {
            try {
                db.close();
            }
            catch {
                // ignore
            }
        },
    };
}
/**
 * Open OpenCode's SQLite database read-only.
 * Inside OpenCode 2 (Bun) this uses bun:sqlite; the Node CLI uses node:sqlite.
 */
export async function openOpenCodeSqliteReadOnly(dbPath) {
    if ("Bun" in globalThis) {
        return openWithBunSqlite(dbPath);
    }
    return openWithNodeSqlite(dbPath);
}
