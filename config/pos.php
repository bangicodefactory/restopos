<?php

declare(strict_types=1);

use App\Enums\EmployeeRole;

/**
 * RestoPOS runtime configuration (docs/spec/03-architecture.md §2.5, §3, §6).
 *
 * Everything here is overridable per install through the environment; the
 * per-config overrides live on `pos_configs` and win over these defaults.
 */
return [

    /*
    |--------------------------------------------------------------------------
    | API surface
    |--------------------------------------------------------------------------
    */
    'api' => [
        'version' => 'v1',
        // Clients older than this refuse to open a session (spec §1.3).
        'min_client_version' => env('POS_MIN_CLIENT_VERSION', '1.0.0'),
        // Bumped whenever the client-visible model shape breaks.
        'schema_version' => 1,
    ],

    /*
    |--------------------------------------------------------------------------
    | Device pairing (spec §2.2)
    |--------------------------------------------------------------------------
    */
    'pairing' => [
        'code_length' => 8,
        'ttl_seconds' => (int) env('POS_PAIRING_TTL', 600),
        'alphabet' => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
        'cache_prefix' => 'pos:pairing:',
    ],

    /*
    |--------------------------------------------------------------------------
    | Device token abilities, per device kind (spec §2.2)
    |--------------------------------------------------------------------------
    */
    'abilities' => [
        'register' => ['pos:sync', 'pos:session', 'pos:catalog', 'pos:print', 'pos:realtime', 'pos:restaurant'],
        'prep_display' => ['pos:catalog', 'pos:kitchen', 'pos:realtime'],
        'kiosk' => ['pos:catalog', 'pos:selforder', 'pos:realtime', 'pos:print'],
        'customer_display' => ['pos:realtime'],
        'self_mobile' => ['pos:catalog', 'pos:selforder'],
    ],

    /*
    |--------------------------------------------------------------------------
    | Register employee abilities per role (spec §2.5, axis 2)
    |--------------------------------------------------------------------------
    | The bootstrap payload ships the *resolved* list per employee so the client
    | never re-derives it. `pos_configs.role_abilities` may override per config.
    */
    'role_abilities' => [
        EmployeeRole::Minimal->value => [
            'order.create',
            'order.line.add',
            'receipt.print',
        ],
        EmployeeRole::Cashier->value => [
            'order.create',
            'order.line.add',
            'order.delete_draft',
            'line.discount',
            'refund.create',
            'cash.in_out',
            'session.open',
            'session.close',
            'receipt.print',
            'receipt.reprint',
            'table.transfer',
            'table.merge',
            'course.fire',
            'bill.split',
            'kitchen.send',
        ],
        EmployeeRole::Manager->value => [
            'order.create',
            'order.line.add',
            'order.delete_draft',
            'order.void_paid',
            'line.discount',
            'line.discount.above_limit',
            'line.price_override',
            'refund.create',
            'cash.in_out',
            'cash.in_out.delete',
            'cash.drawer.no_sale',
            'session.open',
            'session.close',
            'session.close.over_variance',
            'session.rescue.close',
            'report.margins',
            'receipt.print',
            'receipt.reprint',
            'table.transfer',
            'table.merge',
            'table.unmerge',
            'course.fire',
            'bill.split',
            'kitchen.send',
            'kitchen.recall',
            'config.manage',
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Bootstrap / delta (spec §3.2)
    |--------------------------------------------------------------------------
    */
    'bootstrap' => [
        'product_page_size' => (int) env('POS_PRODUCT_PAGE_SIZE', 1000),
        'customer_page_size' => (int) env('POS_CUSTOMER_PAGE_SIZE', 100),
        'search_page_size' => 50,
        // Subtracted from `server_time` before it becomes the next `since`
        // watermark, to absorb same-millisecond writes (spec §3.2.4).
        'watermark_safety_seconds' => 1,
        'delta_max_per_model' => 500,
    ],

    /*
    |--------------------------------------------------------------------------
    | Push sync (spec §3.6)
    |--------------------------------------------------------------------------
    */
    'sync' => [
        'max_orders_per_batch' => 200,
        // A |client - server| gap strictly greater than this is reported as a
        // `client_total_mismatch` warning. It is never fatal.
        'amount_mismatch_tolerance' => '0.00',
        'request_log_retention_days' => 30,
        // Discount above this percentage requires `line.discount.above_limit`.
        'discount_limit_percent' => (float) env('POS_DISCOUNT_LIMIT', 30),
    ],

    /*
    |--------------------------------------------------------------------------
    | Sessions & cash (spec 02 REG-001…039)
    |--------------------------------------------------------------------------
    */
    'session' => [
        // Closing variance strictly above this needs `session.close.over_variance`
        // unless the config sets its own `amount_authorized_diff`.
        'default_authorized_difference' => (float) env('POS_AUTHORIZED_DIFF', 0),
        'rescue_name_prefix' => 'RESCUE',
    ],

    /*
    |--------------------------------------------------------------------------
    | Sequences & references (spec §6)
    |--------------------------------------------------------------------------
    */
    'sequence' => [
        'order_name_padding' => 5,
        'receipt_token_alphabet' => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ',
        'receipt_token_length' => 5,
    ],

    /*
    |--------------------------------------------------------------------------
    | Kitchen
    |--------------------------------------------------------------------------
    */
    'kitchen' => [
        'characters_per_line' => 42,
        'print_job_max_attempts' => 5,
        'done_retention_minutes' => 60,
    ],

    /*
    |--------------------------------------------------------------------------
    | Self-order
    |--------------------------------------------------------------------------
    */
    'self_order' => [
        'throttle' => env('POS_SELFORDER_THROTTLE', '60,1'),
        'payment_provider' => env('POS_PAYMENT_PROVIDER', 'null'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Realtime channel names (spec §5.2)
    |--------------------------------------------------------------------------
    */
    'channels' => [
        'config' => 'pos.config.{token}',
        'session' => 'pos.session.{id}',
        'device' => 'pos.device.{uuid}',
        'display' => 'kitchen.display.{token}',
        'table' => 'pos.table.{id}',
        'self' => 'pos.self.{token}',
        'order' => 'pos.order.{token}',
    ],
];
