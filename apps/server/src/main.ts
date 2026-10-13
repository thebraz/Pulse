import { loadConfig } from './config/config.js';
import { createRuntime } from './runtime/runtime.js';
import { AppError, safeLog } from './application/errors.js';
try {
    const config = await loadConfig();
    const runtime = await createRuntime(config);
    try {
        await runtime.listen();
    }
    catch (error) {
        await runtime.close();
        throw error;
    }
    if (['info', 'debug'].includes(config.logLevel))
        process.stdout.write(JSON.stringify({
            level: 'info', code: 'PULSE_READY', version: '0.1.0', dashboard: config.publicOrigin, message: 'Pulse is ready. Open the dashboard in your browser.'
        }) + '\n');
    let stopping = false;
    const stop = () => {
        if (stopping)
            return;
        stopping = true;
        const deadline = setTimeout(() => { safeLog('SHUTDOWN_DEADLINE'); process.exit(1); }, 15000);
        runtime.close().then(() => {
            clearTimeout(deadline);
            process.exitCode = 0;
            if (process.connected)
                process.disconnect?.();
        }).catch(() => {
            clearTimeout(deadline);
            safeLog('SHUTDOWN_FAILED');
            process.exitCode = 1;
            if (process.connected)
                process.disconnect?.();
        });
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    process.on('message', message => {
        if (message === 'shutdown')
            stop();
    });
}
catch (error) {
    safeLog(error instanceof AppError ? error.code : 'STARTUP_FAILED');
    process.exitCode = 1;
}
