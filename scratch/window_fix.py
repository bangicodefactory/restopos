import io

p = 'app/Services/Pos/PricingService.php'
s = io.open(p, encoding='utf-8', newline='').read()


def sub(old, new):
    global s
    assert old in s, 'MISSING: ' + old[:80]
    s = s.replace(old, new, 1)


sub("""                dateStart: $row->date_start === null ? null : (string) $row->date_start,
                dateEnd: $row->date_end === null ? null : (string) $row->date_end,""",
"""                dateStart: self::moment($row->date_start),
                dateEnd: self::moment($row->date_end),""")

sub("""            standardPrice: (string) ($variant->variant_cost ?: $variant->product_cost),
            priceExtra: (string) $variant->price_extra,
        );""",
"""            standardPrice: (string) ($variant->variant_cost ?: $variant->product_cost),
            priceExtra: (string) $variant->price_extra,
            // Without this, `PricelistResolver` skips its window check entirely (it is guarded on a
            // non-null date) and **every dated rule applied forever on the server**: last winter's
            // happy hour still discounting in August. The register passes `date: nowIso()`, so the
            // two disagreed — and on sync the server price wins (`OrderSyncService`), which means the
            // till charged full price, printed full price, and the order was recorded discounted.
            date: self::moment(now()),
        );""")

sub("""    private function resolver(PosConfig $config): PricelistResolver""",
"""    /**
     * One comparable spelling of an instant.
     *
     * The window comparison in `PricelistResolver` is a **string** comparison, and the two ends
     * arrived spelled differently: the rows come off the query builder as `2026-08-28 18:00:00`
     * while a Carbon instance stringifies with a `T`. `' ' < 'T'`, so a rule opening at 18:00 today
     * would have compared as already open at 04:00 — right for a different year, wrong within a day,
     * which is exactly the granularity happy hour uses.
     */
    private static function moment(mixed $value): ?string
    {
        return $value === null ? null : Carbon::parse((string) $value)->format('Y-m-d H:i:s');
    }

    private function resolver(PosConfig $config): PricelistResolver""")

if 'use Illuminate\Support\Carbon;' not in s:
    i = s.index('use Illuminate')
    s = s[:i] + 'use Illuminate' + chr(92) + 'Support' + chr(92) + 'Carbon;' + chr(10) + s[i:]

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('window wired')
