<?php

declare(strict_types=1);

namespace App\Models\Kitchen;

use App\Enums\PrintJobState;
use App\Enums\PrintJobType;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use App\Models\Pos\PosDevice;
use App\Models\Pos\PosPrinter;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\AsArrayObject;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * A durable, idempotent print job (spec §2.H).
 *
 * The `uuid` is minted by whoever enqueues the job, so a retried sync never
 * double-prints. `payload` is the structured ticket; `rendered_text` is the
 * ESC/POS-ready rendering kept for reprints and for debugging what the kitchen
 * actually saw.
 */
class PrintJob extends Model
{
    use BelongsToCompany;
    use HasUuid;

    protected $table = 'preparation_print_jobs';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'company_id',
        'pos_config_id',
        'pos_printer_id',
        'pos_order_id',
        'pos_device_id',
        'job_type',
        'payload',
        'rendered_text',
        'copies',
        'state',
        'attempts',
        'print_attempts',
        'leased_by',
        'leased_until',
        'last_error',
        'queued_at',
        'printed_at',
    ];

    protected function casts(): array
    {
        return [
            'job_type' => PrintJobType::class,
            'payload' => AsArrayObject::class,
            'copies' => 'integer',
            'state' => PrintJobState::class,
            'attempts' => 'integer',
            'print_attempts' => 'integer',
            'leased_until' => 'datetime',
            'queued_at' => 'datetime',
            'printed_at' => 'datetime',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<PosConfig, $this> */
    public function posConfig(): BelongsTo
    {
        return $this->belongsTo(PosConfig::class, 'pos_config_id');
    }

    /** @return BelongsTo<PosPrinter, $this> */
    public function printer(): BelongsTo
    {
        return $this->belongsTo(PosPrinter::class, 'pos_printer_id');
    }

    /** @return BelongsTo<Order, $this> */
    public function order(): BelongsTo
    {
        return $this->belongsTo(Order::class, 'pos_order_id');
    }

    /** @return BelongsTo<PosDevice, $this> */
    public function device(): BelongsTo
    {
        return $this->belongsTo(PosDevice::class, 'pos_device_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeQueued(Builder $query): Builder
    {
        return $query->where('state', PrintJobState::Queued->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeFailed(Builder $query): Builder
    {
        return $query->where('state', PrintJobState::Failed->value);
    }

    /** @param  Builder<static>  $query */
    public function scopeInState(Builder $query, PrintJobState $state): Builder
    {
        return $query->where('state', $state->value);
    }

    /** The printer poll query (spec §2.H). @param  Builder<static>  $query */
    public function scopeForPrinter(Builder $query, PosPrinter|int $printer): Builder
    {
        return $query
            ->where('pos_printer_id', $printer instanceof PosPrinter ? $printer->getKey() : $printer)
            ->queued()
            ->orderBy('queued_at');
    }

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        return $query->where('pos_config_id', $config instanceof PosConfig ? $config->getKey() : $config);
    }

    /** @param  Builder<static>  $query */
    public function scopeOfType(Builder $query, PrintJobType $type): Builder
    {
        return $query->where('job_type', $type->value);
    }
}
