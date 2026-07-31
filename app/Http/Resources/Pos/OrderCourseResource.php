<?php

declare(strict_types=1);

namespace App\Http\Resources\Pos;

use App\Models\Restaurant\OrderCourse;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/** @mixin OrderCourse */
final class OrderCourseResource extends JsonResource
{
    public static $wrap = null;

    /** @return array<string, mixed> */
    public function toArray(Request $request): array
    {
        /** @var OrderCourse $course */
        $course = $this->resource;

        return [
            'id' => (int) $course->getKey(),
            'uuid' => (string) $course->uuid,
            'pos_order_id' => (int) $course->pos_order_id,
            'course_index' => (int) $course->course_index,
            'name' => $course->name,
            'fired' => (bool) $course->fired,
            'fired_at' => $course->fired_at,
            'line_count' => (int) $course->line_count,
        ];
    }
}
