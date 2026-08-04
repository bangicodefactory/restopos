<?php

declare(strict_types=1);

namespace App\Models\Pos;

use App\Enums\AccountingExportFormat;
use App\Enums\AccountingExportState;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasUuid;
use App\Models\Identity\MediaFile;
use App\Models\User;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;

/** A batch turning N closed sessions into a file / API push for the ledger (spec §2.E). */
class AccountingExport extends Model
{
    use BelongsToCompany;
    use HasUuid;

    protected $table = 'accounting_exports';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'period_start' => 'date',
            'period_end' => 'date',
            'format' => AccountingExportFormat::class,
            'state' => AccountingExportState::class,
            'session_count' => 'integer',
            'total_sales' => 'decimal:4',
            'total_tax' => 'decimal:4',
            'total_payments' => 'decimal:4',
            'total_rounding' => 'decimal:4',
            'imbalance_amount' => 'decimal:4',
        ];
    }

    /** @return BelongsToMany<PosSession, $this> */
    public function sessions(): BelongsToMany
    {
        return $this->belongsToMany(PosSession::class, 'accounting_export_session');
    }

    /** @return BelongsTo<MediaFile, $this> */
    public function file(): BelongsTo
    {
        return $this->belongsTo(MediaFile::class, 'media_file_id');
    }

    /** @return BelongsTo<User, $this> */
    public function generatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'generated_by_user_id');
    }

    /** @param  Builder<static>  $query */
    public function scopeUnbalanced(Builder $query): Builder
    {
        return $query->where('imbalance_amount', '!=', 0);
    }
}
