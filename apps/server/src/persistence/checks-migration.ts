import { DatabaseSync } from 'node:sqlite';
import { AppError } from '../application/errors.js';
import { checksSchema3, checksSchema4, migration4 } from './migration.js';

function layout(db: DatabaseSync): string {
    return JSON.stringify({
        columns: db.prepare("PRAGMA table_xinfo('checks')").all(),
        foreignKeys: db.prepare("PRAGMA foreign_key_list('checks')").all(),
        table: db.prepare("SELECT ncol,wr,strict FROM pragma_table_list WHERE schema='main' AND name='checks'").get()
    });
}

function parsedLayout(sql: string): string {
    const db = new DatabaseSync(':memory:');
    try {
        db.exec(sql);
        return layout(db);
    } finally {
        db.close();
    }
}

export function applyChecksMigration(db: DatabaseSync): void {
    if (!db.isTransaction || db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 || db.prepare('PRAGMA ignore_check_constraints').get()?.ignore_check_constraints !== 0 || db.prepare('PRAGMA writable_schema').get()?.writable_schema !== 0)
        throw new AppError('SCHEMA_UNSUPPORTED', 503);
    const current = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='checks'").get();
    const expectedLayout = parsedLayout(checksSchema3);
    const version = Number(db.prepare('PRAGMA schema_version').get()?.schema_version);
    if (current?.sql !== checksSchema3 || expectedLayout !== parsedLayout(checksSchema4) || layout(db) !== expectedLayout || !Number.isInteger(version) || version < 0 || version >= 2147483647)
        throw new AppError('SCHEMA_UNSUPPORTED', 503);
    try {
        // SQLite otherwise rebuilds constant IN sets for each row during writable quick_check.
        db.enableDefensive(false);
        db.exec('PRAGMA writable_schema=ON');
        db.exec(migration4);
        if (db.prepare('SELECT changes() AS n').get()?.n !== 1)
            throw new AppError('SCHEMA_UNSUPPORTED', 503);
        db.exec(`PRAGMA schema_version=${version + 1}`);
    } finally {
        try {
            db.exec('PRAGMA writable_schema=OFF');
        } finally {
            db.enableDefensive(true);
        }
    }
    if (db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='checks'").get()?.sql !== checksSchema4 || layout(db) !== expectedLayout)
        throw new AppError('SCHEMA_UNSUPPORTED', 503);
    const quick = db.prepare('PRAGMA quick_check').all();
    if (quick.length !== 1 || quick[0]?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length)
        throw new AppError('DATABASE_UNAVAILABLE', 503);
}
