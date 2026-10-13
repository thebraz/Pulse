#!/usr/bin/env node
const command = process.argv[2] ?? 'help';
if (process.argv.length > 3 || !['start', 'doctor', 'version', 'help', '--version', '--help'].includes(command)) {
    console.error('Unknown command. Use pulse help.');
    process.exitCode = 1;
} else if (command === 'version' || command === '--version') {
    console.log('Pulse 0.1.0-beta.1');
} else if (command === 'help' || command === '--help') {
    console.log('Pulse — self-hosted HTTP monitoring\n\npulse start    Start the dashboard and monitoring engine\npulse doctor   Validate configuration, database schema and local health\npulse version  Show the version\npulse help     Show this help\n\nFrom a source checkout: npm run pulse -- <command>\nConfigure secrets through provisioned files, never CLI arguments.\nData defaults to ~/.pulse/pulse.sqlite; PULSE_DATA_DIR overrides it.');
} else if (command === 'start') {
    await import('../apps/server/dist/main.js');
} else {
    try {
        const { loadConfig } = await import('../apps/server/dist/config/config.js');
        const { DatabaseSync } = await import('node:sqlite');
        const { createHash } = await import('node:crypto');
        const { join } = await import('node:path');
        const { existsSync } = await import('node:fs');
        const { migration1, migration2, migration3, migration4, migration5 } = await import('../apps/server/dist/persistence/migration.js');
        const config = await loadConfig();
        console.log('Configuration: valid');
        console.log('Exposure: ' + config.exposure);
        const path = join(config.dataDir, 'pulse.sqlite');
        if (existsSync(path)) {
            const db = new DatabaseSync(path, { readOnly: true });
            try {
                const migrations = [migration1, migration2, migration3, migration4, migration5];
                const rows = db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all();
                const schemaValid = rows.length === migrations.length && rows.every((row, i) => row.version === i + 1 && row.checksum === createHash('sha256').update(migrations[i]).digest('hex'));
                const healthy = db.prepare('PRAGMA quick_check').get().quick_check === 'ok' && db.prepare('PRAGMA foreign_key_check').all().length === 0;
                console.log('Database: ' + (healthy ? 'healthy (read-only inspection)' : 'integrity check failed'));
                console.log('Schema: ' + (schemaValid ? 'current and checksums verified' : 'unsupported or migration required; back up before starting'));
                if (!healthy || !schemaValid) process.exitCode = 1;
            } finally { db.close(); }
        } else console.log('Database: not initialized; pulse start creates it');
        try {
            const response = await fetch(config.publicOrigin + '/health/ready', { signal: AbortSignal.timeout(3000) });
            console.log('Backend: ' + (response.ok ? 'ready' : 'not ready'));
            if (!response.ok) process.exitCode = 1;
        } catch { console.log('Backend: not running or unreachable'); }
    } catch {
        console.error('Doctor failed. Check runtime, configuration, local storage and secret-file permissions.');
        process.exitCode = 1;
    }
}
