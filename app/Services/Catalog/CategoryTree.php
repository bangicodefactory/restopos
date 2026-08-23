<?php

declare(strict_types=1);

namespace App\Services\Catalog;

use Illuminate\Database\ConnectionInterface;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Validation\ValidationException;

/**
 * A materialised-path category tree: where a node sits, and what has to move with it.
 *
 * Two trees use this and they are genuinely different things — `pos_categories` is the register's
 * browsing tree (BOF-084) and `product_categories` is the accounting tree carrying `ledger_code`
 * (BAN-501). What they share is the mechanism, so the mechanism is shared and the surfaces are not.
 *
 * **The path is built from ids, terminated: `/4/9/22/`.** That is what `PosCategory` has always
 * documented and what the code did not do — `store()` concatenated *names* with no terminator, which
 * fails twice:
 *
 *  - **Prefix collision.** `/Drink` is a prefix of `/Drinks special`, so a subtree query rooted at
 *    "Drink" swept in an unrelated sibling. Probed on master: the subtree of "Drink" returned
 *    `["Drink", "Drinks special", "Beer"]`. On the self-order menu that is a category the venue chose
 *    to hide appearing anyway. The fixtures already worked around this by leading the marker
 *    (BAN-508) rather than fixing it. `ProductCategory::scopeDescendantsOf` had the same shape.
 *  - **Rename drift.** A name path has to be rewritten across the whole subtree every time anybody
 *    edits a label. Ids do not change, so only a *move* touches the path.
 *
 * Terminated ids are collision-proof rather than collision-unlikely: `/1/` cannot prefix `/11/`,
 * because the character after `1` is `/` in one and `1` in the other.
 *
 * **Depth is derived from the path, never read from a column.** `pos_categories` denormalises it and
 * `product_categories` does not, and a tree service that only works on tables carrying the extra
 * column would be a tree service for one table. The column is still maintained where it exists,
 * because the register's pages render indentation from it.
 */
final class CategoryTree
{
    /** Deep enough for any real menu; a cycle would otherwise walk forever. */
    private const MAX_DEPTH = 10;

    /** @var array<string, bool> table => does it denormalise `depth` */
    private array $hasDepth = [];

    public function __construct(private readonly ConnectionInterface $connection) {}

    /** The path a node has when it hangs under `$parent`. */
    public function pathFor(?Model $parent, int $id): string
    {
        return ($parent === null ? '/' : (string) $parent->getAttribute('path')).$id.'/';
    }

    /**
     * How deep a path sits, counted from zero.
     *
     * `/1/` is a root at 0; `/1/2/` is 1. Two slashes are structural — the leading one and the
     * terminator — so everything past them is an ancestor.
     */
    public function depthOf(string $path): int
    {
        return max(0, substr_count($path, '/') - 2);
    }

    /**
     * Give a freshly created node its place in the tree.
     *
     * Separate from `create()` because the path contains the node's own id, which does not exist
     * until the row does.
     */
    public function place(Model $node, ?Model $parent): void
    {
        // Checked here rather than only on a move, because both doors reach this. Guarding
        // `reparent` alone left the bound trivially defeatable: create one level at a time and the
        // tree goes as deep as you like, which is the shape the pricing walk cannot read.
        $this->assertDepthIsReadable($parent);

        $path = $this->pathFor($parent, (int) $node->getKey());

        $node->forceFill($this->attributesFor($node, $path))->save();
    }

