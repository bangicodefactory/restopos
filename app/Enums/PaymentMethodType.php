<?php

declare(strict_types=1);

namespace App\Enums;

use App\Enums\Concerns\HasEnumHelpers;

/**
 * Kind of tender behind a `payment_methods` row (spec §4.5).
 */
enum PaymentMethodType: string
{
    use HasEnumHelpers;

    case Cash = 'cash';
    case Bank = 'bank';
    case CardTerminal = 'card_terminal';
    case QrCode = 'qr_code';
    case Online = 'online';
    case CustomerAccount = 'customer_account';
    case Voucher = 'voucher';

    public function label(): string
    {
        return match ($this) {
            self::Cash => 'Cash',
            self::Bank => 'Bank / manual card',
            self::CardTerminal => 'Payment terminal',
            self::QrCode => 'QR code',
            self::Online => 'Online payment',
            self::CustomerAccount => 'Customer account',
            self::Voucher => 'Gift card / eWallet',
        };
    }

    /** Counted in the physical drawer at closing. */
    public function isCounted(): bool
    {
        return $this === self::Cash;
    }

    public function allowsChange(): bool
    {
        return $this === self::Cash;
    }

    /** Forces a customer on the order (AR-style tender). */
    public function requiresCustomer(): bool
    {
        return $this === self::CustomerAccount;
    }

    public function isElectronic(): bool
    {
        return match ($this) {
            self::CardTerminal, self::QrCode, self::Online => true,
            default => false,
        };
    }
}

// scratch: verifying the docs gate fires in CI
