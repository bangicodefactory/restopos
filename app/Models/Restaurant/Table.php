<?php

declare(strict_types=1);

namespace App\Models\Restaurant;

use App\Enums\OrderState;
use App\Enums\TableShape;
use App\Models\Concerns\BelongsToCompany;
use App\Models\Concerns\HasActiveState;
use App\Models\Concerns\HasUuid;
use App\Models\Concerns\IsPosLoadable;
use App\Models\Concerns\PosLoadable;
use App\Models\Pos\Order;
use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;
use Illuminate\Support\Str;

/**
 * One table on a floor plan (spec §2.G).
 *
 * `identifier` is the QR capability token handed to the self-order client — it
 * is the *only* table field a foreign client may learn, so the self-order
 * profile masks it for every table but the scanned one (spec §5.6).
 * `parent_id` is the physical link/merge: the child snaps to its parent and
 * their orders merge. Chains must stay acyclic.
 */
class Table extends Model implements PosLoadable
{
    use BelongsToCompany;
    use HasActiveState;
    use HasFactory;
    use HasUuid;
    use IsPosLoadable;
    use SoftDeletes;

    protected $table = 'restaurant_tables';

    /** @var list<string> */
    protected $fillable = [
        'uuid',
        'restaurant_floor_id',
        'company_id',
        'table_number',
        'name',
        'identifier',
        'shape',
        'position_x',
        'position_y',
        'width',
        'height',
        'seats',
        'color',
        'parent_id',
        'active',
        'booked_at',
        'booked_note',
    ];

    protected function casts(): array
    {
        return [
            'table_number' => 'integer',
            'shape' => TableShape::class,
            'position_x' => 'decimal:2',
            'position_y' => 'decimal:2',
            'width' => 'decimal:2',
            'height' => 'decimal:2',
            'seats' => 'integer',
            'active' => 'boolean',
            'booked_at' => 'datetime',
        ];
    }

    // ---------------------------------------------------------------- relations

    /** @return BelongsTo<Floor, $this> */
    public function floor(): BelongsTo
    {
        return $this->belongsTo(Floor::class, 'restaurant_floor_id');
    }

    /** The table this one is physically linked to. @return BelongsTo<Table, $this> */
    public function parent(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_id');
    }

    /** @return HasMany<Table, $this> */
    public function children(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id');
    }

    /** @return HasMany<Order, $this> */
    public function orders(): HasMany
    {
        return $this->hasMany(Order::class, 'restaurant_table_id');
    }

    /** Orders opened from this table's QR code. @return HasMany<Order, $this> */
    public function selfOrders(): HasMany
    {
        return $this->hasMany(Order::class, 'self_order_table_id');
    }

    /** @return HasMany<OrderMerge, $this> */
    public function merges(): HasMany
    {
        return $this->hasMany(OrderMerge::class, 'source_table_id');
    }

    // ------------------------------------------------------------------ scopes

    /** @param  Builder<static>  $query */
    public function scopeOnFloor(Builder $query, Floor|int $floor): Builder
    {
        return $query->where('restaurant_floor_id', $floor instanceof Floor ? $floor->getKey() : $floor);
    }

    /** @param  Builder<static>  $query */
    public function scopeForConfig(Builder $query, PosConfig|int $config): Builder
    {
        $id = $config instanceof PosConfig ? $config->getKey() : $config;

        return $query->whereHas('floor', fn (Builder $q) => $q->forConfig($id));
    }

    /** Tables carrying at least one draft order. @param  Builder<static>  $query */
    public function scopeOccupied(Builder $query): Builder
    {
        return $query->whereHas('orders', fn (Builder $q) => $q->where('state', OrderState::Draft->value));
    }

    /** @param  Builder<static>  $query */
    public function scopeFree(Builder $query): Builder
    {
        return $query->whereDoesntHave('orders', fn (Builder $q) => $q->where('state', OrderState::Draft->value));
    }

    /** @param  Builder<static>  $query */
    public function scopeWithIdentifier(Builder $query, string $identifier): Builder
    {
        return $query->where('identifier', $identifier);
    }

    // ----------------------------------------------------------------- helpers

    /** "Floor - T12", the label frozen onto kitchen tickets. */
    public function label(): string
    {
        return $this->name ?? ('T'.$this->table_number);
    }

    /** Rotate the QR capability token (invalidates printed codes). */
    public static function newIdentifier(): string
    {
        return Str::lower(Str::random(8));
    }

    // ----------------------------------------------------------------- loading

    /** Bootstrap scoping (spec §5.3): tables of the config's floors, active only. */
    public static function posLoadScope(PosConfig $config, string $profile = PosLoadable::PROFILE_REGISTER): Builder
    {
        return static::query()
            ->where('company_id', $config->company_id)
            ->whereIn('restaurant_floor_id', Floor::posLoadScope($config, $profile)->select('restaurant_floors.id'))
            ->active()
            ->orderBy('table_number');
    }

    /**
     * The self-order profile never discloses another table's `identifier`
     * (spec §5.6) — the serializer masks it, the field list keeps it out of the
     * generic payload.
     *
     * @return list<string>
     */
    public static function posLoadFields(string $profile = PosLoadable::PROFILE_REGISTER): array
    {
        if ($profile === PosLoadable::PROFILE_SELF_ORDER) {
            return ['id', 'uuid', 'name', 'table_number', 'restaurant_floor_id', 'seats', 'updated_at'];
        }

        return ['*'];
    }

    /**
     * Rename DB columns to the field names the client contract uses
     * (packages/domain `RestaurantTableRow`): `floor_id`, `position_h`, `position_v`. The floor
     * plan places tiles with these as inline-style offsets, so the positions must be numbers —
     * React only appends `px` to numeric style values, and the `decimal:2` cast yields strings.
     *
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    public function toPosRow(array $row): array
    {
        if (array_key_exists('restaurant_floor_id', $row)) {
            $row['floor_id'] = $row['restaurant_floor_id'] === null ? null : (int) $row['restaurant_floor_id'];
            unset($row['restaurant_floor_id']);
        }

        if (array_key_exists('position_x', $row)) {
            $row['position_h'] = (float) $row['position_x'];
            unset($row['position_x']);
        }

        if (array_key_exists('position_y', $row)) {
            $row['position_v'] = (float) $row['position_y'];
            unset($row['position_y']);
        }

        return $row;
    }
}
