<?php

declare(strict_types=1);

namespace App\Models\Identity;

use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Support\Auth\EmployeeAbilities;
use Illuminate\Database\Eloquent\Model;

/**
 * What a till employee may do — axis 2 (BOF-118, BAN-451).
 *
 * One row per role a venue offers its staff: the three the product ships with, plus whatever else it
 * needs. "Shift lead who may void but not discount past the limit" is a row here.
 *
 * Named for the axis because both other names were taken — `roles` is back-office users, and
 * `App\Enums\EmployeeRole` is the enum of the three system slugs. See the migration.
 */
class TillRole extends Model
{
    use BelongsToCompany;
    use HasActiveState;

    protected $table = 'till_roles';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'abilities' => 'array',
            'is_system' => 'boolean',
            'sequence' => 'integer',
            'active' => 'boolean',
        ];
    }

    /**
     * The abilities this role holds, filtered to the ones the system understands.
     *
     * Filtered on read as well as on write. A row can outlive the code that gave it meaning: an
     * ability removed from `EmployeeAbilities` in a later release is still sitting in this JSON
     * column, and shipping it to the till would put a permission in the payload that nothing checks
     * — visible to the client's own gate, which would then allow an action the server refuses.
     *
     * @return list<string>
     */
    public function grantedAbilities(): array
    {
        return EmployeeAbilities::only((array) $this->abilities);
    }
}
