<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\SelfOrderMode;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Http\Controllers\Controller;
use App\Models\Identity\Language;
use App\Models\Identity\MediaFile;
use App\Models\Pos\PaymentMethod;
use App\Models\Pos\PosConfig;
use App\Models\Restaurant\Table as RestaurantTable;
use App\Models\Scopes\CompanyScope;
use App\Models\SelfOrder\CustomLink;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;

/**
 * `SelfOrder/Settings` (spec 02 SLF-001…SLF-019, BOF-070…079).
 *
 * Rotating `access_token` invalidates every printed QR for the venue, so it is a
 * deliberate, separately-confirmed action.
 */
final class SelfOrderSettingsController extends Controller
{
    public function edit(PosConfig $config): Response
    {
        Gate::authorize('view', $config);

        return Inertia::render('SelfOrder/Settings', [
            'config' => [
                'id' => (int) $config->getKey(),
                'uuid' => (string) $config->uuid,
                'name' => (string) $config->name,
                'access_token' => (string) $config->access_token,
                'self_ordering_mode' => $config->self_ordering_mode->value,
                'self_ordering_service_mode' => $config->self_ordering_service_mode->value,
                'self_ordering_pay_after' => $config->self_ordering_pay_after->value,
                'self_ordering_brand_name' => $config->self_ordering_brand_name,
                'self_ordering_primary_color' => $config->self_ordering_primary_color,
                'self_ordering_text_color' => $config->self_ordering_text_color,
                'self_ordering_default_language_id' => $config->self_ordering_default_language_id,
                'self_ordering_brand_media_id' => $config->self_ordering_brand_media_id,
                'self_order_online_payment_method_id' => $config->self_order_online_payment_method_id,
                'kiosk_idle_seconds' => (int) $config->kiosk_idle_seconds,
                'kiosk_confirmation_seconds' => (int) $config->kiosk_confirmation_seconds,
                'custom_link_ids' => $config->selfOrderLinks()->pluck('self_order_custom_links.id')->all(),
            ],
            'modes' => array_map(static fn (SelfOrderMode $m): array => ['value' => $m->value, 'label' => $m->label()], SelfOrderMode::cases()),
            'serviceModes' => array_map(static fn (SelfOrderServiceMode $m): array => ['value' => $m->value, 'label' => $m->label()], SelfOrderServiceMode::cases()),
            'payAfterModes' => array_map(static fn (SelfOrderPayAfter $m): array => ['value' => $m->value, 'label' => $m->label()], SelfOrderPayAfter::cases()),
            'customLinks' => CustomLink::query()->orderBy('sequence')->get(['id', 'name', 'url', 'style', 'open_in_new_tab', 'active'])->all(),
            'paymentMethods' => $config->paymentMethods()->get(['payment_methods.id', 'payment_methods.name', 'payment_methods.method_type'])->all(),
            // Global ISO reference data with no `company_id`, so nothing to scope.
            'languages' => Language::query()->orderBy('name')->get(['id', 'code', 'name'])->all(),
            // The tables this register serves, so per-table QR codes can be generated here.
            //
            // The page's own docblock called their absence a contract gap and worked around it by
            // asking the operator to paste table tokens into a textarea. A table token is the
            // capability that lets a diner order at that table — it is not a thing to be copied by
            // hand from one screen to another, and a transcription slip means a QR stuck to table 6
            // that opens table 9's order.
            'tables' => RestaurantTable::query()
                ->whereIn('restaurant_floor_id', $config->floors()->select('restaurant_floors.id'))
                ->where('active', true)
                ->orderBy('restaurant_floor_id')
                ->orderBy('table_number')
                ->get(['id', 'restaurant_floor_id', 'table_number', 'name', 'identifier'])
                ->map(static fn (RestaurantTable $t): array => [
                    'id' => (int) $t->getKey(),
                    'floor_id' => (int) $t->restaurant_floor_id,
                    'table_number' => (int) $t->table_number,
                    'name' => $t->name,
                    'identifier' => (string) $t->identifier,
                ])->values()->all(),
            'floors' => $config->floors()->get(['restaurant_floors.id', 'restaurant_floors.name'])->all(),
        ]);
    }

