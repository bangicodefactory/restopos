<?php

declare(strict_types=1);

namespace App\Services\Import;

use App\Support\Import\Importers;
use App\Support\Import\ImportPlan;
use App\Support\Import\ImportRow;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;

/**
 * Plan a CSV import, then apply it (BOF-093, BAN-491).
 *
 * Every DataTable and report in the back office exports to CSV and nothing imports. Onboarding a
 * venue with a 300-item menu meant 300 manual creations, which is the difference between a demo and
 * a usable product.
 *
 * ## One walk, two uses
 *
 * `plan()` decides what would happen to every row; `commit()` calls `plan()` and then writes. There
 * is deliberately no second code path for the preview, because a preview computed differently from
 * the commit is a preview that can promise something the commit does not deliver — and the whole
 * value of a preview is that it cannot.
 *
 * ## All or nothing
 *
 * A file with one bad row writes nothing. The alternative — commit the good rows, report the rest —
 * leaves the operator holding a partially imported catalogue with no way to know which half went in;
 * they then re-upload the corrected file and the idempotent key is the only thing standing between
 * them and a duplicate menu. Refusing the file is the kinder failure: fix it, upload it again, and
 * the outcome is the one the preview described.
 *
 * ## Validation is not this class's opinion
 *
 * Every row goes through the same rules the interactive form uses (`Importers::rulesFor`). An import
 * that validated more loosely would be a second, quieter way into the catalogue.
 */
final class CatalogImportService
{
    /** A file bigger than this is a mistake, not a menu. Reported, never silently truncated. */
    public const MAX_ROWS = 5000;

    /**
     * What this file would do.
     *
     * @param  list<array<string, string>>  $rows  parsed CSV rows, keyed by the mapped column name
     */
    public function plan(string $entity, array $rows, int $companyId): ImportPlan
    {
        $spec = Importers::all()[$entity] ?? null;

        if ($spec === null) {
            return new ImportPlan([]);
        }

        $planned = [];

        // Keys already claimed *within this file*. Two rows carrying one reference is the shape of a
        // copy-paste error in a spreadsheet, and without this the second silently overwrites the
        // first — the file imports "cleanly" and one product is missing.
        $seen = [];

        foreach ($rows as $index => $row) {
            // +2: one for the header, one because a spreadsheet counts from 1. This is the number
            // the operator will type into their file to find the row.
            $line = $index + 2;

            $values = $this->clean($row, $spec['columns']);

            // A missing required column is not checked separately here. Every entity's `required`
            // list is `required` in its rule set too, so a pre-check only restates it — in different
            // words. Sabotaging it changed no test, which is the honest signal that it was
            // redundant. Letting the rules answer keeps the import's message identical to the
            // form's, which is the whole point of sharing them. The `required` metadata stays: it is
            // what the screen tells the operator to fill in.
            $existing = $this->findExisting($spec, $values);

            $validator = Validator::make($values, Importers::rulesFor($entity, $existing === null));

            // `rules()` is not the whole of what a screen enforces — see `applyCrossFieldRules`.
            Importers::applyCrossFieldRules($entity, $values, $validator);

            if ($validator->fails()) {
                $planned[] = new ImportRow($line, 'error', $values, $validator->errors()->all());

                continue;
            }

            $duplicate = $this->duplicateKeyIn($seen, $spec['keys'], $values, $line);

            if ($duplicate !== null) {
                $planned[] = new ImportRow($line, 'error', $values, [$duplicate]);

                continue;
            }

            $planned[] = new ImportRow(
                $line,
                $existing === null ? 'create' : 'update',
                $values,
                [],
                $existing?->getKey(),
            );
        }

        return new ImportPlan($planned);
    }

