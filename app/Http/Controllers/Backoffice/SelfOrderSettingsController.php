<?php

declare(strict_types=1);

namespace App\Http\Controllers\Backoffice;

use App\Enums\SelfOrderMode;
use App\Enums\SelfOrderPayAfter;
use App\Enums\SelfOrderServiceMode;
use App\Http\Controllers\Controller;
use App\Models\Pos\PosConfig;
use App\Models\SelfOrder\CustomLink;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\Rule;
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
            'self_order_online_payment_method_id' => ['sometimes', 'nullable', 'integer'],
            'kiosk_idle_seconds' => ['sometimes', 'integer', 'min:10', 'max:600'],
            'kiosk_confirmation_seconds' => ['sometimes', 'integer', 'min:5', 'max:300'],
            'custom_link_ids' => ['sometimes', 'array'],
        ]);

        if (array_key_exists('custom_link_ids', $data)) {
            $config->selfOrderLinks()->sync(array_map(intval(...), (array) $data['custom_link_ids']));
            unset($data['custom_link_ids']);
        }

        $config->forceFill($data)->save();
        $config->bumpRevision();

        return back()->with('success', 'Self-order settings saved.');
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
