import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRuntime, setRuntime, type RegisterRuntime } from '../data/runtime';
import { coursesOf, linesOf, useOrderStore } from '../state/order-store';
import { installCatalog, makeProduct, makeVariant, resetRegisterState } from './__fixtures__/catalog';
import { buildReceiptView } from './receipt';
import { currentDelta, fireCourseAndSend, sendToKitchen, unsentChangeCount } from './kitchen-send';
import { addCourse, addLine, cleanCourses, createOrder, setLineCourse } from './order-actions';

/**
 * RST-081 … RST-090 (BAN-477) — courses end to end.
 *
 * Most of this loop was written long ago and had no callers; by the time the ticket came up, the
 * buttons existed. What was still missing is what these cover: a plain send left every course
 * *unfired*, so the kitchen was cooking the starters while the till still offered "Fire course 1"
 * and no course tag ever showed. And the bill printed a flat list, which is the one document that
 * has to say which lines the kitchen is holding back.
 */

const PIZZA = 101;

function runtime(): { post: ReturnType<typeof vi.fn> } {
    const post = vi.fn(async () => ({ data: { snapshot_version: 7 }, status: 200, etag: null, notModified: false }));

    setRuntime({
        api: { post, get: vi.fn() },
        syncer: { enqueueCommand: vi.fn(async () => undefined) },
        printer: { getBindings: () => [] },
    } as unknown as RegisterRuntime);

    return { post };
}

function firedFlags(orderUuid: string): boolean[] {
    return coursesOf(useOrderStore.getState(), orderUuid).map((course) => course.fired);
}

beforeEach(() => {
    clearRuntime();
    resetRegisterState();
    installCatalog({
        products: [makeProduct({ id: 1, name: 'Pizza', list_price: '10.00' })],
        variants: [makeVariant({ id: PIZZA, product_id: 1, display_name: 'Pizza' })],
    });
});

describe('adding a course and moving a line into it', () => {
    it('gives the first course everything and opens an empty one after it', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });

        addCourse(orderUuid);

        const courses = coursesOf(useOrderStore.getState(), orderUuid);
        expect(courses.map((course) => course.index)).toEqual([1, 2]);

        const lines = linesOf(useOrderStore.getState(), orderUuid);
        expect(lines[0]?.course_uuid).toBe(courses[0]?.uuid);
    });

    it('moves a line to another course', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const line = addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        const second = coursesOf(useOrderStore.getState(), orderUuid)[1]!;

        setLineCourse(line, second.uuid);

        expect(linesOf(useOrderStore.getState(), orderUuid)[0]?.course_uuid).toBe(second.uuid);
    });
});

describe('sending the whole order', () => {
    it('marks the courses it just despatched as fired', async () => {
        // The defect: the kitchen had the food and the till still said the course was waiting to be
        // fired. Pressing fire afterwards found nothing to send and stamped it anyway — the same
        // state by a longer road, with a confused waiter in between.
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA, quantity: 2 });
        addCourse(orderUuid);

        expect(firedFlags(orderUuid)).toEqual([false, false]);

        runtime();
        expect((await sendToKitchen(orderUuid)).status).toBe('sent');

        // Course 1 held the lines; course 2 is empty and nobody has fired it.
        expect(firedFlags(orderUuid)).toEqual([true, false]);
    });

    it('leaves a course alone when the send carried none of its lines', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const first = addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        const second = coursesOf(useOrderStore.getState(), orderUuid)[1]!;

        runtime();
        await sendToKitchen(orderUuid);

        // A line added to course 2 afterwards: course 2 was not fired by the first send.
        const later = addLine({ orderUuid, variantId: PIZZA });
        setLineCourse(later, second.uuid);

        expect(useOrderStore.getState().courses[second.uuid]?.fired).toBe(false);
        expect(first).toBeTruthy();
    });

    it('does not re-stamp a course somebody already fired', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        const [one] = coursesOf(useOrderStore.getState(), orderUuid);

        const { post } = runtime();
        await fireCourseAndSend(orderUuid, one!.uuid);
        post.mockClear();

        addLine({ orderUuid, variantId: PIZZA });
        await sendToKitchen(orderUuid);

        expect(useOrderStore.getState().courses[one!.uuid]?.fired).toBe(true);
    });
});

describe('firing one course', () => {
    it('fires only that course and leaves the rest fireable', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const starter = addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        const [one, two] = coursesOf(useOrderStore.getState(), orderUuid);
        const main = addLine({ orderUuid, variantId: PIZZA, quantity: 3 });
        setLineCourse(main, two!.uuid);
        setLineCourse(starter, one!.uuid);

        runtime();
        expect((await fireCourseAndSend(orderUuid, one!.uuid)).status).toBe('sent');

        expect(firedFlags(orderUuid)).toEqual([true, false]);
        // The main is still waiting to go.
        expect(unsentChangeCount(orderUuid)).toBe(3);
    });
});

describe('tidying up', () => {
    it('drops a trailing empty course when the waiter leaves the products screen', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);

        expect(coursesOf(useOrderStore.getState(), orderUuid)).toHaveLength(2);

        cleanCourses(orderUuid);

        expect(coursesOf(useOrderStore.getState(), orderUuid)).toHaveLength(1);
    });
});

describe('what the bill prints', () => {
    it('names the course on every line so the printer can head its sections', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const starter = addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        const [one, two] = coursesOf(useOrderStore.getState(), orderUuid);
        const main = addLine({ orderUuid, variantId: PIZZA });
        setLineCourse(starter, one!.uuid);
        setLineCourse(main, two!.uuid);

        const view = buildReceiptView(useOrderStore.getState(), orderUuid, { cashierName: null });

        expect(view?.lines.map((line) => line.courseName)).toEqual(['Service 1', 'Service 2']);
    });

    it('leaves the course off an order that has none, rather than inventing one', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        addLine({ orderUuid, variantId: PIZZA });

        const view = buildReceiptView(useOrderStore.getState(), orderUuid, { cashierName: null });

        expect(view?.lines[0]?.courseName).toBeNull();
    });

    it('carries the course into the kitchen delta, which is what the ticket heads on', async () => {
        const orderUuid = await createOrder({ tableId: 1 });
        const starter = addLine({ orderUuid, variantId: PIZZA });
        addCourse(orderUuid);
        const [one] = coursesOf(useOrderStore.getState(), orderUuid);
        setLineCourse(starter, one!.uuid);

        expect(currentDelta(orderUuid).changes[0]?.courseUuid).toBe(one!.uuid);
    });
});
