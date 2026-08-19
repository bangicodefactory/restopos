<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\NoteScope;
use App\Http\Controllers\Controller;
use App\Models\Pos\PosNote;
use App\Support\Tenancy\ActingCompany;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Predefined kitchen notes (BOF-112, BAN-483).
 *
 * The notes a waiter picks from rather than types: "no ice", "allergy — nuts", "well done". They had
 * a table and a model and no way to author them, so the list was the seeder's and a venue could not
 * add the one note its kitchen actually needs.
 *
 * The register already loads them and the ticket screen already prints them (BAN-485); this is the
 * surface that fills the table.
 *
 * `note_scope` decides where a note can be attached — to a **line** ("no ice" belongs to the drink)
 * or to the whole **order** ("table is in a hurry"). Getting that wrong puts a note on the wrong part
 * of the kitchen ticket, so it is an enum rather than a free string.
 */
final class PosNoteController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('PosNotes/Index', [
            'notes' => PosNote::query()
                ->orderBy('sequence')
                ->get(['id', 'name', 'color', 'note_scope', 'sequence', 'active'])
                ->map(static fn (PosNote $note): array => [
                    'id' => (int) $note->getKey(),
                    'name' => (string) $note->name,
                    'color' => (int) $note->color,
                    'note_scope' => (string) ($note->note_scope?->value ?? $note->note_scope),
                    'sequence' => (int) $note->sequence,
                    'active' => (bool) $note->active,
                ])->values()->all(),
        ]);
    }

    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', PosNote::class);

        $data = $this->validated($request, creating: true);
        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages(['name' => 'Choose a company before adding a note.']);
        }

        PosNote::query()->create([
            ...$data,
            'company_id' => $companyId,
            'sequence' => $data['sequence'] ?? ((int) PosNote::query()->max('sequence') + 1),
        ]);

        return back()->with('success', 'Note added.');
    }

    public function update(Request $request, PosNote $posNote): RedirectResponse
    {
        Gate::authorize('update', $posNote);

        $posNote->forceFill($this->validated($request, creating: false))->save();

        return back()->with('success', 'Note saved.');
    }

    /**
     * Removing a note takes it off the picker and leaves every note already written on an order
     * alone: the text is copied onto the line when it is chosen, not referenced. Deleting "no ice"
     * does not rewrite the history of every drink that went out without ice.
     */
    public function destroy(Request $request, PosNote $posNote): RedirectResponse
    {
        Gate::authorize('delete', $posNote);

        $posNote->delete();

        return back()->with('success', 'Note removed.');
    }

    /** @return array<string, mixed> */
    private function validated(Request $request, bool $creating): array
    {
        $required = $creating ? 'required' : 'sometimes';

        return $request->validate([
            // Unique per company, which the table enforces too. Two notes reading "no ice" in one
            // picker is a picker nobody trusts.
            'name' => [
                $required,
                'string',
                'max:64',
                Rule::unique('pos_notes', 'name')
                    ->where('company_id', ActingCompany::id())
                    ->ignore($request->route('posNote')?->getKey()),
            ],
            'note_scope' => [$required, Rule::enum(NoteScope::class)],
            'color' => ['sometimes', 'integer', 'min:0', 'max:255'],
            'sequence' => ['sometimes', 'nullable', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]);
    }
}
