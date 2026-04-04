import fs from 'node:fs';
import { mkdirSync } from 'node:fs';
import pino from 'pino';
import pretty from 'pino-pretty';

const pinoLevels = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

function resolveLevel(raw: string): pino.Level {
    const l = raw.toLowerCase();
    if (l === 'silly' || l === 'verbose') {
        return 'trace';
    }
    if (pinoLevels.has(l)) {
        return l as pino.Level;
    }

    return 'info';
}

const envLevel = resolveLevel(process.env.LOG_LEVEL || 'info');
const isProd = process.env.NODE_ENV === 'production';
const minLevel: pino.Level = isProd ? 'info' : envLevel;

mkdirSync('logs', { recursive: true });

const stdoutStream = isProd
    ? process.stdout
    : pretty({
        sync: true,
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
    });

const streams = [
    { level: minLevel, stream: stdoutStream },
    { level: 'error', stream: fs.createWriteStream('./logs/error.log', { flags: 'a' }) },
];

const base = pino({ level: minLevel }, pino.multistream(streams));

function withMeta(level: pino.Level, msg: string, meta?: unknown): void {
    if (meta === undefined) {
        base[level](msg);

        return;
    }
    if (meta instanceof Error) {
        base[level]({ err: meta }, msg);

        return;
    }
    if (Array.isArray(meta)) {
        base[level]({ data: meta }, msg);

        return;
    }
    if (typeof meta === 'object' && meta !== null) {
        base[level](meta as Record<string, unknown>, msg);

        return;
    }
    base[level]({ data: meta }, msg);
}

const logger = {
    info(msg: string, meta?: unknown): void {
        withMeta('info', msg, meta);
    },

    warn(msg: string, meta?: unknown): void {
        withMeta('warn', msg, meta);
    },

    debug(msg: string, meta?: unknown): void {
        withMeta('debug', msg, meta);
    },

    error(first: unknown, second?: unknown): void {
        if (first instanceof Error) {
            base.error({ err: first }, first.message || 'Error');

            return;
        }
        if (typeof first === 'string') {
            if (second instanceof Error) {
                base.error({ err: second }, first);

                return;
            }
            withMeta('error', first, second);

            return;
        }
        if (second instanceof Error) {
            base.error({ err: second }, String(first));

            return;
        }
        base.error({ data: first }, 'Error');
    },
};

logger.debug('Logger initialized with level ' + minLevel);

export default logger;
