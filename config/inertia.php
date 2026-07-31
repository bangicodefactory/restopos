<?php

declare(strict_types=1);

return [

    /*
    |--------------------------------------------------------------------------
    | Server side rendering
    |--------------------------------------------------------------------------
    */
    'ssr' => [
        'enabled' => (bool) env('INERTIA_SSR_ENABLED', false),
        'url' => env('INERTIA_SSR_URL', 'http://127.0.0.1:13714'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Root view
    |--------------------------------------------------------------------------
    | The back-office Blade shell (docs/CONVENTIONS.md § "Fixed entry points").
    */
    'root_view' => 'app',

    'testing' => [
        'ensure_pages_exist' => false,
        'page_paths' => [
            resource_path('js/backoffice/pages'),
        ],
        'page_extensions' => ['tsx', 'jsx'],
    ],
];