    public function update(Request $request, PosConfig $config): RedirectResponse
    {
        Gate::authorize('update', $config);

        $data = $request->validate([
            'self_ordering_mode' => ['sometimes', Rule::enum(SelfOrderMode::class)],
            'self_ordering_service_mode' => ['sometimes', Rule::enum(SelfOrderServiceMode::class)],
            'self_ordering_pay_after' => ['sometimes', Rule::enum(SelfOrderPayAfter::class)],
            'self_ordering_brand_name' => ['sometimes', 'nullable', 'string', 'max:96'],
            'self_ordering_primary_color' => ['sometimes', 'nullable', 'string', 'max:9'],
            'self_ordering_text_color' => ['sometimes', 'nullable', 'string', 'max:9'],
            // Rendered on this page since it was written and absent from this rule set, so the
            // one control a venue most needs — the language its customers are greeted in — flipped,
            // saved "successfully" and came back unchanged.
            'self_ordering_default_language_id' => ['sometimes', 'nullable', 'integer', Rule::exists('languages', 'id')],
            // Buildable since BAN-393 gave the app an upload pipeline.
            'self_ordering_brand_media_id' => ['sometimes', 'nullable', 'integer', $this->ownedMedia()],
            // Took a raw id with no ownership check at all. The kiosk's online payment method
            // decides where a customer's money goes; another venue's method here is not a display
            // bug.
            'self_order_online_payment_method_id' => ['sometimes', 'nullable', 'integer', $this->ownedPaymentMethod($config)],
            'kiosk_idle_seconds' => ['sometimes', 'integer', 'min:10', 'max:600'],
            'kiosk_confirmation_seconds' => ['sometimes', 'integer', 'min:5', 'max:300'],
            'custom_link_ids' => ['sometimes', 'array'],
            'custom_link_ids.*' => ['integer'],
        ]);

        if (array_key_exists('custom_link_ids', $data)) {
            // Resolved through the scoped model, never synced straight from the request. `sync()`
            // writes whatever ids it is handed, and these links render on the venue's own kiosk —
            // another company's link attached here is their text and their URL shown to this
            // venue's customers. Same hole `ownedIds()` closed on the register settings (XCT-101).
            //
            // Refused rather than filtered: silently dropping an id means the operator ticks a box,
            // the save succeeds, and the link is simply not there.
            $wanted = array_values(array_unique(array_map(intval(...), (array) $data['custom_link_ids'])));
            $owned = $wanted === [] ? [] : CustomLink::query()->whereKey($wanted)->pluck('id')->all();

            if (count($owned) !== count($wanted)) {
                throw ValidationException::withMessages([
                    'custom_link_ids' => 'One of those links belongs to another venue, or no longer exists.',
                ]);
            }

            $config->selfOrderLinks()->sync($owned);
            unset($data['custom_link_ids']);
        }

        $config->forceFill($data)->save();
        $config->bumpRevision();

        return back()->with('success', 'Self-order settings saved.');
    }

    /**
     * A payment method of this register's own company.
     *
     * Resolved through the scoped model rather than `Rule::exists`, because `Rule::exists` runs on
     * the query builder — the one place `CompanyScope` cannot reach (see `ScopedExistsTest`).
     */
    private function ownedPaymentMethod(PosConfig $config): callable
    {
        return static function (string $attribute, mixed $value, callable $fail) use ($config): void {
            if ($value === null) {
                return;
            }

            $exists = PaymentMethod::query()
                ->where('company_id', $config->company_id)
                ->whereKey((int) $value)
                ->exists();

            if (! $exists) {
                $fail('That payment method belongs to another venue, or no longer exists.');
            }
        };
    }

    /** Ours, or a genuinely shared asset (`company_id IS NULL`). */
    private function ownedMedia(): callable
    {
        return static function (string $attribute, mixed $value, callable $fail): void {
            if ($value === null) {
                return;
            }

            $ours = MediaFile::query()->whereKey((int) $value)->exists()
                || MediaFile::query()
                    ->withoutGlobalScope(CompanyScope::class)
                    ->whereKey((int) $value)
                    ->whereNull('company_id')
                    ->exists();

            if (! $ours) {
                $fail('That image belongs to another venue, or no longer exists.');
            }
        };
    }

    /** Rotating the token invalidates every printed QR code for this venue. */
    public function rotateToken(PosConfig $config): RedirectResponse
    {
        // Rotating the token invalidates every printed table QR for this venue.
        Gate::authorize('update', $config);

        $config->forceFill(['access_token' => PosConfig::newAccessToken()])->save();
        $config->bumpRevision();

        return back()->with('success', 'Self-order token rotated. All printed QR codes must be reprinted.');
    }
}
