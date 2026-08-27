<?php

declare(strict_types=1);

namespace App\Policies;

use App\Models\Catalog\BarcodeNomenclature;
use App\Models\User;

/**
 * Who may change how a venue reads its own barcodes (BOF-043, BAN-488).
 *
 * `catalog.manage_products`, because a nomenclature is about reading the codes printed on the
 * catalogue — a weight-embedded EAN-13 is a property of how this venue labels its shelves, not of
 * how its registers are configured.
 *
 * A shared nomenclature (`company_id IS NULL`) is readable by everyone. The controller refuses
 * writes to one outright rather than expressing it here, because it is not an authorisation
 * question: nobody may edit it, however privileged, since the row belongs to every venue at once.
 */
final class BarcodeNomenclaturePolicy
{
    use ChecksAbilities;

    public function viewAny(User $user): bool
    {
        return $this->userCan($user, 'catalog.view');
    }

    public function view(User $user, BarcodeNomenclature $nomenclature): bool
    {
        return ($nomenclature->company_id === null || $this->sameCompany($user, $nomenclature->company_id))
            && $this->userCan($user, 'catalog.view');
    }

    public function create(User $user): bool
    {
        return $this->userCan($user, 'catalog.manage_products');
    }

    public function update(User $user, BarcodeNomenclature $nomenclature): bool
    {
        return ($nomenclature->company_id === null || $this->sameCompany($user, $nomenclature->company_id))
            && $this->userCan($user, 'catalog.manage_products');
    }

    public function delete(User $user, BarcodeNomenclature $nomenclature): bool
    {
        return $this->update($user, $nomenclature);
    }
}
