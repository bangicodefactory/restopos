<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use Illuminate\Contracts\View\View;

/**
 * The four PWA shells (docs/CONVENTIONS.md § "Fixed entry points").
 *
 * These views are **propless** on purpose: every byte is identical for every
 * device and every tenant, which is what makes the document precacheable by a
 * service worker. All state comes from IndexedDB and the bootstrap API — if the
 * first paint depended on a fetch, the offline story would be a lie.
 */
final class ShellController extends Controller
{
    public function register(): View
    {
        return view('register');
    }

    public function kitchen(): View
    {
        return view('kitchen');
    }

    public function selfOrder(): View
    {
        return view('selforder');
    }

    public function customerDisplay(): View
    {
        return view('customer_display');
    }
}
