import { expect, it, vi } from 'vitest';

import { createFlusher } from './create-store';

/**
 * The flusher backs the register's write debounce. A debounce-timer flush and a manual flushNow can
 * both fire close together (payment validate is exactly this), and each must run *after* the
 * previous one settles — two writers racing over the same store is the bug this serialisation
 * prevents.
 */

it('runs a second flush only after the first one settles', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    let call = 0;
    const flush = vi.fn(async () => {
        call += 1;
        const id = call;
        events.push(`start${id}`);
        if (id === 1) await firstDone; // hold flush #1 open until we release it
        events.push(`end${id}`);
    });

    const flusher = createFlusher(flush, 250);

    flusher.schedule();
    const first = flusher.flushNow();
    flusher.schedule();
    const second = flusher.flushNow();

    // Let every queued microtask/macrotask run: flush #1 has started and is parked on the gate,
    // flush #2 must not have started yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['start1']);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['start1', 'end1', 'start2', 'end2']);
    expect(flush).toHaveBeenCalledTimes(2);
});

it('keeps the chain alive after a flush rejects', async () => {
    let call = 0;
    const flush = vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error('first flush failed');
    });

    const flusher = createFlusher(flush, 250);

    flusher.schedule();
    await flusher.flushNow().catch(() => undefined);

    // A later flush still runs despite the earlier rejection.
    flusher.schedule();
    await flusher.flushNow();

    expect(flush).toHaveBeenCalledTimes(2);
});
