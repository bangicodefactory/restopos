<?php

declare(strict_types=1);

namespace App\Services\SelfOrder;

use App\Models\Pos\PosConfig;

/**
 * The resolved principal of a public self-order request (spec 03 §2.4).
 *
 * Deliberately **not** an impersonated user: an anonymous public endpoint that
 * runs as a real account is a standing privilege-escalation hazard. This value
 * object carries exactly the two capabilities the bearer proved — a config token
 * and, optionally, a table token — and nothing else.
 */
final readonly class SelfOrderContext
{
    /**
     * @param  object|null  $table  \App\Models\Restaurant\Table when a table token was presented
     */
    public function __construct(
        public PosConfig $config,
        public ?object $table = null,
        public ?string $orderAccessToken = null,
    ) {}

    public function tableId(): ?int
    {
        $id = $this->table?->getKey();

        return $id === null ? null : (int) $id;
    }

    public function withOrderToken(?string $token): self
    {
        return new self($this->config, $this->table, $token);
    }
}
