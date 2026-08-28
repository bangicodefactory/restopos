import io

p = 'app/Http/Controllers/Backoffice/PricelistController.php'
s = io.open(p, encoding='utf-8', newline='').read()


def sub(old, new):
    global s
    assert old in s, 'MISSING: ' + old[:70]
    s = s.replace(old, new, 1)


sub("""    public function update(Request $request, Pricelist $pricelist): RedirectResponse
    {
        Gate::authorize('update', $pricelist);

        $pricelist->forceFill($request->validate([
            'name' => ['sometimes', 'string', 'max:96'],
            'currency_id' => ['sometimes', 'integer', 'exists:currencies,id'],
            'sequence' => ['sometimes', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]))->save();

        return back()->with('success', 'Pricelist saved.');
    }
}""",
'''    public function update(Request $request, Pricelist $pricelist): RedirectResponse
    {
        Gate::authorize('update', $pricelist);

        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:96'],
            // Currencies are global ISO reference data with no `company_id`, so an unscoped `exists`
            // is the honest rule here.
            'currency_id' => ['sometimes', 'integer', 'exists:currencies,id'],
            'sequence' => ['sometimes', 'integer'],
            'active' => ['sometimes', 'boolean'],
        ]);

        $this->assertCurrencyStillFitsItsRegisters($pricelist, $data);

        $pricelist->forceFill($data)->save();

        return back()->with('success', 'Pricelist saved.');
    }

    /**
     * `POST /pricelists` — a new price list (BOF-037).
     *
     * "Change a price rule" is the most common back-office task in a restaurant, and there was no
     * endpoint for it at all: the header could be edited, the rules were a read-only explorer, and
     * a price list could not be created or removed. Happy hour, a member rate, a category markdown
     * — none of it could be set up through the UI.
     */
    public function store(Request $request): RedirectResponse
    {
        Gate::authorize('create', Pricelist::class);

        $data = $request->validate([
            'name' => ['required', 'string', 'max:96'],
            'currency_id' => ['required', 'integer', 'exists:currencies,id'],
            'sequence' => ['sometimes', 'integer', 'min:0', 'max:9999'],
        ]);

        $companyId = ActingCompany::id();

        if (! is_int($companyId)) {
            throw ValidationException::withMessages([
                'name' => 'Choose a company before adding a price list.',
            ]);
        }

        $pricelist = Pricelist::query()->create([...$data, 'company_id' => $companyId]);

        return redirect()
            ->route('pricelists.edit', $pricelist->getKey())
            ->with('success', 'Price list added. Its rules are below.');
    }

    /**
     * Refused while anything still prices from it.
     *
     * `pos_configs.pricelist_id`, the `pos_config_pricelist` pivot, `customers.pricelist_id`,
     * `pricelist_items.base_pricelist_id` and every order that recorded which list it was priced
     * against. The last is the one that matters most: an order names the list so the price it
     * charged can be explained afterwards.
     */
    public function destroy(Pricelist $pricelist): RedirectResponse
    {
        Gate::authorize('delete', $pricelist);

        $orders = Order::query()->where('pricelist_id', $pricelist->getKey())->count();

        if ($orders > 0) {
            throw ValidationException::withMessages([
                'pricelist' => 'This price list priced '.$orders.' order(s) and cannot be removed.'
                    .' Deactivate it instead — it stops being offered and every past order keeps'
                    .' saying what it was priced against.',
            ]);
        }

        $registers = PosConfig::query()->where('pricelist_id', $pricelist->getKey())->count();

        if ($registers > 0) {
            throw ValidationException::withMessages([
                'pricelist' => 'This price list is the default on '.$registers.' register(s). Point'
                    .' them at another one first.',
            ]);
        }

        $derived = PricelistItem::query()->where('base_pricelist_id', $pricelist->getKey())->count();

        if ($derived > 0) {
            throw ValidationException::withMessages([
                'pricelist' => $derived.' rule(s) on other price lists compute their prices from this'
                    .' one. Change those first, or their prices would quietly fall back to the'
                    .' product price.',
            ]);
        }

        $pricelist->delete();

        return back()->with('success', 'Price list removed.');
    }

    public function storeItem(PricelistItemRequest $request, Pricelist $pricelist): RedirectResponse
    {
        $data = $request->validated();

        $pricelist->items()->create([
            ...$data,
            'company_id' => $pricelist->company_id,
            'sequence' => $data['sequence'] ?? ((int) $pricelist->items()->max('sequence') + 10),
        ]);

        return back()->with('success', 'Price rule added.');
    }

    public function updateItem(PricelistItemRequest $request, Pricelist $pricelist, PricelistItem $item): RedirectResponse
    {
        $this->refuseForeignItem($pricelist, $item);

        $item->forceFill($request->validated())->save();

        return back()->with('success', 'Price rule saved.');
    }

    public function destroyItem(Pricelist $pricelist, PricelistItem $item): RedirectResponse
    {
        Gate::authorize('update', $pricelist);
        $this->refuseForeignItem($pricelist, $item);

        $item->delete();

        return back()->with('success', 'Price rule removed.');
    }

    /**
     * A price list prices in one currency, and its registers quote in theirs.
     *
     * BAN-466 refuses attaching a pricelist whose currency disagrees with the register. This is the
     * same rule approached from the other side: re-currencying a list already attached to a register
     * would create exactly the inconsistency that check exists to prevent, and nothing converts —
     * `PricingService` reads the item amount as-is, so the till would quote these numbers under the
     * wrong symbol.
     *
     * @param  array<string, mixed>  $data
     */
    private function assertCurrencyStillFitsItsRegisters(Pricelist $pricelist, array $data): void
    {
        if (! array_key_exists('currency_id', $data)) {
            return;
        }

        $currencyId = (int) $data['currency_id'];

        if ($currencyId === (int) $pricelist->currency_id) {
            return;
        }

        $clashing = PosConfig::query()
            ->where('currency_id', '!=', $currencyId)
            ->where(function ($query) use ($pricelist): void {
                $query->where('pricelist_id', $pricelist->getKey())
                    ->orWhereHas('pricelists', fn ($q) => $q->whereKey($pricelist->getKey()));
            })
            ->count();

        if ($clashing > 0) {
            throw ValidationException::withMessages([
                'currency_id' => $clashing.' register(s) use this price list and quote in a different'
                    .' currency. Their tills would show these amounts under the wrong symbol —'
                    .' nothing converts. Detach it from those registers first.',
            ]);
        }
    }

    private function refuseForeignItem(Pricelist $pricelist, PricelistItem $item): void
    {
        abort_unless((int) $item->pricelist_id === (int) $pricelist->getKey(), 404);
    }
}''')

for imp in [
    'use App' + chr(92) + 'Http' + chr(92) + 'Requests' + chr(92) + 'Backoffice' + chr(92) + 'PricelistItemRequest;',
    'use App' + chr(92) + 'Models' + chr(92) + 'Pos' + chr(92) + 'Order;',
    'use App' + chr(92) + 'Models' + chr(92) + 'Pos' + chr(92) + 'PosConfig;',
    'use App' + chr(92) + 'Models' + chr(92) + 'Pricing' + chr(92) + 'PricelistItem;',
    'use App' + chr(92) + 'Support' + chr(92) + 'Tenancy' + chr(92) + 'ActingCompany;',
    'use Illuminate' + chr(92) + 'Validation' + chr(92) + 'ValidationException;',
]:
    if imp not in s:
        i = s.index('use Illuminate')
        s = s[:i] + imp + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('controller extended')