    /**
     * Apply a clean plan.
     *
     * Returns the plan that was applied, so the caller reports what happened rather than what was
     * asked for.
     *
     * @param  list<array<string, string>>  $rows
     */
    public function commit(string $entity, array $rows, int $companyId): ImportPlan
    {
        $plan = $this->plan($entity, $rows, $companyId);

        if (! $plan->isClean()) {
            return $plan;
        }

        $model = Importers::all()[$entity]['model'];

        DB::transaction(function () use ($plan, $entity, $model, $companyId): void {
            foreach ($plan->rows as $row) {
                if ($row->action === 'update') {
                    /** @var Model|null $record */
                    $record = $model::query()->whereKey($row->existingId)->first();

                    // Re-checked inside the transaction and through the scoped model: the row was
                    // matched during the plan, which ran outside it.
                    if ($record !== null) {
                        $record->forceFill($row->values)->save();
                    }

                    continue;
                }

                $record = $model::query()->create([
                    // Fresh per row: a uuid is unique per record, so hoisting the defaults out of
                    // the loop would give every product in the file the same one.
                    ...Importers::defaultsFor($entity, $companyId),
                    ...$row->values,
                    'company_id' => $companyId,
                ]);

                Importers::afterCreate($entity, $record, $companyId);
            }
        });

        return $plan;
    }

    /**
     * The record this row is about, or null if it is new.
     *
     * Keys are tried in order and a blank value never matches — otherwise the first row without a
     * reference would claim every other row without one, and a 300-line menu would import as a
     * single product.
     *
     * @param  array{model: class-string, keys: list<string>, ...}  $spec
     * @param  array<string, mixed>  $values
     */
    private function findExisting(array $spec, array $values): ?Model
    {
        $model = $spec['model'];

        foreach ($spec['keys'] as $key) {
            $value = $values[$key] ?? null;

            if (blank($value)) {
                continue;
            }

            // Through the scoped model, so a reference another venue uses is not matched — that
            // would hand them our row to overwrite.
            $found = $model::query()->where($key, $value)->first();

            if ($found !== null) {
                return $found;
            }
        }

        return null;
    }

    /**
     * Whether an earlier line in the same file already claimed one of this row's keys.
     *
     * @param  array<string, int>  $seen  key => line that claimed it, by reference
     * @param  list<string>  $keys
     * @param  array<string, mixed>  $values
     */
    private function duplicateKeyIn(array &$seen, array $keys, array $values, int $line): ?string
    {
        foreach ($keys as $key) {
            $value = $values[$key] ?? null;

            if (blank($value)) {
                continue;
            }

            $token = $key.'='.$value;

            if (isset($seen[$token])) {
                return 'Line '.$seen[$token].' already uses this '.$key.'. One of the two would'
                    .' silently overwrite the other.';
            }

            $seen[$token] = $line;
        }

        return null;
    }

    /**
     * The row reduced to columns this entity has, with the spreadsheet idioms spelled out.
     *
     * A CSV has no types. `""` is not the same as absent — an operator clearing a cell means "no
     * value", so it becomes null rather than an empty string that would satisfy a `string` rule and
     * store a value of nothing. And a boolean column arrives as whatever the spreadsheet felt like:
     * `1`, `true`, `yes`, `oui`, `x`.
     *
     * @param  array<string, string>  $row
     * @param  list<string>  $columns
     * @return array<string, mixed>
     */
    private function clean(array $row, array $columns): array
    {
        $values = [];

        foreach ($columns as $column) {
            if (! array_key_exists($column, $row)) {
                continue;
            }

            $raw = trim((string) $row[$column]);

            if ($raw === '') {
                $values[$column] = null;

                continue;
            }

            $values[$column] = $this->isBooleanColumn($column)
                ? in_array(mb_strtolower($raw), ['1', 'true', 'yes', 'y', 'oui', 'o', 'x', 'vrai'], true)
                : $raw;
        }

        return $values;
    }

    private function isBooleanColumn(string $column): bool
    {
        return in_array($column, [
            'available_in_pos', 'self_order_available', 'sale_ok', 'active', 'to_weight',
            'track_stock', 'allow_negative_stock', 'is_favorite', 'marketing_opt_in',
            'price_include',
        ], true);
    }
}
