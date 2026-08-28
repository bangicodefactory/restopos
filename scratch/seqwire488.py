import io

BS = chr(92)

# ── the rule ────────────────────────────────────────────────────────────────
p = 'app/Http/Requests/Backoffice/PosConfigRequest.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = "            // ── barcodes (BOF-043, BAN-488) ─────────────────────────────────────────────────"
new = """            // ── numbering (BOF-045, BAN-488) ────────────────────────────────────────────────
            //
            // Letters and digits only, because it is glued straight onto a document number with a
            // slash: a prefix carrying one would produce `T1/2/00412`, which reads as two fields and
            // is what an accountant would have to unpick. Null restores the derived behaviour, and
            // `''` is normalised to null by `prepareForValidation` so clearing the box means
            // "derive it" rather than "prefix everything with nothing".
            'sequence_prefix' => ['sometimes', 'nullable', 'string', 'max:8', 'regex:/^[A-Za-z0-9]+$/'],

            // ── barcodes (BOF-043, BAN-488) ─────────────────────────────────────────────────"""
assert old in s, 'barcode section anchor'
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)

# ── the payload: what the numbering group shows ────────────────────────────
p = 'app/Http/Controllers/Backoffice/PosConfigController.php'
s = io.open(p, encoding='utf-8', newline='').read()

old = """                'bills' => PosBill::query()->orderBy('currency_id')->orderBy('sequence')
                    ->get(['id', 'name', 'value', 'currency_id'])->all(),
            ]),"""
new = """                'bills' => PosBill::query()->orderBy('currency_id')->orderBy('sequence')
                    ->get(['id', 'name', 'value', 'currency_id'])->all(),
                /*
                 * The numbers this register has already issued (BOF-045, BAN-488).
                 *
                 * Read-only, and that is the point rather than a limitation: these are legally
                 * sequential document numbers allocated under a row lock, and a settings screen that
                 * could set `next_value` would let someone reissue a receipt number that has already
                 * been given to a customer. Showing them answers the question an audit actually asks
                 * — "what number comes next, and where did this one come from" — without offering a
                 * way to make the answer wrong.
                 */
                'sequences' => Sequence::query()
                    ->where('pos_config_id', $config->getKey())
                    ->orderBy('purpose')
                    ->orderBy('period_key')
                    ->get(['id', 'purpose', 'period_key', 'prefix', 'padding', 'next_value'])
                    ->map(static fn (Sequence $s): array => [
                        'id' => (int) $s->getKey(),
                        'purpose' => (string) $s->purpose,
                        'period_key' => $s->period_key,
                        'prefix' => $s->prefix,
                        'padding' => (int) $s->padding,
                        'next_value' => (int) $s->next_value,
                    ])->values()->all(),
            ]),"""
assert old in s, 'options tail'
s = s.replace(old, new, 1)

imp = 'use App' + BS + 'Models' + BS + 'Pos' + BS + 'Sequence;'
if imp not in s:
    i = s.index('use App' + BS + 'Models' + BS + 'Pos' + BS)
    s = s[:i] + imp + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('wired')
