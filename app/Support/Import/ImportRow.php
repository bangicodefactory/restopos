<?php

declare(strict_types=1);

namespace App\Support\Import;

/**
 * One line of the file, and what would happen to it (BOF-093, BAN-491).
 *
 * `line` is the line number **in the operator's file**, counting the header, because that is the
 * number they will type into their spreadsheet to find the row. A zero-based index into the parsed
 * array is the same information expressed in a way nobody can act on.
 */
final class ImportRow
{
    /**
     * @param  'create'|'update'|'error'  $action
     * @param  array<string, mixed>  $values
     * @param  list<string>  $messages
     */
    public function __construct(
        public readonly int $line,
        public readonly string $action,
        public readonly array $values = [],
        public readonly array $messages = [],
        public readonly ?int $existingId = null,
    ) {}

    public function isError(): bool
    {
        return $this->action === 'error';
    }

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return [
            'line' => $this->line,
            'action' => $this->action,
            'values' => $this->values,
            'messages' => $this->messages,
            'existing_id' => $this->existingId,
        ];
    }
}
