// Polyfills for React Native (Hermes) environment
// Must be imported before any library that uses these globals

// DOMException polyfill — required by livekit-client >=2.16 which uses
// `class DeferrableMapAbortError extends DOMException` at module load time.
// Hermes does not provide DOMException as a global.
if (typeof globalThis.DOMException === 'undefined') {
    (globalThis as any).DOMException = class DOMException extends Error {
        constructor(message?: string, name?: string) {
            super(message);
            this.name = name || 'DOMException';
        }
    };
}
