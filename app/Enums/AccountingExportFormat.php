<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Output format of an `accounting_exports` batch.
 */
enum AccountingExportFormat: string
{
    use HasEnumHelpers;

    case Csv = 'csv';
    case Json = 'json';
    case Xlsx = 'xlsx';
    case Api = 'api';

    public function label(): string
    {
        return match ($this) {
            self::Csv => 'CSV',
            self::Json => 'JSON',
            self::Xlsx => 'Excel',
            self::Api => 'API push',
        };
    }
}
