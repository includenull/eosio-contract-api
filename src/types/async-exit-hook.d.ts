declare module 'async-exit-hook' {
    type AsyncExitCallback = (callback: () => void) => void | Promise<void>;
    export default function asyncExitHook(fn: AsyncExitCallback): void;
}