    /**
     * Move a node under a new parent, taking its subtree with it.
     *
     * Every descendant's path is rewritten, because a stale path is not a cosmetic problem: the
     * `LIKE` scopes would place the subtree where it used to be, so a category moved out of the
     * self-order menu would still show, and printer routing would still fire for the old branch.
     */
    public function reparent(Model $node, ?Model $parent): void
    {
        $this->assertMoveIsPossible($node, $parent);

        $this->connection->transaction(function () use ($node, $parent): void {
            $oldPath = (string) $node->getAttribute('path');

            $this->place($node, $parent);

            $newPath = (string) $node->getAttribute('path');

            if ($newPath === $oldPath) {
                return;
            }

            // The descendants, found by the path they had *before* the move.
            $descendants = $node->newQuery()
                ->where('path', 'like', $oldPath.'%')
                ->whereKeyNot($node->getKey())
                ->get();

            foreach ($descendants as $descendant) {
                $moved = $newPath.substr((string) $descendant->getAttribute('path'), strlen($oldPath));

                $descendant->forceFill($this->attributesFor($descendant, $moved))->save();
            }
        });
    }

    /**
     * The columns a placement writes.
     *
     * `depth` only when the table has one: `product_categories` does not, and writing an attribute
     * with no column behind it is an SQL error on save rather than a no-op.
     *
     * @return array<string, mixed>
     */
    private function attributesFor(Model $node, string $path): array
    {
        $table = $node->getTable();

        // Memoised: `hasColumn` is a schema query, and a re-parent calls this once per descendant.
        // Per instance rather than static, so a test that rebuilds the schema gets a fresh answer.
        $this->hasDepth[$table] ??= $this->connection->getSchemaBuilder()->hasColumn($table, 'depth');

        return $this->hasDepth[$table]
            ? ['path' => $path, 'depth' => $this->depthOf($path)]
            : ['path' => $path];
    }

    /**
     * Refuse a move that would detach the branch from the tree entirely.
     *
     * A node made a child of itself — or of one of its own descendants — produces a ring with no
     * root. Nothing then reaches it: `ancestryFor` in `PricingService` walks `parent_id` under a
     * 10-step guard and gives up, so every pricelist category rule on that branch silently stops
     * applying, and the categories vanish from any screen that renders the tree from the roots down.
     */
    private function assertMoveIsPossible(Model $node, ?Model $parent): void
    {
        if ($parent === null) {
            return;
        }

        // Not a guard — a *message*. The descendant check below already refuses this, because a
        // node's own path starts with itself; removing this branch changes nothing about what is
        // allowed. It earns its place only by saying "under itself" instead of "under one of its own
        // sub-categories", which is the difference between an operator seeing their mistake and
        // hunting for a sub-category that is not the problem. Sabotage confirmed the redundancy, so
        // the test pins the wording rather than the refusal.
        if ((int) $parent->getKey() === (int) $node->getKey()) {
            throw ValidationException::withMessages([
                'parent_id' => 'A category cannot be filed under itself.',
            ]);
        }

        // Checked against the *stored* path rather than by walking `parent_id`: the path is exactly
        // the ancestry, so a descendant is anything whose path starts with this node's.
        if (str_starts_with((string) $parent->getAttribute('path'), (string) $node->getAttribute('path'))) {
            throw ValidationException::withMessages([
                'parent_id' => 'A category cannot be filed under one of its own sub-categories.',
            ]);
        }
    }

    /**
     * Refuse a nesting deeper than the pricing engine can walk.
     *
     * `self::MAX_DEPTH` is not an arbitrary tidiness limit: `PricingService::ancestryFor` climbs
     * `parent_id` under a hard `$guard++ < 10` and stops. A category nested past that has ancestors
     * the engine never reaches, so a pricelist rule attached to one of those roots silently stops
     * applying to everything in the deep branch — the sale is simply priced differently, and nothing
     * says why. The tree refuses to build what the engine cannot read.
     */
    private function assertDepthIsReadable(?Model $parent): void
    {
        if ($parent === null) {
            return;
        }

        if ($this->depthOf((string) $parent->getAttribute('path')) + 1 >= self::MAX_DEPTH) {
            throw ValidationException::withMessages([
                'parent_id' => 'Categories cannot be nested more than '.self::MAX_DEPTH.' levels deep,'
                    .' because the pricing rules are resolved by walking up from the product and stop'
                    .' at that depth.',
            ]);
        }
    }
}
