<?php

declare(strict_types=1);

namespace App\Models\Concerns;

use App\Models\Pos\PosConfig;
use Illuminate\Database\Eloquent\Builder;

/**
 * The bootstrap-payload contract (spec 01-schema §5).
 *
 * This is the direct analogue of Odoo's `pos.load.mixin`
 * (`_load_pos_data_domain` / `_load_pos_data_fields`): every entity that ships
 * in `GET /api/pos/{config}/bootstrap`, `/delta` or one of the narrower
 * profiles implements it, and the serializer layer only ever talks to this
 * interface.
 *
 * Profiles: `register` | `self_order` | `prep_display` (spec §5.6 / §5.7).
 */
interface PosLoadable
{
    /**
     * The config-scoped row filter for this entity.
     *
     * @return Builder<covariant \Illuminate\Database\Eloquent\Model>
     */
    public static function posLoadScope(PosConfig $config, string $profile = self::PROFILE_REGISTER): Builder;

    /**
     * The columns sent to the client for the given profile. `['*']` means the
     * whole row (only used for entities that are already narrow).
     *
     * @return list<string>
     */
    public static function posLoadFields(string $profile = self::PROFILE_REGISTER): array;

    /** The key this entity occupies in the payload's `data` map (its table name). */
    public static function posLoadName(): string;

    /**
     * Whether the client keys this entity by `uuid` (client-created records) or
     * by `id` (master data) — drives the shape of the `tombstones` map (§5.8).
     */
    public static function posLoadKeyedByUuid(): bool;

    public const PROFILE_REGISTER = 'register';

    public const PROFILE_SELF_ORDER = 'self_order';

    public const PROFILE_PREP_DISPLAY = 'prep_display';
}
