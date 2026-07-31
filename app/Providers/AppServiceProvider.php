<?php

declare(strict_types=1);

namespace App\Providers;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Vite;
use Illuminate\Support\ServiceProvider;

final class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        // Money is decimal(16,4) in the DB and a decimal *string* on the wire;
        // an implicit float cast anywhere in the ORM would silently break that
        // contract (docs/CONVENTIONS.md § Naming).
        Model::preventLazyLoading($this->app->isLocal());
        Model::preventSilentlyDiscardingAttributes($this->app->isLocal());

        Vite::prefetch(concurrency: 3);
    }
}
