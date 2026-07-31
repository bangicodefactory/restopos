<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\SequencePurpose;
use App\Models\Concerns\BelongsToCompany;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\DB;

/**
 * Atomic counter replacing `ir.sequence` (spec §2.D).
 *
 * Allocation must happen inside a transaction with a row lock; the service
 * layer owns that, the model only exposes the primitive.
 */
class Sequence extends Model
{
    use BelongsToCompany;

    protected $table = 'sequences';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'purpose' => SequencePurpose::class,
            'padding' => 'integer',
            'next_value' => 'integer',
        ];
    }

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class);
    }

    /** @param  Builder<static>  $query */
    public function scopeForPurpose(Builder $query, SequencePurpose $purpose): Builder
    {
        return $query->where('purpose', $purpose->value);
    }

    /** Allocate the next value atomically (`SELECT … FOR UPDATE`). */
    public function allocate(): int
    {
        return DB::transaction(function (): int {
            /** @var self $locked */
            $locked = static::query()->whereKey($this->getKey())->lockForUpdate()->firstOrFail();
            $value = (int) $locked->next_value;
            $locked->forceFill(['next_value' => $value + 1])->save();

            return $value;
        });
    }

    public function format(int $value): string
    {
        return ($this->prefix ?? '').str_pad((string) $value, $this->padding, '0', STR_PAD_LEFT);
    }
}
