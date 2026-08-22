<?php

declare(strict_types=1);

namespace App\Services\Catalog;

use App\Models\Catalog\PosCategory;
use Illuminate\Database\ConnectionInterface;
use Illuminate\Validation\ValidationException;

/**
 * The POS category tree: where a node sits, and what has to move with it (BOF-084).
 *
 * `pos_categories.path` is a materialised path so a descendant query is a single `LIKE` rather than
 * a recursive walk. Three scopes rely on it — `PosCategory::scopeSubtreeOf`, the self-order
 * visibility scope, and the printer routing lookup — and every one of them matches `path LIKE
 * "{$path}%"`.
 *
 * **It is built from ids, terminated: `/4/9/22/`.** That is what the model has always documented and
 * what the code did not do — `store()` concatenated *names* with no terminator, which fails twice:
 *
 *  - **Prefix collision.** `/Drink` is a prefix of `/Drinks special`, so a subtree query rooted at
 *    "Drink" swept in an unrelated sibling. Probed on master: the subtree of "Drink" returned
 *    `["Drink", "Drinks special", "Beer"]`. On the self-order menu that is a category the venue chose
 *    to hide appearing anyway. The fixtures already worked around this by leading the marker
 *    (BAN-508) rather than fixing it.
 *  - **Rename drift.** A name path has to be rewritten across the whole subtree every time anybody
 *    edits a label. Ids do not change, so only a *move* touches the path.
 *
 * Terminated ids are collision-proof rather than collision-unlikely: `/1/` cannot prefix `/11/`,
 * because the character after `1` is `/` in one and `1` in the other.
 */
final class CategoryTree
{
    /** Deep enough for any real menu; a cycle would otherwise walk forever. */
    private const MAX_DEPTH = 10;

    public function __construct(private readonly ConnectionInterface $connection) {}

    /** The path a node has when it hangs under `$parent`. */
    public function pathFor(?PosCategory $parent, int $id): string
    {
        return ($parent?->path ?? '/').$id.'/';
    }

    /**
     * Give a freshly created node its place in the tree.
     *
     * Separate from `create()` because the path contains the node's own id, which does not exist
     * until the row does.
     */
    public function place(PosCategory $node, ?PosCategory $parent): void
    {
        $node->forceFill([
            'depth' => $parent === null ? 0 : (int) $parent->depth + 1,
            'path' => $this->pathFor($parent, (int) $node->getKey()),
        ])->save();
    }

    /**
     * Move a node under a new parent, taking its subtree with it.
     *
     * Every descendant's `path` and `depth` are rewritten, because a stale path is not a cosmetic
     * problem: the three `LIKE` scopes would place the subtree where it used to be, so a category
     * moved out of the self-order menu would still show, and printer routing would still fire for
     * the old branch.
     */
    public function reparent(PosCategory $node, ?PosCategory $parent): void
    {
        $this->assertMoveIsPossible($node, $parent);

        $this->connection->transaction(function () use ($node, $parent): void {
            $oldPath = (string) $node->path;
            $oldDepth = (int) $node->depth;

            $this->place($node, $parent);

            $newPath = (string) $node->path;
            $shift = (int) $node->depth - $oldDepth;

            if ($newPath === $oldPath && $shift === 0) {
                return;
            }

            // The descendants, found by the path they had *before* the move.
            $descendants = PosCategory::query()
                ->where('path', 'like', $oldPath.'%')
                ->whereKeyNot($node->getKey())
                ->get();

            foreach ($descendants as $descendant) {
                $descendant->forceFill([
                    'path' => $newPath.substr((string) $descendant->path, strlen($oldPath)),
                    'depth' => (int) $descendant->depth + $shift,
                ])->save();
            }
        });
    }

    /**
     * Refuse a move that would detach the branch from the tree entirely.
     *
     * A node made a child of itself — or of one of its own descendants — produces a ring with no
     * root. Nothing then reaches it: `ancestryFor` in `PricingService` walks `parent_id` under a
     * 10-step guard and gives up, so every pricelist category rule on that branch silently stops
     * applying, and the categories vanish from any screen that renders the tree from the roots down.
     */
    private function assertMoveIsPossible(PosCategory $node, ?PosCategory $parent): void
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
        if (str_starts_with((string) $parent->path, (string) $node->path)) {
            throw ValidationException::withMessages([
                'parent_id' => 'A category cannot be filed under one of its own sub-categories.',
            ]);
        }

        if ((int) $parent->depth + 1 >= self::MAX_DEPTH) {
            throw ValidationException::withMessages([
                'parent_id' => 'Categories cannot be nested more than '.self::MAX_DEPTH.' levels deep.',
            ]);
        }
    }
}
