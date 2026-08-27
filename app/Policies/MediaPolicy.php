<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Identity\MediaFile;
use App\Models\User;

/**
 * Who may put a file on the server, and who may read one back (BAN-393).
 *
 * `backoffice.manage_media` rather than reusing an existing slug, because uploading is not a
 * catalogue act, a configuration act or a staff act — every one of those surfaces needs it, and
 * picking any one of their abilities would either lock the others out or hand catalogue editors the
 * run of the register settings.
 *
 * It is its own ability for a second reason: an upload endpoint is disk a stranger can fill. Whoever
 * holds this can consume storage, so it should be grantable and revocable on its own.
 */
final class MediaPolicy
{
    use ChecksAbilities;

    /** Reading is company-scoped and nothing more: every back-office surface renders these. */
    public function view(User $user, MediaFile $media): bool
    {
        return $this->sameCompany($user, $media->company_id) && $this->userCan($user, 'backoffice.access');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'backoffice.manage_media');
    }

    /**
     * Deleting a media row leaves every column pointing at it dangling.
     *
     * Those are `nullOnDelete` on `payment_methods`, `pos_configs` and `restaurant_floors`, so the
     * database will not refuse — the image simply disappears from a screen nobody was looking at.
     * Same ability as uploading: whoever put it there may take it away.
     */
    public function delete(User $user, MediaFile $media): bool
    {
        return $this->sameCompany($user, $media->company_id)
            && $this->userCan($user, 'backoffice.manage_media');
    }
}
