export class AppError extends Error {
    constructor(public readonly code: string, public readonly status: number) { super(code); }
}
export function safeLog(code: string): void {
    process.stderr.write(JSON.stringify({
        level: 'error', code
    }) + '\n');
}
