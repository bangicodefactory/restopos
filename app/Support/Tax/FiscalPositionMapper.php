<?php

declare(strict_types=1);

namespace App\Support\Tax;

use App\Support\Tax\Dto\FiscalPosition;

/**
 * §5 — fiscal position tax mapping. Applied BEFORE any arithmetic.
 *
 * - unmapped source taxes pass through unchanged (§5.2);
 * - `taxDestId === null` drops the tax (exemption);
 * - one source may expand to several destinations;
 * - the result is de-duplicated preserving first occurrence (§5.3);
 * - the mapping is not transitive (§5.4).
 */
final class FiscalPositionMapper
{
    /**
     * @param  list<int>  $taxIds
     * @return list<int>
     */
    public function map(array $taxIds, ?FiscalPosition $fiscalPosition): array
    {
        if ($fiscalPosition === null || $fiscalPosition->mappings === []) {
            return \array_values($taxIds);
        }

        $emitted = [];
        foreach ($taxIds as $srcId) {
            $matched = false;
            foreach ($fiscalPosition->mappings as $mapping) {
                if ($mapping->taxSrcId !== $srcId) {
                    continue;
                }
                $matched = true;
                if ($mapping->taxDestId !== null) {
                    $emitted[] = $mapping->taxDestId;
                }
            }
            if (! $matched) {
                $emitted[] = $srcId;
            }
        }

        $seen = [];
        $out = [];
        foreach ($emitted as $id) {
            if (! isset($seen[$id])) {
                $seen[$id] = true;
                $out[] = $id;
            }
        }

        return $out;
    }
}
