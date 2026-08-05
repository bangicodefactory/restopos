/**
 * Setup for the jsdom-environment tests (component tests).
 *
 * Guarded on `document` because vitest runs one `setupFiles` list for every test file, and most of
 * this repo's suites are deliberately framework-free `node`-environment tests — `packages/domain`
 * must keep running with no DOM and no shims. Importing jest-dom unconditionally would load DOM
 * matchers into those, which is exactly the coupling the domain layer is kept clear of.
 *
 * A component test opts in with a docblock:  \/** @vitest-environment jsdom *\/
 */
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
    await import('@testing-library/jest-dom/vitest');

    const { cleanup } = await import('@testing-library/react');

    // RTL only auto-cleans when it detects a global `afterEach`; registering it here means a
    // component test never leaks a mounted tree into the next one.
    afterEach(() => cleanup());

    // jsdom ships `<dialog>` markup but not its behaviour: `showModal()` and `close()` are simply
    // absent, so every dialog in this app throws on mount. Minimal stand-in — it maintains the
    // `open` property and fires `close`, which is all our `Dialog` wrapper reads.
    const proto = globalThis.HTMLDialogElement?.prototype;

    if (proto && typeof proto.showModal !== 'function') {
        proto.showModal = function showModal(this: HTMLDialogElement): void {
            this.open = true;
        };
        proto.show = function show(this: HTMLDialogElement): void {
            this.open = true;
        };
        proto.close = function close(this: HTMLDialogElement, returnValue?: string): void {
            this.open = false;
            if (returnValue !== undefined) this.returnValue = returnValue;
            this.dispatchEvent(new Event('close'));
        };
    }
}
