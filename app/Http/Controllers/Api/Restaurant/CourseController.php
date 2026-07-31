<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api\Restaurant;

use App\Http\Controllers\Api\Pos\Concerns\ResolvesDeviceContext;
use App\Http\Controllers\Controller;
use App\Http\Requests\Kitchen\SendPreparationRequest;
use App\Http\Resources\Pos\OrderCourseResource;
use App\Models\Pos\Order;
use App\Models\Restaurant\OrderCourse;
use App\Services\Kitchen\PreparationService;
use DomainException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * Courses and course firing (spec 02 RST-080…RST-090).
 *
 * Firing a course produces a *note-update*-shaped ticket listing the course's
 * products, not a NEW ticket — otherwise the kitchen counts those quantities a
 * second time (RST-084).
 */
final class CourseController extends Controller
{
    use ResolvesDeviceContext;

    public function __construct(private readonly PreparationService $preparation) {}

    /** `GET /api/pos/orders/{order}/courses` */
    public function index(Request $request, Order $order): JsonResponse
    {
        $this->assertOwned($request, $order);

        return new JsonResponse([
            'courses' => OrderCourseResource::collection(
                OrderCourse::query()->where('pos_order_id', $order->getKey())->orderBy('course_index')->get()
            )->resolve($request),
        ]);
    }

    /** `POST /api/pos/orders/{order}/courses` */
    public function store(Request $request, Order $order): JsonResponse
    {
        $this->assertOwned($request, $order);

        $request->validate([
            'uuid' => ['nullable', 'string', 'size:36'],
            'course_index' => ['nullable', 'integer', 'min:1'],
            'name' => ['nullable', 'string', 'max:48'],
        ]);

        $index = $request->integer('course_index')
            ?: (int) OrderCourse::query()->where('pos_order_id', $order->getKey())->max('course_index') + 1;

        /** @var OrderCourse $course */
        $course = OrderCourse::query()->updateOrCreate(
            ['uuid' => $request->input('uuid') ?? (string) Str::uuid()],
            [
                'pos_order_id' => $order->getKey(),
                'course_index' => $index,
                'name' => $request->input('name'),
                'fired' => false,
            ],
        );

        return OrderCourseResource::make($course)->response()->setStatusCode(201);
    }

    /** `POST /api/pos/orders/{order}/courses/{course}/fire` */
    public function fire(SendPreparationRequest $request, Order $order, OrderCourse $course): JsonResponse
    {
        [$device, $config] = $this->deviceContext($request);
        $this->assertOwned($request, $order);

        abort_unless((int) $course->pos_order_id === (int) $order->getKey(), 404);

        try {
            $result = $this->preparation->fireCourse($order, $config, $course, (int) $device->getKey());
        } catch (DomainException $e) {
            return new JsonResponse([
                'error' => ['code' => $e->getMessage(), 'message' => 'The kitchen already has a newer version of this order.'],
                'delta' => $this->preparation->delta($order)->toArray(),
            ], 409);
        }

        return new JsonResponse([
            'course' => OrderCourseResource::make($course->refresh())->resolve($request),
            'delta' => $result['delta']->toArray(),
            'prep_orders' => $result['prep_orders'],
            'print_jobs' => $result['print_jobs'],
            'snapshot_version' => $result['snapshot_version'],
        ]);
    }

    /** `DELETE /api/pos/orders/{order}/courses/{course}` */
    public function destroy(Request $request, Order $order, OrderCourse $course): JsonResponse
    {
        $this->assertOwned($request, $order);

        abort_unless((int) $course->pos_order_id === (int) $order->getKey(), 404);
        abort_if((bool) $course->fired, 422, 'A fired course cannot be deleted.');

        $course->delete();

        return new JsonResponse(null, 204);
    }

    private function assertOwned(Request $request, Order $order): void
    {
        [, $config] = $this->deviceContext($request);

        abort_unless((int) $order->pos_config_id === (int) $config->getKey(), 404);
    }
}
