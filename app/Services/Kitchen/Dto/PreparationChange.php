<?php

declare(strict_types=1);

namespace App\Services\Kitchen\Dto;

use App\Enums\PrepChangeType;

/**
 * One entry of the kitchen change delta (spec 02 KDS-051).
 *
 * `quantity` is **signed**: positive for work to do, negative for work to undo.
 * A cancellation of something already cooked must be visible, not silently
 * dropped (KDS-016).
 */
final readonly class PreparationChange
{
    public function __construct(
        public string $lineUuid,
        public ?int $lineId,
        public int $productId,
        public ?int $posCategoryId,
        public string $name,
        public string $quantity,
        public PrepChangeType $changeType,
        public ?string $customerNote = null,
        public ?string $internalNote = null,
        public ?int $courseId = null,
        public int $courseIndex = 1,
        public ?string $comboParentUuid = null,
    ) {}

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'line_uuid' => $this->lineUuid,
            'line_id' => $this->lineId,
            'product_id' => $this->productId,
            'pos_category_id' => $this->posCategoryId,
            'name' => $this->name,
            'quantity' => $this->quantity,
            'change_type' => $this->changeType->value,
            'customer_note' => $this->customerNote,
            'internal_note' => $this->internalNote,
            'course_id' => $this->courseId,
            'course_index' => $this->courseIndex,
            'combo_parent_uuid' => $this->comboParentUuid,
        ];
    }
}
