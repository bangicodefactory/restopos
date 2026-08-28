<?php

declare(strict_types=1);

namespace App\Support\Import;

/**
 * What an import would do, decided before anything is written (BOF-093, BAN-491).
 *
 * The dry run and the commit walk the same code and produce one of these; the commit simply writes
 * afterwards. Two different code paths — one to preview, one to apply — is how a preview comes to
 * promise something the commit does not deliver, and the whole value of a preview is that it does
 * not.
 */
final class ImportPlan
{
    /** @param list<ImportRow> $rows */
    public function __construct(public readonly array $rows) {}

    /** @return list<ImportRow> */
    public function errors(): array
    {
        return array_values(array_filter($this->rows, static fn (ImportRow $row): bool => $row->isError()));
    }

    public function createCount(): int
    {
        return \count(array_filter($this->rows, static fn (ImportRow $row): bool => $row->action === 'create'));
    }

    public function updateCount(): int
    {
        return \count(array_filter($this->rows, static fn (ImportRow $row): bool => $row->action === 'update'));
    }

    public function errorCount(): int
    {
        return \count($this->errors());
    }

    public function isClean(): bool
    {
        return $this->errorCount() === 0;
    }

    /** @return list<array<string, mixed>> */
    public function toArray(): array
    {
        return array_map(static fn (ImportRow $row): array => $row->toArray(), $this->rows);
    }
}
